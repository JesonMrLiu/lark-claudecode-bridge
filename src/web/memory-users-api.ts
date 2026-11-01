// 「用户与密钥」Tab 后端（记忆系统最终方案 v1.1 §六 Tab2 / §三 决策 2·4·5）：Admin API 用户
// 聚合 + 密钥保险库 + 审计留痕。
//
// 身份模型（OpenViking 0.5.0 源码实证，见方案附录）：key = base64url(account).base64url(user).
// base64url(secret)，一把 key 天然绑定一个固定身份；api_key 模式下声明头被服务端静默删除，
// 身份只认 key。Admin API（X-API-Key 携 root key）：
// - GET  /api/v1/admin/accounts/{account}/users        → 列表（api_key 模式下明文回带 api_key，
//   server/auth/__init__.py should_expose_user_key：trusted 模式才隐藏——LCB 的保险库可自愈回读）
// - POST /api/v1/admin/accounts/{account}/users        → 创建即返回 user_key（仅此响应出现）
// - POST /api/v1/admin/accounts/{account}/users/{uid}/key → Regenerate（旧 key 立即失效）
// - DELETE /api/v1/admin/accounts/{account}/users/{uid}   → 202 异步清理（LCB 先备份再删）
//
// 安全边界（方案 §六 / §七）：
// - 密钥明文只在本进程与 Admin API 间流转；落盘一律 DPAPI 加密（Windows CurrentUser 域绑定，
//   PowerShell stdin 传 base64，明文不上命令行——进程列表不可见）；
// - 浏览器只见脱敏提示；reveal（打开记忆空间 / 复制 key）单次放行并留痕；
// - 每次查看/重置/删除/初始化行为写审计日志（JSONL 追加）；
// - 删除动作备份前置：打包 user 目录（明文数据可直接 tar/zip）到 backups/ 再调 Admin 删除。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { BridgeConfig, MemoryConfig } from '../types.js';
import { MANAGED_OV_CONF, MEMORY_MANAGED_DIR } from '../memory-installer.js';
import { DEFAULT_MEMORY_ACCOUNT, WEB_USER_ID, DEFAULT_MEMORY_UID, isValidUserId, memoryAccount, memoryEndpoint, ensureRemoteAccount, probeMemoryHealth, resolveMemoryUid } from '../memory.js';
import { maskSecret } from './config-api.js';

/** 网页管理端用户约定 uid（方案 §四 阶段 3：{"user_id":"web"}）——定义移至 memory.ts
 *  （resolveMemoryUid 的管理面守卫单源），此处 re-export 保持既有引用路径不变 */
export { WEB_USER_ID };
/** 密钥保险库（uid → base64(DPAPI(plain))；DPAPI CurrentUser 域绑定，换机/换账户不可解密） */
const VAULT_FILE = join(MEMORY_MANAGED_DIR, 'user-keys.vault.json');
/** 审计日志（JSONL 追加；查看/重置/删除/初始化留痕，方案 §六「管理员每次查看行为留痕」） */
export const MEMORY_AUDIT_LOG = join(MEMORY_MANAGED_DIR, 'audit.log');
/** 删除前备份目录（先备份后删除，方案 §六/§七「清理动作必须二次确认 + 先备份」） */
export const MEMORY_BACKUP_DIR = join(MEMORY_MANAGED_DIR, 'backups');

/** user_id 合法性（路径安全 + OpenViking uid 口径）：单源在 ../memory.js（config.ts 加载层
 *  校验 identityMap 同口径），此处 re-export 保持既有引用路径不变 */
export { isValidUserId };

// ============ 审计留痕 ============

/** 审计写一条（JSONL；失败静默——留痕不可用不应阻断管理动作本身） */
export function auditMemory(action: string, detail: Record<string, unknown> = {}): void {
  try {
    mkdirSync(MEMORY_MANAGED_DIR, { recursive: true });
    appendFileSync(MEMORY_AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), action, ...detail }) + '\n', 'utf8');
  } catch { /* 留痕失败不阻断 */ }
}

// ============ root key 解析 ============

/** 读受管 ov.conf 的 server.root_api_key（memory.api_key 未配置时的兜底——一键安装写 conf 后
 *  config.yaml 回写中断等场景，root key 仍在 conf 里可自愈） */
function managedRootKey(): string | undefined {
  try {
    const doc = JSON.parse(readFileSync(MANAGED_OV_CONF, 'utf8')) as { server?: { root_api_key?: string } };
    return doc.server?.root_api_key || undefined;
  } catch { return undefined; }
}

/** Admin API 用的 root key：config.memory.api_key 优先，受管 conf 兜底 */
function resolveRootKey(memory: MemoryConfig | undefined): string | undefined {
  return memory?.apiKey?.trim() || managedRootKey();
}

