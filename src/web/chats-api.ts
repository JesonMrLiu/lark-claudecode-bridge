// 「会话记录」页后端（三接口，全部只读）：树（机器人 → 通道）/ 话题（CC 会话聚合）/ 时间线。
// 数据源全部是 LCB 自有落盘，与记忆增强是否开启完全无关：
// - transcripts/<appId>/<chatId>/<YYYY-MM-DD>.jsonl：对话全文流水（transcript-writer，按天分文件）
// - sessions.<appId>.json：每通道话题索引（sessionId + 首条消息摘要，/resume 列表同源）
// - access.json：userId → 飞书人名
// 群名/会话类型经运行中网关的飞书 REST 现拉（gateway-registry；成功缓存 24h、失败短缓存 10 分钟
// ——权限补开后十分钟内自动恢复真名，不必重启）。lcb ui 独立进程无网关来源 → 走降级显示名。
// 设计基调：查看器不能因数据缺失报错——目录/文件缺失按空处理、坏行跳过、ID 白名单防路径穿越。
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, loadConfig } from '../config.js';
import type { BridgeConfig } from '../types.js';
import { getChatInfoSource } from '../gateway/gateway-registry.js';
import { getCachedChatMeta, getCachedUserName, getCachedUserUnion, putCachedChatMeta, putCachedUserName } from '../feishu/name-cache.js';
import { resolveNamesByUnionViaSiblings } from '../feishu/sibling-names.js';
import type { TranscriptEvent } from '../transcript/transcript-writer.js';

const TRANSCRIPTS_DIR = join(CONFIG_DIR, 'transcripts');
/** 路径安全：appId/chatId 仅接受飞书 id 字符集（拼路径前把守，杜绝 ../ 穿越）；日期由白名单正则把守 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const JSONL_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
/** 话题跨天索引的防呆上限（主人已拍板：无天数上限；此处仅防异常巨库一次性拖死进程） */
const MAX_SCAN_FILES = 300;
const MAX_SCAN_BYTES = 150 * 1024 * 1024;
/** 时间线单次返回的任务数上限（前端「仅显示最近 N 条」提示的口径） */
const DEFAULT_TASK_LIMIT = 400;

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && ID_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch { return []; } // transcripts 目录不存在（尚无任何对话）= 空树而非报错
}

function listDateFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => JSONL_RE.test(f)).sort().reverse(); // 新→旧
  } catch { return []; }
}

/** access.json 人名表（userId → name；损坏/缺失按空表，查看器不因准入数据报错） */
function readAccessNames(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(join(CONFIG_DIR, 'access.json'), 'utf8')) as {
      users?: Record<string, { name?: string }>;
    };
    for (const [uid, u] of Object.entries(raw.users ?? {})) {
      if (u?.name) out.set(uid, u.name);
    }
  } catch { /* 无准入数据：人名全部走 chatId/尾号降级 */ }
  return out;
}

interface StoreTopic { sessionId?: string; summary?: string; updatedAt?: string }
type SessionStoreShape = Record<string, { sessions?: StoreTopic[] }>;

