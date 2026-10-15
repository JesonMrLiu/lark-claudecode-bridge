// 长期记忆（OpenViking）集成 · B1 配置通道（生命周期方案 §6，docs/LCB会话生命周期与长期记忆整合方案-v2.3.md）。
// 职责收敛在「配置 → env 下发 / 插件注入」的纯计算 + 最小 HTTP（探活 / user key 签发）——弱耦合
// 验收：LCB 对 OpenViking 零 SDK 依赖、零 import，全部交互只有 HTTP 与环境变量。B3 嵌入式
// 安装器（uv / 受管子进程 / ov.conf 渲染）在此文件基础上扩展，不动本层语义。
//
// OpenViking 0.5.0 身份体系（源码探查 + 实测确认）：
// - env 三键由 openviking_sdk 转为请求 header：OPENVIKING_API_KEY → X-API-Key、
//   OPENVIKING_ACCOUNT → X-OpenViking-Account、OPENVIKING_USER → X-OpenViking-User
// - auth_mode=dev（单机默认）：key 不校验，身份完全由 Account/User header 决定——env 下发
//   OPENVIKING_USER 即得 ns 隔离，无须任何 key（仅限回环监听的本机场景）
// - auth_mode=api_key（root_api_key 配置后）：Account/User header 被服务端剥除，身份由
//   X-API-Key 自带（key = base64url(account).base64url(user).base64url(secret)，不可伪造）；
//   user key 经 Admin API 签发（POST /api/v1/admin/accounts/{account}/users，X-API-Key 携带
//   root key）。0.5.0 实测：seed 被忽略、key 非确定性、重复创建 409——重签接口为
//   POST /api/v1/admin/accounts/{account}/users/{uid}/key，详见 ensureMemoryUserKeys 注释
import { createHash } from 'node:crypto';
import type { MemoryConfig } from './types.js';

/** 记忆插件名（§6.9 自动注入目标；与 ~/.claude 侧 installed_plugins.json 键
 *  "openviking-memory@openviking" 的 @ 前段一致——discoverPlugins 的 name 口径） */
export const MEMORY_PLUGIN_NAME = 'openviking-memory';

/** 记忆服务缺省端点（dev 模式回环默认；embedded 模式由 B3 分配后回写 config） */
export const DEFAULT_MEMORY_ENDPOINT = 'http://127.0.0.1:1933';

/** 记忆账号缺省名（account 轴）。必须与 OpenViking 服务端自带账号一致：Admin API 对不存在的
 *  账号一律 404「Account not found」（实弹实测 0.5.0），账号名猜错的表现就是「一键初始化全 404」。
 *  服务端初始化后固定存在 default 账号，故以此为缺省 */
export const DEFAULT_MEMORY_ACCOUNT = 'default';

/** memory 段的生效账号（缺省 DEFAULT_MEMORY_ACCOUNT；显式配置优先） */
export function memoryAccount(memory: Pick<MemoryConfig, 'account'>): string {
  return memory.account?.trim() || DEFAULT_MEMORY_ACCOUNT;
}

/** memory 段的生效端点（remote 显式配置 > 缺省回环）。参数放宽为 Pick——渲染客户端接入配置
 *  （ovcli.conf 骨架）等场景只有 endpoint/account 子集，只读 endpoint 的纯函数不该要求全段 */
export function memoryEndpoint(memory: Pick<MemoryConfig, 'endpoint'>): string {
  return memory.endpoint?.trim() || DEFAULT_MEMORY_ENDPOINT;
}