// ============ Admin API 基础 ============

interface AdminCall { ok: boolean; status: number; json: Record<string, unknown>; message?: string }

/** Admin API 调用（X-API-Key 携 root key；10s 超时——管理面动作不拖页面）。root key 只进本进程 */
async function adminCall(memory: MemoryConfig, rootKey: string, method: string, path: string, body?: unknown): Promise<AdminCall> {
  const base = memoryEndpoint(memory).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'X-API-Key': rootKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // 错误文案：OpenViking 错误体为 {error:{code,message}}，顶层 message 形态只在旧版本出现——
    // 只读顶层 message 时，所有 404 都退化成裸「HTTP 404」（账号名写错的真因就此隐身）
    const errObj = json.error && typeof json.error === 'object' ? json.error as Record<string, unknown> : undefined;
    const code = typeof errObj?.code === 'string' ? errObj.code : undefined;
    const msg = (typeof errObj?.message === 'string' ? errObj.message : undefined)
      ?? (typeof json.error === 'string' ? json.error : undefined)
      ?? (typeof json.message === 'string' ? json.message : undefined);
    return { ok: res.ok, status: res.status, json, ...(msg ? { message: code ? `${code}: ${msg}` : msg } : {}) };
  } catch (e) {
    return { ok: false, status: 0, json: {}, message: e instanceof Error ? e.message : String(e) };
  }
}

const adminPath = (memory: MemoryConfig, suffix: string): string =>
  `/api/v1/admin/accounts/${encodeURIComponent(memoryAccount(memory))}${suffix}`;

// ============ 密钥保险库（DPAPI 加密落盘） ============

type VaultDoc = Record<string, string>;

function loadVault(path: string = VAULT_FILE): VaultDoc {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc as VaultDoc : {};
  } catch { return {}; }
}

/** 原子写（tmp + rename；与 memory-installer writeAtomic 同款，独立内联避免反向依赖） */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

function saveVault(v: VaultDoc, path: string = VAULT_FILE): void {
  writeAtomic(path, JSON.stringify(v, null, 2));
}

function removeVaultEntry(uid: string): void {
  const v = loadVault();
  if (!(uid in v)) return;
  delete v[uid];
  saveVault(v);
}

/** DPAPI protect/unprotect（PowerShell stdin 收发 base64——明文不上命令行，进程列表不可见；
 *  CurrentUser 域绑定 = 同机同账户可解，符合「机器绑定加密」约束）。非 Windows 返回 null（调用方降级） */
function dpapi(mode: 'protect' | 'unprotect', b64: string): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const script = mode === 'protect'
    ? `Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))`
    : `Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($u))`;
  return new Promise((resolve) => {
    try {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { try { p.kill(); } catch { /* 已退出 */ } resolve(null); }, 15_000);
      p.stdout.on('data', (d) => { out += String(d); });
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('error', () => { clearTimeout(timer); resolve(null); });
      p.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 && out.trim() ? out.trim() : null);
        if (code !== 0) console.warn(`[memory-users] DPAPI ${mode} 失败（退出码 ${code}）：${err.trim().slice(0, 200)}`);
      });
      p.stdin.write(b64);
      p.stdin.end();
    } catch { resolve(null); }
  });
}

/** 密钥入保险库：Windows DPAPI 加密；其他平台降级 base64 混淆 + 控制台明示（方案适用面为 Windows）。
 *  明文进程内缓存：列表每次聚合都会回带 api_key——值未变时跳过 DPAPI 重加密（省一次 PowerShell 进程） */
const vaultSeenPlain = new Map<string, string>();

/** 保险库写队列：所有写入全局串行——并发 vaultStore（启动签发多 uid 同时刷新）各自先读
 *  快照、DPAPI 加密（秒级 await）后整份写回，会互相用**过期快照**覆盖（经典 lost update，
 *  实测把刚写入的新 key 回滚成旧 key → 配置页复制出死 key → Studio 401）。单飞队列保证写-写互斥 */
let vaultQueue: Promise<void> = Promise.resolve();

/** 密钥入保险库（exported）：index.ts 启动/热重载签发链路（refreshMemoryKeys）成功拿到 key 后
 *  按 uid 同步刷新，消灭「key 轮转后保险库留旧 key → 配置页/Studio 复制即 401、须等
 *  「用户与密钥」Tab 列表自愈」的窗口。
 *  写入在全局队列内串行执行，且 DPAPI await 之后**重读磁盘最新内容**再合并写入——双保险
 *  消灭并发丢更新。dirOverride 供单测注入临时目录 */
