// lcb app add/remove/list 的核心逻辑：对已有 config.yaml 做增量改写（保注释），模式复刻 ws-manager。
// 纯逻辑，写盘由调用方（bin）负责，tests/app-manager.test.ts 直接单测。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';

export type AppResult = { ok: true; yaml: string } | { ok: false; error: string };

export interface AppInput {
  name?: string;
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
}

function appsSeq(raw: string): YAMLSeq<YAMLMap> | undefined {
  const doc = parseDocument(raw);
  return doc.get('apps') as YAMLSeq<YAMLMap> | undefined;
}

/**
 * 添加应用。配置为旧 feishu 单应用格式时先原地转 apps 数组（首次 app 操作即完成格式升级）：
 * 旧 app 显式写 claude_config_dir=~/.claude——物理转成 apps 格式后 loadConfig 会按新规则
 * 推导独立目录，不显式钉住系统默认目录会丢存量会话的 resume 链。
 */
export function addApp(raw: string, input: AppInput): AppResult {
  const appId = input.appId.trim();
  const appSecret = input.appSecret.trim();
  if (!appId) return { ok: false, error: 'app_id 不能为空' };
  if (!appSecret) return { ok: false, error: 'app_secret 不能为空' };
  const doc = parseDocument(raw);
  if (!doc.has('apps')) {
    const feishu = doc.get('feishu') as YAMLMap | undefined;
    if (feishu && typeof feishu === 'object') {
      const oldAppId = String(feishu.get('app_id') ?? '');
      const oldSecret = String(feishu.get('app_secret') ?? '');
      const oldDomain = feishu.get('domain');
      if (!oldAppId || !oldSecret) return { ok: false, error: '旧 feishu 配置缺少 app_id/app_secret，请先运行 lcb setup 重建' };
      // doc.createNode 把 plain 对象转成 YAML 节点（set plain 值后 get 拿不到 Node，无法继续 items 操作）
      doc.set('apps', doc.createNode([{
        app_id: oldAppId,
        app_secret: oldSecret,
        ...(oldDomain ? { domain: String(oldDomain) } : {}),
        // 存量会话在系统默认目录，显式钉住防止归一化按新 app 规则推导独立目录
        claude_config_dir: join(homedir(), '.claude'),
      }]));
      doc.delete('feishu');
    } else {
      return { ok: false, error: '配置缺少 apps（或旧版 feishu），请先运行 lcb setup' };
    }
  }
  const seq = doc.get('apps') as YAMLSeq<YAMLMap>;
  const dup = seq.items.some((m) => String(m.get('app_id')) === appId);
  if (dup) return { ok: false, error: `app_id "${appId}" 重复：同一应用建两条长连接会导致事件错乱` };
  const name = input.name?.trim();
  doc.addIn(['apps'], {
    ...(name ? { name } : {}), // 不写 name：loadConfig 归一化时缺省取 appId
    app_id: appId,
    app_secret: appSecret,
    ...(input.domain === 'lark' ? { domain: 'lark' } : {}),
  });
  return { ok: true, yaml: doc.toString() };
}

/** 删除应用（按 name 或 app_id 匹配）；最后一个不可删；遗留的会话分片与落盘目录不动（人工清理） */
export function removeApp(raw: string, nameOrAppId: string): AppResult {
  const doc = parseDocument(raw);
  const seq = doc.get('apps') as YAMLSeq<YAMLMap> | undefined;
  if (!seq) {
    const feishu = doc.get('feishu');
    return {
      ok: false,
      error: feishu ? '当前为旧 feishu 单应用配置（唯一应用不可删）；如需更换请重跑 lcb setup' : '配置缺少 apps，请先运行 lcb setup',
    };
  }
  const idx = seq.items.findIndex((m) => String(m.get('name')) === nameOrAppId || String(m.get('app_id')) === nameOrAppId);
  if (idx < 0) return { ok: false, error: `应用 "${nameOrAppId}" 不存在，lcb app list 查看` };
  if (seq.items.length === 1) return { ok: false, error: '不能删除最后一个应用（至少保留一个）' };
  seq.delete(idx);
  return { ok: true, yaml: doc.toString() };
}

/** 列出应用（旧 feishu 格式也能列：归一化为单元素）；纯 yaml 解析，不做完整配置校验 */
export function listApps(raw: string): Array<{ name: string; appId: string; domain?: string; defaultWorkspace?: string }> {
  const doc = parseDocument(raw);
  const seq = doc.get('apps') as YAMLSeq<YAMLMap> | undefined;
  if (!seq) {
    const feishu = doc.get('feishu') as YAMLMap | undefined;
    if (!feishu || typeof feishu !== 'object') return [];
    const appId = String(feishu.get('app_id') ?? '');
    return [{
      name: appId,
      appId,
      ...(feishu.get('domain') ? { domain: String(feishu.get('domain')) } : {}),
    }];
  }
  return seq.items.map((m) => ({
    name: String(m.get('name') ?? m.get('app_id') ?? ''),
    appId: String(m.get('app_id') ?? ''),
    ...(m.get('domain') ? { domain: String(m.get('domain')) } : {}),
    ...(m.get('default_workspace') ? { defaultWorkspace: String(m.get('default_workspace')) } : {}),
  }));
}
