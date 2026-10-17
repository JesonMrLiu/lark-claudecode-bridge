// 配置页密码与自动锁屏（服务端单源）。
// - 密文落盘：webauth.json 只存 salt + md5(salt+密码)，永不存明文——满足「保存到文件中的
//   用户密码必须是密文」；盐随机生成，防彩虹表反查默认密码。
// - 默认密码 123456；isDefault 现场判定（hash === md5(salt+'123456')），不落布尔位免得漂移。
// - 文件随读随校验（不缓存）：lcb reset-password 改完盘，运行中的配置页下次校验立即生效。
// - 会话令牌：随机 32 字节 hex，进程内存表；滑动过期 = 锁屏时长（0=永不，按 30 天兜底），
//   进程重启即全体失效（与「每次进页都要输密码」的产品语义一致）。
// - 登录限速：同 IP 连续错 5 次锁 30 秒，拖慢内网暴力试密码。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认密码（恢复初始密码即回到它；登录后引导修改） */
export const DEFAULT_PASSWORD = '123456';
/** 无操作自动锁屏时长（分钟）：默认 30 小时；0 = 永不锁屏 */
export const LOCK_MINUTES_DEFAULT = 1800;
/** 设置弹窗提供的档位（前端下拉同源） */
export const LOCK_MINUTES_OPTIONS = [30, 60, 240, 1440, 1800, 0] as const;
/** 「永不锁屏」时会话过期兜底：30 天（绝对上限，防令牌永久有效） */
const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** 登录限速参数：连续失败阈值 / 冷却时长 */
const THROTTLE_MAX_FAILS = 5;
const THROTTLE_COOLDOWN_MS = 30_000;

/** 会话 cookie 名（HttpOnly + SameSite=Strict；局域网 http 场景不开 Secure） */
export const SESSION_COOKIE = 'lcb_session';

interface WebAuthFile {
  v: 1;
  salt: string;
  hash: string;
  lock_minutes: number;
}

export interface AuthMeta {
  isDefault: boolean;
  lockMinutes: number;
}

export type AuthResult = { ok: true } | { ok: false; error: string };

export const webAuthPathFor = (configPath: string): string => join(dirname(configPath), 'webauth.json');

const md5hex = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

/** 原子写（tmp + rename，带 pid 后缀防并发竞态）——与 server.ts/claude-profile 同款防半截文件 */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/** 读认证文件；缺失/损坏时按默认密码重建（默认密码场景重建即修复，属预期自愈） */
function loadAuthFile(configPath: string): WebAuthFile {
  const p = webAuthPathFor(configPath);
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<WebAuthFile>;
      if (typeof raw.salt === 'string' && typeof raw.hash === 'string' && raw.salt && raw.hash) {
        const lm = Number(raw.lock_minutes);
        return {
          v: 1,
          salt: raw.salt,
          hash: raw.hash,
          lock_minutes: Number.isFinite(lm) && lm >= 0 && lm <= 525_600 ? lm : LOCK_MINUTES_DEFAULT,
        };
      }
    } catch { /* 损坏：走下方重建 */ }
  }
  const fresh: WebAuthFile = {
    v: 1,
    salt: randomBytes(16).toString('hex'),
    hash: '',
    lock_minutes: LOCK_MINUTES_DEFAULT,
  };
  fresh.hash = md5hex(fresh.salt + DEFAULT_PASSWORD);
  writeAtomic(p, JSON.stringify(fresh, null, 2));
  return fresh;
}

function saveAuthFile(configPath: string, file: WebAuthFile): void {
  writeAtomic(webAuthPathFor(configPath), JSON.stringify(file, null, 2));
}

export function authMeta(configPath: string): AuthMeta {
  const f = loadAuthFile(configPath);
  return { isDefault: f.hash === md5hex(f.salt + DEFAULT_PASSWORD), lockMinutes: f.lock_minutes };
}

export function verifyPassword(configPath: string, password: string): boolean {
  const f = loadAuthFile(configPath);
  return typeof password === 'string' && password.length > 0 && md5hex(f.salt + password) === f.hash;
}