export function vaultStore(uid: string, plain: string, dirOverride?: string): Promise<void> {
  const vaultPath = dirOverride ? join(dirOverride, 'user-keys.vault.json') : VAULT_FILE;
  const run = vaultQueue.then(async () => {
    if (vaultSeenPlain.get(uid) === plain && loadVault(vaultPath)[uid]) return;
    const apply = (value: string): void => {
      const fresh = loadVault(vaultPath); // await 之后重读：合并并发期间他人写入，绝不整份回写旧快照
      fresh[uid] = value;
      saveVault(fresh, vaultPath);
      vaultSeenPlain.set(uid, plain);
    };
    if (process.platform === 'win32') {
      const b64 = Buffer.from(plain, 'utf8').toString('base64');
      const sealed = await dpapi('protect', b64);
      if (sealed) { apply(sealed); return; }
      console.warn('[memory-users] DPAPI 保护失败，降级 base64 混淆存储（建议检查 PowerShell 可用性）');
      apply(`plain:${b64}`);
    } else {
      apply(`plain:${Buffer.from(plain, 'utf8').toString('base64')}`);
    }
  });
  vaultQueue = run.catch(() => { /* 单次写失败不阻塞队列中的后续写（错误已向上传播给调用方） */ });
  return run;
}

/** 取密钥明文（reveal / 打开记忆空间用；解不开返回 undefined） */
async function vaultRead(uid: string): Promise<string | undefined> {
  const sealed = loadVault()[uid];
  if (!sealed) return undefined;
  if (sealed.startsWith('plain:')) {
    try { return Buffer.from(sealed.slice(6), 'base64').toString('utf8'); } catch { return undefined; }
  }
  const b64 = await dpapi('unprotect', sealed);
  if (!b64) return undefined;
  try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return undefined; }
}

// ============ 磁盘元信息（体量 / 最近活跃） ============

/** user 目录（方案 §五-P3：data/viking/<account>/user/<uid>/ 为明文，可直接统计/打包） */
export function memoryUserDir(account: string, uid: string): string {
  return join(MEMORY_MANAGED_DIR, 'data', 'viking', account, 'user', uid);
}

/** 递归统计目录体量与最近修改（容错：目录不存在/单文件 stat 失败均按 0 继续） */
function dirStats(dir: string): { sizeBytes: number; lastActive?: string } {
  let size = 0;
  let last = 0;
  const walk = (d: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const st = statSync(p);
          size += st.size;
          if (st.mtimeMs > last) last = st.mtimeMs;
        } catch { /* 竞态删除/权限：跳过该文件 */ }
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { sizeBytes: size, ...(last ? { lastActive: new Date(last).toISOString() } : {}) };
}

// ============ 用户列表（元信息聚合） ============

export interface MemoryUserRow {
  userId: string;
  /** web=网页管理端；bot=机器人（config.apps 命中）；other=其他/历史用户 */
  kind: 'web' | 'bot' | 'other';
  /** bot 行对应的机器人名（config.apps 按 appId 映射） */
  appName?: string;
  role?: string;
  /** 服务端列表是否回带了 api_key（api_key 模式=true；Argon2 哈希存储等场景=false） */
  keyAvailable: boolean;
  /** 脱敏提示（••••xxxx；keyAvailable 时必有） */
  keyHint?: string;
  /** 本地记忆体量（data/viking/... 明文目录递归统计） */
  sizeBytes?: number;
  /** 最近活跃（目录最大 mtime；无数据缺省） */
  lastActive?: string;
}

export interface MemoryUsersSnapshot {
  reachable: boolean;
  error?: string;
  /** 服务鉴权模式（dev 模式下 Admin API 不可用——Tab 显示「无需用户密钥」说明而非报错） */
  authMode?: string;
  users: MemoryUserRow[];
  totalBytes: number;
  /** 待初始化鉴权（方案 §六 配套细节 2：服务 api_key 模式但 web 用户不存在） */
  authInitNeeded: boolean;
  /**
   * Root 密钥状态（**只报存在性与来源，不含明文**）：OpenViking Studio 登录框要的
   * 「Root 或账号管理员 API 密钥」此前在页面上没有任何线索，用户只能自己翻 ov.conf 或误填模型
   * API Key。页面据此显示「已配置（来源：…）」并给出复制按钮，把「填哪个」讲死。
   */
  rootKey?: { configured: boolean; source: 'config' | 'ov-conf' | 'missing' };
}

