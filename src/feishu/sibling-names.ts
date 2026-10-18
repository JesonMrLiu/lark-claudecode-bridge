// 兄弟应用桥：open_id 是应用维度标识，本应用「通讯录权限范围」外的用户（接入申请场景的
// 常态——申请人天然未被纳入范围）用 contact/v3 直查只会拿到空 items 或 41050。而消息事件
// 自带的 sender_id.union_id 在同一开发商的全部应用间通用（同租户自建应用实测 2026-10-18：
// 主应用查不到的用户，分身应用按 union_id 能查到真名）。
// 本桥按已知 openId→unionId 映射，遍历兄弟应用的注册请求口（gateway-registry）批量查询，
// 命中即返回；真名由调用方写入共享磁盘缓存（name-cache，key=本应用 openId），一次解析全场景受益。
// 无兄弟运行 / 兄弟也无权限或范围不含 → 返回空 Map，调用方按原样降级 ou 尾号展示。
import { listChatInfoSources, type FeishuRequester } from '../gateway/gateway-registry.js';

export async function resolveNamesByUnionViaSiblings(
  selfAppId: string,
  unionByOpenId: Map<string, string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // 同一 union 可能对应多个 openId 请求（理论上同应用同一人只有一个，稳妥去重）
  const byUnion = new Map<string, string[]>();
  for (const [openId, unionId] of unionByOpenId) {
    if (!unionId) continue;
    byUnion.set(unionId, [...(byUnion.get(unionId) ?? []), openId]);
  }
  if (!byUnion.size) return out;
  const siblings: FeishuRequester[] = listChatInfoSources()
    .filter(([appId]) => appId !== selfAppId)
    .map(([, req]) => req);
  const pending = new Set(byUnion.keys());
  for (const req of siblings) {
    if (!pending.size) break;
    const qs = [...pending].map((u) => `user_ids=${encodeURIComponent(u)}`).join('&');
    let items: unknown;
    try {
      const res = await req.request({
        method: 'GET',
        url: `/open-apis/contact/v3/users/batch?user_id_type=union_id&${qs}`,
      });
      if (res.code !== 0) {
        console.log(`[真名桥] ${selfAppId} 兄弟应用返回 code=${res.code}（缺权限/范围外），换下一个继续`);
        continue;
      }
      items = (res.data as { items?: unknown } | undefined)?.items;
    } catch (e) {
      console.log(`[真名桥] ${selfAppId} 兄弟应用请求异常：${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const it of items as Array<{ union_id?: unknown; name?: unknown }>) {
      if (typeof it.union_id === 'string' && byUnion.has(it.union_id)
        && typeof it.name === 'string' && it.name) {
        for (const openId of byUnion.get(it.union_id)!) out.set(openId, it.name);
        pending.delete(it.union_id);
      }
    }
  }
  if (out.size) {
    console.log(`[真名桥] ${selfAppId} 命中 ${out.size}/${byUnion.size} 个真名：${[...out.entries()].map(([id, n]) => `${id.slice(0, 12)}…→${n}`).join('，')}`);
  } else {
    console.log(`[真名桥] ${selfAppId} 未命中（${byUnion.size} 个 union × ${siblings.length} 个兄弟应用均无结果）`);
  }
  return out;
}