/** 修改密码：验旧密码；新密码 ≥6 位且不得是默认密码（防止改回 123456 让引导死循环） */
export function changePassword(configPath: string, oldPwd: string, newPwd: string): AuthResult {
  if (!verifyPassword(configPath, oldPwd)) return { ok: false, error: '当前密码不正确' };
  if (typeof newPwd !== 'string' || newPwd.length < 6) return { ok: false, error: '新密码至少 6 位' };
  if (newPwd === DEFAULT_PASSWORD) return { ok: false, error: `新密码不能是默认密码 ${DEFAULT_PASSWORD}` };
  const f = loadAuthFile(configPath);
  f.salt = randomBytes(16).toString('hex'); // 换密码同时换盐
  f.hash = md5hex(f.salt + newPwd);
  saveAuthFile(configPath, f);
  return { ok: true };
}

/** 恢复初始密码 123456（忘记密码兜底）：换盐重写；锁屏时长保留不动 */
export function resetPasswordToDefault(configPath: string): AuthResult {
  const f = loadAuthFile(configPath);
  f.salt = randomBytes(16).toString('hex');
  f.hash = md5hex(f.salt + DEFAULT_PASSWORD);
  saveAuthFile(configPath, f);
  return { ok: true };
}

export function setLockMinutes(configPath: string, minutes: number): AuthResult {
  const n = Number(minutes);
  if (!Number.isInteger(n) || n < 0 || n > 525_600) {
    return { ok: false, error: '锁屏时长必须为 0-525600 的整数分钟（0 = 永不）' };
  }
  const f = loadAuthFile(configPath);
  f.lock_minutes = n;
  saveAuthFile(configPath, f);
  return { ok: true };
}

/** 会话 TTL（毫秒）：锁屏分钟数；0=永不 → 30 天兜底 */
export function sessionTtlMs(lockMinutes: number): number {
  return lockMinutes > 0 ? lockMinutes * 60_000 : SESSION_MAX_MS;
}

// ---- 会话表（进程内存）：token → 过期时刻 ----
const sessions = new Map<string, number>();

export function createSession(lockMinutes: number): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + sessionTtlMs(lockMinutes));
  return token;
}

/** 校验 + 滑动续期：每个鉴权请求都调（TTL 取当前锁屏设置，改设置即刻约束既有会话） */
export function touchSession(token: string, lockMinutes: number): boolean {
  const exp = token ? sessions.get(token) : undefined;
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + sessionTtlMs(lockMinutes));
  return true;
}

export function dropSession(token: string): void {
  if (token) sessions.delete(token);
}

/** 改密/恢复初始后吊销其余会话（其他标签页需重新输密码；当前会话保留） */
export function dropOtherSessions(keepToken: string): void {
  for (const token of sessions.keys()) {
    if (token !== keepToken) sessions.delete(token);
  }
}

export function sessionCookie(token: string, lockMinutes: number): string {
  const maxAge = Math.floor(sessionTtlMs(lockMinutes) / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export const clearSessionCookie = (): string => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

/** 从 Cookie 头取会话令牌（无/格式异常 → 空串） */
export function readSessionToken(cookieHeader: string | undefined): string {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) return part.slice(idx + 1).trim();
  }
  return '';
}

// ---- 登录限速（进程内存）：ip → { 失败数, 冷却截止 } ----
const failLog = new Map<string, { fails: number; blockedUntil: number }>();

export function authThrottleState(ip: string): { blocked: boolean; retryAfter: number } {
  const e = failLog.get(ip);
  if (!e) return { blocked: false, retryAfter: 0 };
  const wait = e.blockedUntil - Date.now();
  return wait > 0 ? { blocked: true, retryAfter: Math.ceil(wait / 1000) } : { blocked: false, retryAfter: 0 };
}

export function registerAuthFailure(ip: string): void {
  const e = failLog.get(ip) ?? { fails: 0, blockedUntil: 0 };
  e.fails += 1;
  if (e.fails >= THROTTLE_MAX_FAILS) {
    e.blockedUntil = Date.now() + THROTTLE_COOLDOWN_MS;
    e.fails = 0;
  }
  failLog.set(ip, e);
}

export function clearAuthFailures(ip: string): void {
  failLog.delete(ip);
}