/** Root 密钥状态（供快照携带；明文一律不放行，见 MemoryUsersSnapshot.rootKey） */
function rootKeyStatus(memory: MemoryConfig | undefined): NonNullable<MemoryUsersSnapshot['rootKey']> {
  if (!memory) return { configured: false, source: 'missing' };
  if (memory.apiKey?.trim()) return { configured: true, source: 'config' };
  if (managedRootKey()) return { configured: true, source: 'ov-conf' };
  return { configured: false, source: 'missing' };
}

/** 用户列表聚合：Admin API + 本地磁盘统计。全程容错（服务不可达返回可达性标记，不抛出） */
export async function listMemoryUsers(config: BridgeConfig): Promise<MemoryUsersSnapshot> {
  const memory = config.memory;
  const account = memory ? memoryAccount(memory) : DEFAULT_MEMORY_ACCOUNT;
  const empty: MemoryUsersSnapshot = { reachable: false, users: [], totalBytes: 0, authInitNeeded: false };
  if (!memory) return { ...empty, error: 'memory 段未配置', rootKey: rootKeyStatus(undefined) };
  const health = await probeMemoryHealth(memoryEndpoint(memory));
  if (!health.healthy) return { ...empty, error: health.detail ?? '服务不可达', rootKey: rootKeyStatus(memory), ...(health.authMode ? { authMode: health.authMode } : {}) };
  if (health.authMode !== 'api_key') {
    // dev 模式：Admin API 被服务端禁用（403）——这是「无需用户密钥」的正常形态而非错误
    return { reachable: true, authMode: health.authMode, users: [], totalBytes: 0, authInitNeeded: false, rootKey: rootKeyStatus(memory) };
  }
  const rootKey = resolveRootKey(memory);
  if (!rootKey) return { ...empty, authMode: health.authMode, rootKey: rootKeyStatus(memory), error: 'root key 未配置（memory.api_key 与受管 ov.conf 均未见）——请先「检查修复」对齐鉴权' };
  const r = await adminCall(memory, rootKey, 'GET', adminPath(memory, '/users'));
  if (!r.ok) {
    return { ...empty, authMode: health.authMode, rootKey: rootKeyStatus(memory), error: `用户列表获取失败：HTTP ${r.status}${r.message ? `（${r.message}）` : ''}` };
  }
  const rawUsers = (Array.isArray(r.json.result) ? r.json.result : []) as Array<{ user_id?: string; role?: string; api_key?: string }>;
  const botNames = new Map(config.apps.map((a) => [a.appId, a.name] as const));
  // 机器人侧生效身份集合（缺省共享 main / 显式映射 uid）：命中即算 bot 身份——
  // 缺省口径下所有 bot 收敛到同一个 uid，不能再按「uid===appId」判断归属
  const botUids = new Set(config.apps.map((a) => (config.memory ? resolveMemoryUid(config.memory, a.appId) : DEFAULT_MEMORY_UID)));
  const rows: MemoryUserRow[] = [];
  for (const u of rawUsers) {
    const uid = String(u.user_id ?? '');
    if (!uid) continue;
    // 保险库自愈：列表明文回带的 api_key 刷入保险库（DPAPI 重加密）——重装/换 Key 后无须重初始化
    if (typeof u.api_key === 'string' && u.api_key) await vaultStore(uid, u.api_key);
    const kind: MemoryUserRow['kind'] = uid === WEB_USER_ID ? 'web' : botNames.has(uid) || botUids.has(uid) ? 'bot' : 'other';
    // 聊天者维度（历史复合 ID：{appId}-{ou_xxx}，插件旧口径创建）：前缀归属到对应飞书应用，
    // 页面显示「<应用名> · 聊天者」——OpenViking 无显示名字段（user_id 仅 ASCII），1933 右上角
    // 只能显示技术 ID，人可读对照以本列表为准
    const ownerBot = kind === 'other'
      ? [...botNames.entries()].find(([appId]) => uid.startsWith(`${appId}-`))
      : undefined;
    const stats = dirStats(memoryUserDir(account, uid));
    rows.push({
      userId: uid,
      kind,
      ...(kind === 'bot' ? { appName: botNames.get(uid) } : ownerBot ? { appName: `${ownerBot[1]} · 聊天者` } : {}),
      ...(u.role ? { role: u.role } : {}),
      keyAvailable: typeof u.api_key === 'string' && !!u.api_key,
      ...(typeof u.api_key === 'string' && u.api_key ? { keyHint: maskSecret(u.api_key).secretHint } : {}),
      sizeBytes: stats.sizeBytes,
      ...(stats.lastActive ? { lastActive: stats.lastActive } : {}),
    });
  }
  return {
    reachable: true,
    authMode: health.authMode,
    users: rows,
    totalBytes: rows.reduce((s, r2) => s + (r2.sizeBytes ?? 0), 0),
    // 待初始化：api_key 模式跑着但网页端用户还没建（浏览器打开 1933 会 401 重定向的根因）
    authInitNeeded: !rows.some((x) => x.userId === WEB_USER_ID),
    rootKey: rootKeyStatus(memory),
  };
}