/**
 * memory.enabled 时的 ns env 下发（§6.4/§6.6）——返回值由调用方以「保留既有值」方式并入
 * taskEnv（apps[].env 手配 OPENVIKING_* = 专家覆盖口，优先级最高）。键语义：
 * - OPENVIKING_ACCOUNT：账号轴（全局），缺省 lcb
 * - OPENVIKING_USER：用户轴 = {appId}-{userId}，**每条消息拼装**（群聊按人隔离；
 *   deputy 的 appId 天然不同于主 bot——「分身有自己的记忆、永不读主人记忆」的实现点）
 * - OPENVIKING_API_KEY：连接 key。api_key 模式 = 该 bot 的独立 user key（userKeys 缓存，
 *   root key 永不下发子进程）；dev 模式无 key（身份经 header 隔离）
 * - OPENVIKING_MEMORY_ENABLED：'1' 强制启用通道——插件 isPluginEnabled() 的第 1 优先级判据
 *   （插件 scripts/config.mjs），使启用不依赖 ~/.openviking/ 下任何文件（全新机器零手工的关键；
 *   与 ACCOUNT 同级、不依赖 userId）。实测教训：LCB 原先只下发身份三键，插件启用判定根本不看，
 *   全新机器 ~/.openviking 不存在 → 9 个 hook 全部静默秒退
 * - OPENVIKING_URL：memoryEndpoint(memory)——embedded = 受管服务实际端口（findFreePort 可能
 *   分到 1934+，插件缺省连 127.0.0.1:1933 会错连）、remote = 外部端点。它同时是插件
 *   CREDENTIAL_ENV_VARS 成员：任一凭证 env 存在 → 凭证链 unpinned → env 层恒压过
 *   ovcli.conf/ov.conf，文件通道（哪怕 user-managed）永远劫持不了 LCB 会话的连接
 * 纯函数 exported 便于单测；userId 为空串时不产出 OPENVIKING_USER（防御非消息触发的任务路径）。
 */
export function memoryEnvFor(
  memory: MemoryConfig,
  appId: string,
  userId: string,
  /** 启动时 Admin API 签发的 per-bot user key（api_key 模式）；缺失/未签发则跳过 key 下发 */
  userKeys?: ReadonlyMap<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    OPENVIKING_ACCOUNT: memoryAccount(memory),
    OPENVIKING_MEMORY_ENABLED: '1',
    OPENVIKING_URL: memoryEndpoint(memory),
  };
  if (userId) env.OPENVIKING_USER = `${appId}-${userId}`;
  const key = userKeys?.get(appId);
  if (key) env.OPENVIKING_API_KEY = key;
  return env;
}

/** 探活结果：healthy + 服务端自报版本/鉴权模式（B2 配置页状态灯数据源；B3 受管进程崩溃检测） */
export interface MemoryHealth {
  healthy: boolean;
  /** /health 返回的 version 字段（成功时必有；探活失败缺省） */
  version?: string;
  /** /health 返回的 auth_mode（"dev" / "api_key"）；决定身份隔离走 header 还是 user key */
  authMode?: string;
  /** 失败分类（配置页据此给「下一步动作」而非笼统「服务异常」）：
   *  not-running=连接被拒（端口无监听，服务进程未运行——已装可拉起）
   *  unreachable=端点不可达/域名解析失败；timeout=探活超时；auth=401/403（key 不匹配）
   *  http-error=其他非 2xx；unhealthy=2xx 但服务自报异常；error=未分类异常 */
  reason?: 'not-running' | 'unreachable' | 'timeout' | 'auth' | 'http-error' | 'unhealthy' | 'error';
  /** 失败原因（用户可读，进状态灯 tooltip / 日志） */
  detail?: string;
}

/**
 * OpenViking server 探活（GET {endpoint}/health）：B1 启动检查、B2 状态区状态灯、B3 受管进程
 * 崩溃检测共用。短超时（缺省 2s）——探活走消息处理路径时不能拖住任务。Node 18+ 原生 fetch；
 * 失败（网络/超时/非 200/JSON 异常）一律收敛为 { healthy: false, detail }，不抛出。
 */