/** sessions.<appId>.json 原样读（channelKey → ChannelState）；缺失/损坏按空表 */
function readSessionStore(appId: string): SessionStoreShape {
  try {
    const raw = JSON.parse(readFileSync(join(CONFIG_DIR, `sessions.${appId}.json`), 'utf8')) as SessionStoreShape;
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

// ============ 飞书真群名（gateway-registry → GET /open-apis/im/v1/chats/:chat_id） ============

interface ChatMeta { name?: string; chatType?: string; at: number }
/** 成功态走磁盘持久缓存（name-cache，重启不丢）；本 Map 只留「拉取失败」短缓存（10 分钟自愈） */
const chatMetaCache = new Map<string, ChatMeta>(); // key `${appId}/${chatId}`
const META_FAIL_TTL_MS = 10 * 60 * 1000;      // 拉取失败短缓存：im:chat 权限补开后十分钟内自动恢复真名

async function fetchChatMeta(appId: string, chatId: string): Promise<ChatMeta | undefined> {
  const key = `${appId}/${chatId}`;
  const disk = getCachedChatMeta(appId, chatId);
  if (disk?.name) return { ...disk, at: 0 }; // 磁盘命中：零 API 调用（30 天/3 天 TTL 由缓存层管）
  const hit = chatMetaCache.get(key);
  if (hit && Date.now() - hit.at < META_FAIL_TTL_MS) return hit; // 失败短缓存：别反复打飞书
  const src = getChatInfoSource(appId);
  if (!src) return hit ?? (disk ? { ...disk, at: 0 } : undefined); // 桥未运行：失败态或磁盘旧值
  try {
    const res = await src.request({ method: 'GET', url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}` });
    const data = res.data as { name?: unknown; chat_type?: unknown; chat_mode?: unknown } | undefined;
    if (res.code === 0 && typeof data?.name === 'string' && data.name) {
      const meta: ChatMeta = {
        name: data.name,
        // 飞书字段不统一：详情接口部分会话给 chat_type（取值 private/group）、部分只有
        // chat_mode（p2p/group）——实测同一应用两种形态都出现，两个都读
        chatType: typeof data.chat_type === 'string' && data.chat_type
          ? data.chat_type
          : typeof data.chat_mode === 'string' ? data.chat_mode : '',
        at: Date.now(),
      };
      putCachedChatMeta(appId, chatId, { name: meta.name, chatType: meta.chatType });
      return meta;
    }
  } catch { /* 机器人不在群 / 权限缺失 / 网络失败：降级显示名 */ }
  const failed: ChatMeta = { at: Date.now() };
  chatMetaCache.set(key, failed);
  // 曾拉到过真名（磁盘旧值未过期）→ 继续用旧真名，好过降级串
  return disk?.name ? { ...disk, at: 0 } : failed;
}

function chatIdTail(chatId: string): string {
  return chatId.length > 6 ? chatId.slice(-6) : chatId;
}

// ============ 飞书真实用户名（gateway-registry → GET /open-apis/contact/v3/users/batch） ============
// 会话页发信人显示真名而非 ou_…：access.json 只覆盖配对过的用户，其余经通讯录批量解析。
// 成功缓存 24h、失败短缓存 10 分钟（同群名模式——contact 权限补开后十分钟内自动恢复真名）。
// 需要应用开通「获取用户基本信息」（contact:user.base:readonly）；未开通时自动降级 ou 尾号显示。
interface UserNameMeta { name?: string; at: number }
/** 成功态走磁盘持久缓存（name-cache，30 天、重启不丢）；本 Map 只留「解析失败」短缓存（10 分钟自愈） */
const userNameCache = new Map<string, UserNameMeta>(); // key `${appId}/${openId}`
const USER_FAIL_TTL_MS = 10 * 60 * 1000;
/** contact batch 接口单次 user_ids 上限（官方约定 ≤50） */
const USER_BATCH_SIZE = 50;

/** 批量解析 open_id → 姓名（配对授权 API 同源复用）。整批失败（权限/网络）落短缓存防每轮树接口重打；零结果视为失败态 */
export async function fetchUserNames(appId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const need: string[] = [];
  for (const id of ids) {
    const diskName = getCachedUserName(appId, id);
    if (diskName) { out.set(id, diskName); continue; } // 磁盘命中：零 API 调用
    const hit = userNameCache.get(`${appId}/${id}`);
    if (hit && Date.now() - hit.at < USER_FAIL_TTL_MS) continue; // 失败短缓存：10 分钟后自动重试
    need.push(id);
  }
  if (!need.length) return out;
  const attempted = [...need]; // 本轮已尝试 contact 的 id 快照：兄弟桥候选（失败缓存是 contact 阶段才打的，不能堵同轮兄弟桥）
  const src = getChatInfoSource(appId);
  if (!src) return out; // 桥未运行（lcb ui 独立进程）：吃缓存，没有则本轮降级，不报错
  /** 吸收一批结果。⚠️ 飞书 v3 user 对象的标识字段是 open_id（user_id_type=open_id 时实测响应
   *  只有 open_id/union_id，无 user_id 字段）——10-15 起误取 it.user_id 恒为 undefined，
   *  真名解析从未生效、会话页全员 ou_（2026-10-18 主人反馈 + 插桩实锤后修复） */
  const absorb = (items: unknown, batch: string[]): boolean => {
    if (!Array.isArray(items)) return false;
    const got = new Set<string>();
    for (const it of items as Array<{ user_id?: unknown; open_id?: unknown; name?: unknown }>) {
      const uid = typeof it.open_id === 'string' && it.open_id ? it.open_id : it.user_id;
      const name = it.name;
      if (typeof uid === 'string' && typeof name === 'string' && name) {
        putCachedUserName(appId, uid, name); // 成功态落磁盘持久缓存（跨重启/跨场景共用）
        out.set(uid, name);
        got.add(uid);
      }
    }
    // 本批未被接口返回的 id：落失败短缓存（10 分钟后自动重试，可能后配对）
    for (const id of batch) {
      if (!got.has(id)) userNameCache.set(`${appId}/${id}`, { at: Date.now() });
    }
    return true;
  };
  const query = async (batch: string[]): Promise<void> => {
    const qs = batch.map((id) => `user_ids=${encodeURIComponent(id)}`).join('&');
    let ok = false;
    try {
      const res = await src.request({
        method: 'GET',
        url: `/open-apis/contact/v3/users/batch?user_id_type=open_id&${qs}`,
      });
      const items = res.code === 0
        ? (res.data as { items?: unknown } | undefined)?.items
        : undefined;
      ok = absorb(items, batch);
    } catch { /* 权限缺失 / 网络失败 / open_id 跨应用(99992361) 整批被拒：走下方逐个回退 */ }
    if (!ok && batch.length > 1) {
      // 整批失败 → 逐个回退：跨应用的坏 id 单查时被隔离（该 id 落失败缓存），好 id 照样拿到真名
      for (const id of batch) await query([id]);
    } else if (!ok) {
      for (const id of batch) userNameCache.set(`${appId}/${id}`, { at: Date.now() });
    }
  };
  for (let i = 0; i < need.length; i += USER_BATCH_SIZE) {
    await query(need.slice(i, i + USER_BATCH_SIZE));
  }
  // 兄弟应用桥兜底（与网关 resolveUserNames 同款）：通讯录权限范围外用户的缺口 id，
  // 用磁盘 union 索引借兄弟应用凭证解析；命中写共享磁盘缓存并清失败短缓存；兄弟也查不到
  // → 失败缓存已在 absorb 落好（跨轮节流，防配置页 30s 轮询重打）；无 union 索引的不动
  // 失败缓存（后续事件带来 union 时即清缓存立即可重试）
  const missing = attempted.filter((id) => !out.has(id));
  if (missing.length) {
    const unions = new Map<string, string>();
    for (const id of missing) {
      const u = getCachedUserUnion(appId, id);
      if (u) unions.set(id, u);
    }
    if (unions.size) {
      try {
        const got = await resolveNamesByUnionViaSiblings(appId, unions);
        for (const [id, name] of got) {
          putCachedUserName(appId, id, name);
          out.set(id, name);
          userNameCache.delete(`${appId}/${id}`);
        }
        for (const id of unions.keys()) if (!got.has(id)) userNameCache.set(`${appId}/${id}`, { at: Date.now() });
      } catch { /* 桥失败不影响已解析结果 */ }
    }
  }
  return out;
}

/**
 * 真名回写 access.json（自愈）：配对时拿不到真名、name 落的是原始 open_id 的记录，
 * 一旦通讯录解析成功就补正——配对展示/群内管理员名/会话页全线受益。只修「缺失或自指」项，
 * 用户自填的真名永不被覆盖；确有修改才写盘（读-改-写，与运行中 AccessControl 实例的整盘
 * 覆写存在竞态窗口，但本写入低频 + 下轮树接口自愈，可接受）
 */
function backfillAccessNames(names: Array<[string, string]>): void {
  if (!names.length) return;
  const path = join(CONFIG_DIR, 'access.json');
  let raw: { users?: Record<string, { name?: string }> };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as { users?: Record<string, { name?: string }> };
  } catch { return; } // 无准入数据/损坏：不造文件
  let changed = false;
  for (const [uid, name] of names) {
    const u = raw.users?.[uid];
    if (u && (!u.name || u.name === uid) && name !== uid) {
      u.name = name;
      changed = true;
    }
  }
  if (!changed) return;
  try {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch { /* 回写失败不影响展示（内存缓存已生效） */ }
}

/** 显示名三级降级：飞书真名 → access 人名（单用户=p2p）→ 「群聊（N人）/会话 ·尾号」。
 *  chatType 独立透出：群信息拉到但群名为空（如 p2p 无名）时类型不再被丢弃——
 *  此前丢弃导致前端把群聊误标「私聊」（2026-10-17 主人反馈） */
function buildDisplayName(
  meta: ChatMeta | undefined, users: string[], access: Map<string, string>, chatId: string,
): { displayName: string; chatType: string; nameSource: 'feishu' | 'access' | 'fallback' } {
  const chatType = meta?.chatType || (users.length > 1 ? 'group' : '');
  if (meta?.name) return { displayName: meta.name, chatType, nameSource: 'feishu' };
  if (users.length === 1) {
    const n = access.get(users[0]);
    if (n) return { displayName: n, chatType: chatType || 'p2p', nameSource: 'access' };
  }
  const label = users.length > 1 ? `群聊（${users.length}人）` : '会话';
  return { displayName: `${label} ·${chatIdTail(chatId)}`, chatType, nameSource: 'fallback' };
}

// ============ ① 树：GET /api/chats/tree ============

/** 「用户+/new」会话条目（一次 /new = 一个 sessionId）：列表页的列表项即此粒度 */
export interface ChatSessionSummary {
  sessionId: string;
  /** 首条消息摘要（session-store 口径，取 updatedAt 最新一条）；空则退 sessionId 前 8 位 */
  title: string;
  updatedAt: string;
  /** 参与用户（channelKey 拆出；同 sessionId 跨用户合并，常态 1 人） */
  users: Array<{ userId: string; name?: string }>;
}
export interface ChatChannelSummary {
  chatId: string;
  displayName: string;
  /** p2p / group；拉不到时可能为空串 */
  chatType: string;
  nameSource: 'feishu' | 'access' | 'fallback';
  users: Array<{ userId: string; name?: string }>;
  /** 有记录的日期（新→旧），前端日期下拉直接用 */
  dates: string[];
  lastActiveAt: string;
  /** 话题数（session-store 口径 = 该通道全部 CC 会话） */
  topics: number;
  sizeBytes: number;
  /** 会话条目（updatedAt 降序）。数据源 = sessions.<appId>.json，树接口本就在读，零新增 IO */
  sessions: ChatSessionSummary[];
}
export interface ChatBotSummary { appId: string; name: string; channels: ChatChannelSummary[] }

export async function chatsTree(configPath: string): Promise<{ bots: ChatBotSummary[] }> {
  let config: BridgeConfig | undefined;
  try { config = loadConfig(configPath); } catch { /* 配置损坏也照常扫目录：显示名退化为 appId */ }
  const appNames = new Map((config?.apps ?? []).map((a) => [a.appId, a.name || a.appId]));
  const access = readAccessNames();
  const bots: ChatBotSummary[] = [];
  for (const appId of listDirs(TRANSCRIPTS_DIR)) {
    const store = readSessionStore(appId);
    // channelKey = `${chatId}:${userId}`（session/channel.ts 口径）→ 按 chatId 聚合用户、话题数与会话条目
    const usersByChat = new Map<string, string[]>();
    const topicCountByChat = new Map<string, number>();
    /** (chatId, sessionId) 聚合：跨 userId 合并、updatedAt 取最新、标题同步取最新一条的摘要（与 chatTopics 同口径） */
    const sessionsByChat = new Map<string, Map<string, { title: string; updatedAt: string; users: Set<string> }>>();
    for (const [key, st] of Object.entries(store)) {
      const i = key.lastIndexOf(':');
      if (i <= 0) continue;
      const chatId = key.slice(0, i);
      const userId = key.slice(i + 1);
      let arr = usersByChat.get(chatId);
      if (!arr) usersByChat.set(chatId, arr = []);
      if (!arr.includes(userId)) arr.push(userId);
      topicCountByChat.set(chatId, (topicCountByChat.get(chatId) ?? 0) + (st.sessions?.length ?? 0));
      let bySid = sessionsByChat.get(chatId);
      if (!bySid) sessionsByChat.set(chatId, bySid = new Map());
      for (const t of st.sessions ?? []) {
        if (!t?.sessionId) continue;
        const cur = bySid.get(t.sessionId);
        if (cur) {
          cur.users.add(userId);
          if ((t.updatedAt ?? '') > cur.updatedAt) {
            cur.updatedAt = t.updatedAt ?? '';
            cur.title = t.summary ?? '';
          }
        } else {
          bySid.set(t.sessionId, { title: t.summary ?? '', updatedAt: t.updatedAt ?? '', users: new Set([userId]) });
        }
      }
    }
    const channels: ChatChannelSummary[] = [];
    for (const chatId of listDirs(join(TRANSCRIPTS_DIR, appId))) {
      const dates: string[] = [];
      let lastActiveMs = 0;
      let sizeBytes = 0;
      for (const f of listDateFiles(join(TRANSCRIPTS_DIR, appId, chatId))) {
        dates.push(f.slice(0, 10));
        try {
          const st = statSync(join(TRANSCRIPTS_DIR, appId, chatId, f));
          lastActiveMs = Math.max(lastActiveMs, st.mtimeMs);
          sizeBytes += st.size;
        } catch { /* 文件恰好被清理：跳过 */ }
      }
      const users = usersByChat.get(chatId) ?? [];
      const meta = await fetchChatMeta(appId, chatId);
      // 发信人真名：飞书通讯录解析为权威，access 仅兜底——合并顺序 feishu 在后（同 key 胜出），
      // 且 access 里 name===userId 的自指记录（配对时拿不到真名落了原始 id）不参与兜底，
      // 否则会把飞书真名顶回 ou_ 串（2026-10-17 主人反馈会话页 ou_ 满屏的根因之一）
      const feishuNames = await fetchUserNames(appId, users);
      const accessNames = new Map<string, string>();
      for (const [uid, n] of access) {
        if (n && n !== uid) accessNames.set(uid, n);
      }
      const nameMap = new Map<string, string>([...accessNames, ...feishuNames]);
      backfillAccessNames([...feishuNames]);
      const name = buildDisplayName(meta, users, nameMap, chatId);
      // 会话条目（列表页列表项）：名字复用本通道已解析的 nameMap，无额外飞书调用
      const sessions: ChatSessionSummary[] = [];
      for (const [sessionId, v] of sessionsByChat.get(chatId) ?? []) {
        sessions.push({
          sessionId,
          title: v.title || sessionId.slice(0, 8), // 无摘要的历史数据退化为短 id
          updatedAt: v.updatedAt,
          users: [...v.users].map((userId) => ({ userId, ...(nameMap.get(userId) ? { name: nameMap.get(userId) } : {}) })),
        });
      }
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      channels.push({
        chatId,
        displayName: name.displayName,
        chatType: name.chatType,
        nameSource: name.nameSource,
        users: users.map((userId) => ({ userId, ...(nameMap.get(userId) ? { name: nameMap.get(userId) } : {}) })),
        dates,
        lastActiveAt: lastActiveMs ? new Date(lastActiveMs).toISOString() : '',
        topics: topicCountByChat.get(chatId) ?? 0,
        sizeBytes,
        sessions,
      });
    }
    channels.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    bots.push({ appId, name: appNames.get(appId) ?? appId, channels });
  }
  return { bots };
}

// ============ ② 话题：GET /api/chats/topics ============

export interface ChatTopicSummary { sessionId: string; title: string; updatedAt: string; users: string[] }

/** 某通道的话题列表（session-store 聚合：跨 userId 合并、同 sessionId 去重取最新）。标题 = 首条消息摘要 */
export function chatTopics(appId: string, chatId: string): { topics: ChatTopicSummary[] } {
  if (!ID_RE.test(appId) || !ID_RE.test(chatId)) return { topics: [] };
  const store = readSessionStore(appId);
  const prefix = `${chatId}:`;
  const bySid = new Map<string, { title: string; updatedAt: string; users: Set<string> }>();
  for (const [key, st] of Object.entries(store)) {
    if (!key.startsWith(prefix)) continue;
    const userId = key.slice(prefix.length);
    for (const t of st.sessions ?? []) {
      if (!t?.sessionId) continue;
      const cur = bySid.get(t.sessionId);
      if (cur) {
        cur.users.add(userId);
        if ((t.updatedAt ?? '') > cur.updatedAt) {
          cur.updatedAt = t.updatedAt ?? '';
          cur.title = t.summary ?? '';
        }
      } else {
        bySid.set(t.sessionId, { title: t.summary ?? '', updatedAt: t.updatedAt ?? '', users: new Set([userId]) });
      }
    }
  }
  const topics = [...bySid.entries()]
    .map(([sessionId, v]) => ({
      sessionId,
      title: v.title || sessionId.slice(0, 8), // 无摘要的历史数据退化为短 id
      updatedAt: v.updatedAt,
      users: [...v.users],
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { topics };
}

// ============ ③ 时间线：GET /api/chats/timeline ============

export interface ToolStep { ts: string; tool: string; ok?: boolean }
/** 任务 = 一条飞书消息触发的一次 CC 执行：user 提问 + 流式回复拼接 + 工具步骤 + 收尾状态 */
export interface ChatTask {
  date: string;
  ts: string;
  userId: string;
  workspace?: string;
  /** 权威 CC 会话 id（result 行优先；新话题首轮 user 行的起点指针兜底） */
  sessionId?: string;
  prompt: string;
  /** 流式回复块顺序拼接；无流式块时回退 result 文本（错误信息等） */
  reply: string;
  tools: ToolStep[];
  result?: { subtype: string; producedFiles?: string[]; turns?: number };
}
export interface ChatTimelineResult { tasks: ChatTask[]; truncated: boolean; partial: boolean; scanDays: number }

/** 单日 JSONL → 任务序列（顺序行走；坏行跳过；孤儿 assistant/tool 不进时间线）。
 *  assistant 事件是流式分块（每块一行），顺序拼接即完整回复；reply 为空时回退 result 文本 */
function parseDayTasks(dir: string, date: string): ChatTask[] {
  let text: string;
  try { text = readFileSync(join(dir, `${date}.jsonl`), 'utf8'); } catch { return []; } // 缺天 = 空
  const tasks: ChatTask[] = [];
  let cur: ChatTask | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev: TranscriptEvent;
    try { ev = JSON.parse(line) as TranscriptEvent; } catch { continue; }
    if (ev.kind === 'user') {
      cur = {
        date,
        ts: ev.ts,
        userId: ev.userId,
        ...(ev.workspace ? { workspace: ev.workspace } : {}),
        ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
        prompt: ev.text,
        reply: '',
        tools: [],
      };
      tasks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (ev.kind === 'assistant') {
      cur.reply += ev.text;
    } else if (ev.kind === 'tool') {
      if (ev.phase === 'start') {
        cur.tools.push({ ts: ev.ts, tool: ev.tool });
      } else {
        // result 相位回填同工具的执行状态（倒序找最近一个未定状态的 start）
        for (let i = cur.tools.length - 1; i >= 0; i--) {
          if (cur.tools[i].tool === ev.tool && cur.tools[i].ok === undefined) {
            cur.tools[i].ok = ev.ok;
            break;
          }
        }
      }
    } else if (ev.kind === 'result') {
      cur.result = {
        subtype: ev.subtype,
        ...(ev.producedFiles?.length ? { producedFiles: ev.producedFiles } : {}),
        ...(ev.turns !== undefined ? { turns: ev.turns } : {}),
      };
      if (ev.sessionId) cur.sessionId = ev.sessionId; // 权威口径覆盖起点指针
      if (!cur.reply && ev.text) cur.reply = ev.text;
      cur = null;
    }
  }
  return tasks;
}

function extractJsonString(line: string, key: string): string {
  const marker = `"${key}":"`;
  const i = line.indexOf(marker);
  if (i < 0) return '';
  const start = i + marker.length;
  const end = line.indexOf('"', start);
  return end < 0 ? '' : line.slice(start, end);
}

interface TopicIndex { fingerprint: string; datesBySession: Map<string, string[]>; partial: boolean }
const indexCache = new Map<string, TopicIndex>(); // key = 通道目录

function fingerprintOf(dir: string, files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    try {
      const st = statSync(join(dir, f));
      parts.push(`${f}:${st.mtimeMs}:${st.size}`);
    } catch { parts.push(f); }
  }
  return parts.join('|');
}

/** 建「会话 → 出现日期」索引：行级子串抽取（user=起点指针 / result=权威 id），不做全量 JSON.parse。
 *  无天数上限（新→旧扫全部历史）；仅文件数/字节数防呆。首次建后进程内缓存，文件指纹变化才重建 */
function buildTopicIndex(dir: string, files: string[]): TopicIndex {
  const datesBySession = new Map<string, string[]>();
  let bytes = 0;
  let scanned = 0;
  let partial = false;
  for (const f of files) {
    if (scanned >= MAX_SCAN_FILES || bytes > MAX_SCAN_BYTES) { partial = true; break; }
    let size = 0;
    try { size = statSync(join(dir, f)).size; } catch { continue; }
    bytes += size;
    scanned++;
    let text: string;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const date = f.slice(0, 10);
    let pending = ''; // 最近一条 user 行的起点指针（新话题首轮为空，由 result 行权威 id 补齐）
    const reg = (sid: string): void => {
      if (!sid) return;
      let arr = datesBySession.get(sid);
      if (!arr) datesBySession.set(sid, arr = []);
      if (!arr.includes(date)) arr.push(date);
    };
    for (const line of text.split('\n')) {
      if (line.includes('"kind":"user"')) {
        pending = extractJsonString(line, 'sessionId');
        reg(pending);
      } else if (line.includes('"kind":"result"')) {
        reg(extractJsonString(line, 'sessionId'));
        reg(pending);
        pending = '';
      }
    }
    reg(pending); // 无 result 收尾（进程被杀）的任务同样归进索引
  }
  return { fingerprint: fingerprintOf(dir, files), datesBySession, partial };
}

/**
 * 时间线查询。三种口径：
 * - date 指定：单日视图（不过索引，直读该日文件）
 * - session 指定：话题视图（索引定位该会话出现的日期，再跨天聚合归属任务）——任何历史话题都能看全
 * - 都不传：最新往旧全量（防呆上限内），供「全部记录」浏览
 * 返回任务序列（时间升序）；truncated=达到单次返回上限，partial=索引被防呆上限截断。
 */
export function chatTimeline(
  appId: string, chatId: string,
  query: { date?: string; session?: string; user?: string; limit?: number },
): ChatTimelineResult {
  const empty: ChatTimelineResult = { tasks: [], truncated: false, partial: false, scanDays: 0 };
  if (!ID_RE.test(appId) || !ID_RE.test(chatId)) return empty;
  const dir = join(TRANSCRIPTS_DIR, appId, chatId);
  const files = listDateFiles(dir);
  if (files.length === 0) return empty;
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_TASK_LIMIT, 1), 1000);
  let scanDates: string[];
  let partial = false;
  if (query.date && DATE_RE.test(query.date)) {
    scanDates = [query.date];
  } else {
    let index = indexCache.get(dir);
    const fingerprint = fingerprintOf(dir, files);
    if (!index || index.fingerprint !== fingerprint) {
      index = buildTopicIndex(dir, files);
      indexCache.set(dir, index);
    }
    partial = index.partial;
    scanDates = query.session
      ? (index.datesBySession.get(query.session) ?? [])
      : files.map((f) => f.slice(0, 10));
  }
  const tasks: ChatTask[] = [];
  let truncated = false;
  for (const date of scanDates) {
    if (!DATE_RE.test(date)) continue;
    for (const t of parseDayTasks(dir, date)) {
      if (query.session && t.sessionId !== query.session) continue;
      if (query.user && t.userId !== query.user) continue;
      tasks.push(t);
      if (tasks.length >= limit) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { tasks, truncated, partial, scanDays: scanDates.length };
}