// ============ 一键初始化 ============

export interface InitOutcome {
  ok: boolean;
  created: string[];
  existing: string[];
  errors: string[];
  detail: string;
}

/** 一键初始化（方案 §六：建 web 用户 + 各 bot 生效身份用户（缺省共享 main）→ 签 key → 加密落盘）。幂等可重跑：
 *  已存在用户由列表自愈回读 key（创建响应的 user_key 只出现一次，但 api_key 模式列表可回带）。
 *  dev 模式 / 服务不可达：直接说明，不视为失败动作。 */
export async function initMemoryUsers(config: BridgeConfig): Promise<InitOutcome> {
  const memory = config.memory;
  const out: InitOutcome = { ok: false, created: [], existing: [], errors: [], detail: '' };
  if (!memory) return { ...out, errors: ['memory 段未配置'], detail: '请先开启记忆增强并保存模型配置' };
  const health = await probeMemoryHealth(memoryEndpoint(memory));
  if (!health.healthy) return { ...out, errors: [`服务不可达（${health.detail ?? '未知原因'}）`], detail: '请先在「服务与配置」拉起服务，再一键初始化' };
  if (health.authMode !== 'api_key') {
    return {
      ...out, ok: true,
      detail: `服务为 ${health.authMode ?? '未知'} 模式：本机回环免鉴权、身份经命名空间隔离，无须创建用户密钥（部署走向 api_key 模式后再初始化）`,
    };
  }
  const rootKey = resolveRootKey(memory);
  if (!rootKey) return { ...out, errors: ['root key 未配置'], detail: '「检查修复」可对齐 memory.api_key 与受管 ov.conf' };
  // 账号兜底：服务端只认已存在账号，账号不存在时下面每个用户都会 404（历史上表现为
  // 「创建 xxx 失败：HTTP 404」全红，用户无从判断是账号问题还是服务没起）→ 缺账号先自动建
  const account = memoryAccount(memory);
  const accountReady = await ensureRemoteAccount(memoryEndpoint(memory).replace(/\/+$/, ''), account, rootKey);
  if (!accountReady.ok) {
    return {
      ...out,
      errors: [`记忆账号「${account}」不可用：${accountReady.detail}`],
      detail: '请核对 config.yaml 的 memory.account（缺省 default）是否与服务端账号一致',
    };
  }
  // 期望用户：web + 各 bot 解析后的生效身份去重（缺省全体 bot 收敛到共享 main——不再按 appId
  // 每应用建一个用户；显式映射的 uid 同样在此列，与 ensureMemoryUserKeys 签发口径一致）
  const desired = [WEB_USER_ID, ...new Set(config.apps.map((a) => resolveMemoryUid(memory, a.appId)))];
  // 先列表自愈：已存在用户的 key 直接刷保险库（避免对已存在用户重复创建撞 409）
  const listR = await adminCall(memory, rootKey, 'GET', adminPath(memory, '/users'));
  const known = new Set<string>();
  if (listR.ok && Array.isArray(listR.json.result)) {
    for (const u of listR.json.result as Array<{ user_id?: string; api_key?: string }>) {
      const uid = String(u.user_id ?? '');
      if (uid) known.add(uid);
      if (uid && typeof u.api_key === 'string' && u.api_key) await vaultStore(uid, u.api_key);
    }
  }
  for (const uid of desired) {
    if (!isValidUserId(uid)) { out.errors.push(`用户名 ${uid} 含非法字符，跳过`); continue; }
    if (known.has(uid)) { out.existing.push(uid); continue; }
    const r = await adminCall(memory, rootKey, 'POST', adminPath(memory, '/users'), { user_id: uid, role: 'user' });
    const result = (r.json.result ?? {}) as { user_key?: string };
    if (r.ok && typeof result.user_key === 'string' && result.user_key) {
      await vaultStore(uid, result.user_key);
      out.created.push(uid);
    } else if (r.ok) {
      // 创建成功但响应未带 key（should_expose_user_key=false 等服务端形态）→ 列表自愈兜底
      out.created.push(uid);
      out.errors.push(`${uid} 已创建但响应未含密钥——已尝试从用户列表回读`);
    } else {
      const why = r.message ? `（${r.message}）` : '';
      const hint = r.status === 404
        ? '——服务端不存在该账号或用户，请核对 config.yaml 的 memory.account（缺省 default）'
        : r.status === 409 ? '（用户已存在，可直接「重置密钥」）' : '';
      out.errors.push(`创建 ${uid} 失败：HTTP ${r.status}${why}${hint}`);
    }
  }
  out.ok = out.errors.length === 0;
  out.detail = `初始化完成：新建 ${out.created.length ? out.created.join('、') : '无'}；已存在 ${out.existing.length ? out.existing.join('、') : '无'}${out.errors.length ? `；${out.errors.length} 项异常` : ''}`;
  auditMemory('init', { created: out.created, existing: out.existing, errors: out.errors });
  return out;
}