export async function probeMemoryHealth(endpoint: string, timeoutMs = 2000): Promise<MemoryHealth> {
  const url = `${endpoint.replace(/\/+$/, '')}/health`;
  // host/port 仅用于失败文案定位（如「127.0.0.1:1933 无进程监听」）；URL 非法时留空
  const { hostname, port } = (() => { try { return new URL(url); } catch { return { hostname: '', port: '' }; } })();
  const at = hostname ? `${hostname}:${port || '1933'}` : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      // 401/403 单列：api_key 模式 key 不匹配与服务未运行是完全不同的处置路径
      if (res.status === 401 || res.status === 403) {
        return { healthy: false, reason: 'auth', detail: `HTTP ${res.status}（鉴权失败：服务为 api_key 模式时检查 memory.api_key / root key 是否匹配）` };
      }
      return { healthy: false, reason: 'http-error', detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { status?: string; healthy?: boolean; version?: string; auth_mode?: string };
    // 服务端语义：status=ok（0.5.0 实测）；healthy 字段兼容未来版本
    const ok = body.status === 'ok' || body.healthy === true;
    return ok
      ? {
        healthy: true,
        ...(typeof body.version === 'string' ? { version: body.version } : {}),
        ...(typeof body.auth_mode === 'string' ? { authMode: body.auth_mode } : {}),
      }
      : { healthy: false, reason: 'unhealthy', detail: `服务进程在但自报异常：${JSON.stringify(body)}` };
  } catch (e) {
    // Node 18+ 原生 fetch（undici）连接层失败一律抛 TypeError: fetch failed，真实 errno 藏在
    // e.cause.code——不读 cause 时用户只能看到「fetch failed」，无法区分「服务没跑」与「网络问题」
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const code = err?.cause?.code ?? (e as NodeJS.ErrnoException | null)?.code;
    if (e instanceof Error && e.name === 'AbortError') {
      return { healthy: false, reason: 'timeout', detail: `探活超时（>${timeoutMs}ms）——服务无响应` };
    }
    if (code === 'ECONNREFUSED') {
      return { healthy: false, reason: 'not-running', detail: `连接被拒绝：${at} 无进程监听，服务未运行` };
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return { healthy: false, reason: 'unreachable', detail: `域名无法解析：${hostname || url}` };
    }
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
      return { healthy: false, reason: 'timeout', detail: `连接${code === 'ECONNRESET' ? '被重置' : '超时'}（${at}）` };
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return { healthy: false, reason: 'unreachable', detail: `网络不可达：${hostname || url}` };
    }
    const detail = e instanceof Error
      ? (e.message === 'fetch failed' && err.cause?.message ? `网络错误：${err.cause.message}` : e.message)
      : String(e);
    return { healthy: false, reason: 'error', detail };
  } finally {
    clearTimeout(timer);
  }
}

/** BridgeDeps.memory 最小接口（§6.6）：探活供启动/状态页；namespacesFor 供 B2 ns 矩阵；
 *  userKeys 供 env 下发取 per-bot key（dev 模式为空 Map——身份走 header） */
export interface MemoryProvider {
  isHealthy(): Promise<MemoryHealth>;
  /** 某 bot 的 ns 映射（account/user 前缀；peer 轴按 workspace 运行期派生，不在此暴露） */
  namespacesFor(appId: string): { account: string; userPrefix: string };
  /** 启动/热重载时 Admin API 签发的 per-bot user key（appId → key）；未签发/未启用为空 */
  userKeys(): ReadonlyMap<string, string>;
}

/** 生产实现：全部现读 config.memory 与共享 key 缓存（同一 config 引用被热重载 mutate，改段即生效） */
export function createMemoryProvider(config: BridgeConfigLike, userKeys: ReadonlyMap<string, string>): MemoryProvider {
  return {
    isHealthy: () => (config.memory?.enabled
      ? probeMemoryHealth(memoryEndpoint(config.memory))
      : Promise.resolve({ healthy: false, detail: 'memory 段未开启' })),
    namespacesFor: (appId: string) => ({
      account: config.memory ? memoryAccount(config.memory) : DEFAULT_MEMORY_ACCOUNT,
      userPrefix: `${appId}-`,
    }),
    userKeys: () => userKeys,
  };
}
/** createMemoryProvider 只需 config 的 memory 段（结构子集，避免循环 import BridgeConfig） */
interface BridgeConfigLike { memory?: MemoryConfig }

/** 单个 bot 的 user key 签发/跳过结果 */
export interface MemoryKeyOutcome {
  appId: string;
  /** 签发成功（api_key 模式）；dev 模式为 undefined（skipped 带原因） */
  userKey?: string;
  skipped?: string;
  error?: string;
}

/**
 * 为每个 bot 签发独立 user key（§6.7 第 5 步；api_key 模式）。
 * - dev 模式：整体跳过——身份隔离由 OPENVIKING_USER → X-OpenViking-User header 承担，
 *   Admin API 在 dev 模式被服务端禁用（403），跳过是唯一正解而非降级
 * - api_key 模式：X-API-Key 携带 root key（memory.api_key，只在本函数与配置盘间流转），
 *   POST /api/v1/admin/accounts/{account}/users 签发
 * - 失败不抛出（逐 bot 记 error）：记忆不可用不应阻断机器人服务，与插件发现的容错基调一致
 *
 * OpenViking 0.5.0 实弹实测（探针：创建→重复→重签→列表→删除，全绿）修正了三条旧假设：
 *  ① key **非确定性**——seed 参数被服务端忽略，同一 user 每次重签都换新 key。因此「同 seed
 *     重签同值、LCB 无须持久化」不成立，重启必须重新拿到 key（靠下面的三级回退拿，不靠 seed）。
 *  ② 重复创建返回 **409 ALREADY_EXISTS**，不是「幂等返回同值」。旧实现一旦 409 就记 error 放弃，
 *     于是「首启建过用户 → 之后每次重启都 409 → 永远拿不到 key → 永远无记忆」——本函数的重签
 *     与读回两级回退就是为消灭这个死循环（服务重启、root key 轮换、一键初始化重建用户都会踩）。
 *  ③ 服务端只认**已存在的账号**：账号不存在时 Admin API 一律 404「Account not found」，故签发前
 *     先确保账号存在（ensureRemoteAccount，缺账号自动创建）。
 */
export async function ensureMemoryUserKeys(
  memory: MemoryConfig,
  appIds: string[],
  timeoutMs = 5000,
): Promise<Map<string, MemoryKeyOutcome>> {
  const out = new Map<string, MemoryKeyOutcome>();
  const base = memoryEndpoint(memory).replace(/\/+$/, '');
  const health = await probeMemoryHealth(memoryEndpoint(memory), timeoutMs);
  if (!health.healthy) {
    for (const appId of appIds) {
      out.set(appId, { appId, skipped: `服务不可达（${health.detail ?? '未知原因'}），身份隔离依赖 OPENVIKING_USER header` });
    }
    return out;
  }
  if (health.authMode !== 'api_key') {
    for (const appId of appIds) {
      out.set(appId, { appId, skipped: `服务为 ${health.authMode ?? 'unknown'} 模式：身份经 X-OpenViking-User header 隔离，无需 user key（多租户部署请在 ov.conf 配 root_api_key 启用 api_key 模式）` });
    }
    return out;
  }
  const account = memoryAccount(memory);
  const rootKey = memory.apiKey;
  if (!rootKey) {
    for (const appId of appIds) {
      out.set(appId, { appId, error: '服务为 api_key 模式但 memory.api_key（root key）未配置：无法签发 user key，请先在 memory 段配置 root key' });
    }
    return out;
  }
  // 账号兜底：账号不存在时后续全部 404（这是「一键初始化全 404」的最常见真因）。先查再建，
  // 建失败只记 error 不用异常中断——签发逐 bot 继续，文案给出可操作指引
  const accountReady = await ensureRemoteAccount(base, account, rootKey, timeoutMs);
  for (const appId of appIds) {
    if (!accountReady.ok) {
      out.set(appId, { appId, error: `记忆账号「${account}」不可用：${accountReady.detail}` });
      continue;
    }
    const r = await signOneUserKey(base, account, appId, rootKey, timeoutMs);
    if (r.userKey) out.set(appId, { appId, userKey: r.userKey });
    else out.set(appId, { appId, error: r.error ?? '签发失败' });
  }
  return out;
}

/** Admin API 一次调用的最小结果（HTTP 状态 + result + 可读错误文案） */
interface AdminResult { ok: boolean; status: number; result?: Record<string, unknown>; error?: string }

/** Admin API 调用统一入口（X-API-Key 携 root key；错误文案优先取服务端 error.message——
 *  OpenViking 的错误体是 {error:{code,message}}，旧实现只读顶层 message，导致 404 变成裸码） */
async function adminFetch(
  url: string, rootKey: string, method: string, body?: unknown, timeoutMs = 5000,
): Promise<AdminResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': rootKey },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as {
      result?: Record<string, unknown>;
      message?: string;
      error?: { code?: string; message?: string } | string;
    };
    const errObj = typeof json.error === 'object' && json.error ? json.error : undefined;
    const message = errObj?.message ?? (typeof json.error === 'string' ? json.error : undefined) ?? json.message;
    const code = errObj?.code ? `${errObj.code}` : undefined;
    return {
      ok: res.ok,
      status: res.status,
      ...(res.ok && json.result && typeof json.result === 'object' ? { result: json.result } : {}),
      ...(message ? { error: [code, message].filter(Boolean).join(': ') } : {}),
    };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 账号存在性兜底：GET 列表命中即真；未命中则 POST 创建（OpenViking 0.5.0 提供
 *  POST /api/v1/admin/accounts）。已存在时 POST 语义未验证，故一律先查后建 */