// ============ 新建用户（配置页弹窗：Admin API 创建 + 密钥入保险库） ============

export interface CreateUserOutcome { ok: boolean; error?: string; uid?: string }

/**
 * 新建 OpenViking 用户（「用户与密钥」Tab 弹窗；配合 identityMap 关联即形成共享记忆身份）。
 * - dev 模式：Admin API 被服务端禁用且本机回环免鉴权——无须用户密钥，直接说明而非报错
 * - 保留名：web（LCB 启动自动签发，删后重启自愈）与 default（管理员）不接受手工创建
 * - 创建成功后把响应里的 user_key 刷入保险库（与 init 同款；响应未带 key 时由列表自愈回读兜底）
 * - 显示名称不在此持久化：displayNames 走配置 doc 管道（前端 saveDoc），与本接口解耦
 */
export async function createMemoryUser(config: BridgeConfig, userId: string): Promise<CreateUserOutcome> {
  const uid = userId.trim();
  if (!isValidUserId(uid)) return { ok: false, error: '用户 ID 非法：仅字母/数字/_ . @ -，长度 1–128' };
  if (uid === WEB_USER_ID || uid === DEFAULT_MEMORY_ACCOUNT) return { ok: false, error: `${uid} 为保留名（LCB 自动管理/管理员），请换一个 ID` };
  const memory = config.memory;
  if (!memory) return { ok: false, error: 'memory 段未配置' };
  const health = await probeMemoryHealth(memoryEndpoint(memory));
  if (!health.healthy) return { ok: false, error: `服务不可达（${health.detail ?? '未知原因'}）——请先在「服务与配置」拉起服务` };
  if (health.authMode !== 'api_key') {
    return { ok: false, error: `服务为 ${health.authMode ?? '未知'} 模式：本机回环免鉴权、身份经命名空间隔离，无须创建用户密钥` };
  }
  const rootKey = resolveRootKey(memory);
  if (!rootKey) return { ok: false, error: 'root key 未配置——请先「检查修复」对齐鉴权' };
  const account = memoryAccount(memory);
  const accountReady = await ensureRemoteAccount(memoryEndpoint(memory).replace(/\/+$/, ''), account, rootKey);
  if (!accountReady.ok) return { ok: false, error: `记忆账号「${account}」不可用：${accountReady.detail}` };
  const r = await adminCall(memory, rootKey, 'POST', adminPath(memory, '/users'), { user_id: uid, role: 'user' });
  if (!r.ok) {
    auditMemory('create-fail', { user_id: uid, status: r.status });
    const hint = r.status === 409 ? '（用户已存在）'
      : r.status === 404 ? '——服务端不存在该账号，请核对 memory.account（缺省 default）' : '';
    return { ok: false, error: `创建失败：HTTP ${r.status}${r.message ? `（${r.message}）` : ''}${hint}` };
  }
  const result = (r.json.result ?? {}) as { user_key?: string };
  if (typeof result.user_key === 'string' && result.user_key) await vaultStore(uid, result.user_key);
  auditMemory('create', { user_id: uid });
  return { ok: true, uid };
}

// ============ 密钥明文放行（reveal / 复制 / 打开记忆空间共用） ============

// ============ Root 密钥放行（OpenViking Studio 登录用） ============

export interface RevealRootResult {
  ok: boolean;
  key?: string;
  /** 取值来源：config=config.yaml 的 memory.api_key；ov-conf=受管 ov.conf 的 server.root_api_key */
  source?: 'config' | 'ov-conf';
  /** 拿这把 key 实打服务端的校验结果（避免用户拷了把错的去 Studio 里 debug） */
  valid?: boolean;
  /** 校验失败原因（如 HTTP 401：key 与服务端不匹配） */
  validDetail?: string;
  error?: string;
}