export async function ensureRemoteAccount(
  base: string, account: string, rootKey: string, timeoutMs = 5000,
): Promise<{ ok: boolean; detail: string }> {
  const list = await adminFetch(`${base}/api/v1/admin/accounts`, rootKey, 'GET', undefined, timeoutMs);
  if (list.ok && Array.isArray(list.result?.accounts)) {
    return { ok: true, detail: '账号已存在' };
  }
  // 上游 0.5.0 的账号列表把数组放在 result（result: [{account_id,...}]）；两种形态都认
  if (list.ok && Array.isArray(list.result)) {
    const accounts = list.result as Array<{ account_id?: string }>;
    if (accounts.some((a) => a?.account_id === account)) return { ok: true, detail: '账号已存在' };
  }
  if (list.ok && !Array.isArray(list.result)) return { ok: true, detail: '账号列表不可解析，按已存在处理' };
  const created = await adminFetch(`${base}/api/v1/admin/accounts`, rootKey, 'POST', { account_id: account }, timeoutMs);
  if (created.ok) return { ok: true, detail: `账号已自动创建（${account}）` };
  // 并发/已存在等语义差异：创建失败后再查一次，存在即算成功
  const recheck = await adminFetch(`${base}/api/v1/admin/accounts`, rootKey, 'GET', undefined, timeoutMs);
  if (recheck.ok) return { ok: true, detail: '账号已存在（自动创建返回异常但复查命中）' };
  return {
    ok: false,
    detail: `自动创建失败（HTTP ${created.status}${created.error ? ` ${created.error}` : ''}）；请核对 config.yaml 的 memory.account 是否与服务端一致`,
  };
}

/** 单个 bot 的 user key 签发（三级回退，消灭 409 死循环）：
 *  ① POST 创建（首启路径）② 409 已存在 → POST /users/{uid}/key 重签（旧 key 立即失效）
 *  ③ 重签失败 → GET /users 列表回读明文 api_key（api_key 模式列表可回带，实测确认）
 *  seed 仍随创建请求带上（未来服务端若实现确定性签发即天然幂等），当前版本被忽略也无害 */
async function signOneUserKey(
  base: string, account: string, appId: string, rootKey: string, timeoutMs: number,
): Promise<{ userKey?: string; error?: string }> {
  const usersBase = `${base}/api/v1/admin/accounts/${encodeURIComponent(account)}/users`;
  const seed = createHash('sha256').update(`${appId}:${rootKey}`).digest('hex').slice(0, 32);
  const created = await adminFetch(usersBase, rootKey, 'POST', { user_id: appId, role: 'user', seed }, timeoutMs);
  if (created.ok) {
    const key = created.result?.user_key;
    if (typeof key === 'string' && key) return { userKey: key };
    return { error: '创建成功但响应未带 user_key（服务端 should_expose_user_key=false？）' };
  }
  if (created.status === 409) {
    const re = await adminFetch(`${usersBase}/${encodeURIComponent(appId)}/key`, rootKey, 'POST', undefined, timeoutMs);
    if (re.ok) {
      const key = re.result?.user_key;
      if (typeof key === 'string' && key) return { userKey: key };
    }
    const listed = await adminFetch(usersBase, rootKey, 'GET', undefined, timeoutMs);
    const users = Array.isArray(listed.result) ? listed.result as Array<{ user_id?: string; api_key?: string }> : [];
    const hit = users.find((u) => u?.user_id === appId);
    if (hit && typeof hit.api_key === 'string' && hit.api_key) return { userKey: hit.api_key };
    return {
      error: `用户已存在但重签与回读均失败（重签 HTTP ${re.status}${re.error ? ` ${re.error}` : ''}；`
        + `列表 ${listed.status}${listed.error ? ` ${listed.error}` : ''}）——请到配置页「用户与密钥」重置该用户密钥`,
    };
  }
  if (created.status === 404) {
    return { error: `HTTP 404（${created.error ?? 'Account or user not found'}）——请核对 config.yaml 的 memory.account 与服务端账号是否一致` };
  }
  return { error: `签发失败：HTTP ${created.status}${created.error ? `（${created.error}）` : ''}` };
}