/**
 * 取 Root 密钥明文（单次放行 + 审计留痕）——**给 OpenViking Studio 的登录框用**。
 * 背景（用户实测卡点）：Studio 首屏要填「Root 或账号管理员 API 密钥」，而 LCB 配置页此前
 * 完全没有 root key 的入口，唯一长得像的「模型配置 → API Key」是智谱模型 key，填进去必然 401。
 * Studio 自己的提示写的是「Root API 密钥位于服务端 ov.conf 的 server.root_api_key」，本页就按
 * 同一口径给出处 + 复制按钮，别让用户自己在磁盘上翻配置文件。
 * 顺带校验：带 key 打一次 /api/v1/system/status（api_key 模式下鉴权通过的证明），把「拷贝即用」
 * 的确定性前置到本页，而不是让用户在 Studio 的报错里猜。
 */
export async function revealRootKey(config: BridgeConfig): Promise<RevealRootResult> {
  const memory = config.memory;
  if (!memory) return { ok: false, error: 'memory 段未配置' };
  const fromConfig = memory.apiKey?.trim();
  const rootKey = resolveRootKey(memory);
  if (!rootKey) {
    return {
      ok: false,
      error: 'Root 密钥未配置：config.yaml 的 memory.api_key 与受管 ov.conf 的 server.root_api_key 均为空。'
        + '请到「服务与配置」点「检查修复」重新生成，或手工把 ov.conf 里的 server.root_api_key 回写到 memory.api_key',
    };
  }
  const source: RevealRootResult['source'] = fromConfig ? 'config' : 'ov-conf';
  auditMemory('reveal-root', { source });
  // 校验：/system/status 在 api_key 模式下带 X-API-Key 通过即有效；dev 模式不校验直接视为有效
  const health = await probeMemoryHealth(memoryEndpoint(memory));
  if (health.authMode && health.authMode !== 'api_key') {
    return { ok: true, key: rootKey, source, valid: true, validDetail: `服务为 ${health.authMode} 模式，Studio 无需密钥` };
  }
  if (!health.healthy) {
    return { ok: true, key: rootKey, source, valid: false, validDetail: `服务不可达，未能校验（${health.detail ?? '未知原因'}）` };
  }
  const r = await adminCall(memory, rootKey, 'GET', '/api/v1/system/status');
  return {
    ok: true,
    key: rootKey,
    source,
    valid: r.ok,
    ...(r.ok ? {} : { validDetail: `校验未通过：HTTP ${r.status}${r.message ? `（${r.message}）` : ''}——这把密钥与服务端不匹配` }),
  };
}

export interface RevealResult { ok: boolean; key?: string; error?: string }

/** 取某用户密钥明文（单次放行 + 审计留痕）。保险库未命中时尝试列表自愈回读（服务端 api_key
 *  模式列表可回带明文），再未命中提示重置。root key / 他人密钥的边界：本接口只服务本机配置页 */
export async function revealUserKey(config: BridgeConfig, uid: string): Promise<RevealResult> {
  if (!isValidUserId(uid)) return { ok: false, error: '用户名非法' };
  const memory = config.memory;
  if (!memory) return { ok: false, error: 'memory 段未配置' };
  const cached = await vaultRead(uid);
  if (cached) {
    auditMemory('reveal', { user_id: uid, source: 'vault' });
    return { ok: true, key: cached };
  }
  // 自愈：服务端列表回读 → 刷保险库
  const rootKey = resolveRootKey(memory);
  if (rootKey) {
    const r = await adminCall(memory, rootKey, 'GET', adminPath(memory, '/users'));
    if (r.ok && Array.isArray(r.json.result)) {
      const hit = (r.json.result as Array<{ user_id?: string; api_key?: string }>).find((u) => String(u.user_id ?? '') === uid);
      if (hit && typeof hit.api_key === 'string' && hit.api_key) {
        await vaultStore(uid, hit.api_key);
        auditMemory('reveal', { user_id: uid, source: 'admin-list' });
        return { ok: true, key: hit.api_key };
      }
    }
  }
  auditMemory('reveal-miss', { user_id: uid });
  return { ok: false, error: '本地保险库无此密钥且服务端未回带——请用「重置」重新签发（旧使用方需同步更新）' };
}

// ============ 重置（Regenerate） ============

/** 密钥轮转监听（LCB wiring 注册）：配置页重置产生新 key 后同步刷新进程内 userKeys 缓存。
 *  不注册/不刷新的后果：LCB 继续向会话下发已作废旧 key 直到重启——用户在配置页「重置自救」
 *  反而加重 401（2026-10-22 真机事故根因之一） */
type UserKeyRotatedListener = (uid: string, newKey: string) => void;
let userKeyRotatedListener: UserKeyRotatedListener | undefined;
export function onUserKeyRotated(fn: UserKeyRotatedListener): void { userKeyRotatedListener = fn; }

/** 重置密钥（Admin Regenerate：旧 key 立即失效，新 key 入保险库 + 联动刷新 LCB 缓存）。
 *  方案 §六：危险操作，前端二次确认 + 提示「所有使用方需同步更新」；此处负责执行与留痕 */
export async function resetUserKey(config: BridgeConfig, uid: string): Promise<RevealResult> {
  if (!isValidUserId(uid)) return { ok: false, error: '用户名非法' };
  const memory = config.memory;
  if (!memory) return { ok: false, error: 'memory 段未配置' };
  const rootKey = resolveRootKey(memory);
  if (!rootKey) return { ok: false, error: 'root key 未配置' };
  const r = await adminCall(memory, rootKey, 'POST', adminPath(memory, `/users/${encodeURIComponent(uid)}/key`), {});
  const result = (r.json.result ?? {}) as { user_key?: string };
  if (r.ok && typeof result.user_key === 'string' && result.user_key) {
    await vaultStore(uid, result.user_key);
    auditMemory('reset', { user_id: uid });
    userKeyRotatedListener?.(uid, result.user_key);
    return { ok: true, key: result.user_key };
  }
  auditMemory('reset-fail', { user_id: uid, status: r.status });
  return { ok: false, error: `重置失败：HTTP ${r.status}${r.message ? `（${r.message}）` : ''}` };
}

// ============ 删除（备份前置） ============

/** 打包目录为压缩档（Windows bsdtar -a 依扩展名产 zip；其他平台 GNU tar 产 tar.gz）。
 *  返回备份文件路径。tar 失败抛错（调用方放弃删除——备份前置是硬约束） */
async function backupUserDir(account: string, uid: string): Promise<string> {
  const srcDir = memoryUserDir(account, uid);
  if (!existsSync(srcDir)) return ''; // 无数据目录（纯密钥用户）：无须备份
  mkdirSync(MEMORY_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const isWin = process.platform === 'win32';
  const archive = join(MEMORY_BACKUP_DIR, `${uid}-${stamp}${isWin ? '.zip' : '.tar.gz'}`);
  const tarCmd = isWin ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const args = isWin ? ['-a', '-c', '-f', archive, '-C', dirname(srcDir), uid] : ['-czf', archive, '-C', dirname(srcDir), uid];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(tarCmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (d) => { err += String(d); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`备份打包失败（退出码 ${code}）：${err.trim().slice(0, 200)}`)));
  });
  if (!existsSync(archive)) throw new Error('备份打包后未找到产物');
  return archive;
}

export interface DeleteOutcome { ok: boolean; detail: string; backupPath?: string }

/** 删除用户：先备份 user 目录到 backups/，再调 Admin 删除（202 异步清理），最后清保险库条目。
 *  方案 §六/§七：二次确认在前端；备份前置在这里是硬约束（备份失败即中止删除） */
export async function deleteMemoryUser(config: BridgeConfig, uid: string): Promise<DeleteOutcome> {
  if (!isValidUserId(uid)) return { ok: false, detail: '用户名非法' };
  const memory = config.memory;
  if (!memory) return { ok: false, detail: 'memory 段未配置' };
  const rootKey = resolveRootKey(memory);
  if (!rootKey) return { ok: false, detail: 'root key 未配置' };
  const account = memoryAccount(memory);
  // 备份前置：打包失败绝不删除（磁盘明文数据是唯一正本）
  let backupPath: string | undefined;
  try {
    const p = await backupUserDir(account, uid);
    if (p) backupPath = p;
  } catch (e) {
    auditMemory('delete-abort', { user_id: uid, reason: e instanceof Error ? e.message : String(e) });
    return { ok: false, detail: `已中止删除——备份失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const r = await adminCall(memory, rootKey, 'DELETE', adminPath(memory, `/users/${encodeURIComponent(uid)}`));
  if (!r.ok && r.status !== 202) {
    auditMemory('delete-fail', { user_id: uid, status: r.status });
    return { ok: false, detail: `删除失败：HTTP ${r.status}${r.message ? `（${r.message}）` : ''}${backupPath ? `；数据备份在 ${backupPath}` : ''}` };
  }
  removeVaultEntry(uid);
  auditMemory('delete', { user_id: uid, ...(backupPath ? { backupPath } : {}) });
  return {
    ok: true,
    detail: `已删除 ${uid}（服务端异步清理数据）${backupPath ? `；数据备份：${backupPath}` : '（该用户无本地记忆数据）'}`,
    ...(backupPath ? { backupPath } : {}),
  };
}

/** 保险库脱敏概览（审计/排障用：只回 uid 与是否在库，绝不回明文） */
export function vaultOverview(): Array<{ userId: string; sealed: boolean }> {
  return Object.entries(loadVault()).map(([userId, sealed]) => ({ userId, sealed: !sealed.startsWith('plain:') }));
}
