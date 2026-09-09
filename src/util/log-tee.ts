// 运行时日志 tee（#7）：把 console.log/warn/error/error 同时落 ~/.lark-claudecode-bridge/logs/bridge-YYYYMMDD.log，
// 跨天自动切换文件，最长保留 14 天。原生 console 行为保留（终端仍可见）；
// lifecycle.ts 不再把 detached 进程的 stdio 重定向到 bridge.log——进程内部 tee 自管日志，
// 避免「终端看不到 + 文件双写」分裂。tee 失败（磁盘满/权限异常）静默降级为 console-only
import { appendFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config.js';

const LOG_DIR = join(CONFIG_DIR, 'logs');
const RETENTION_DAYS = 14;

/** 当前生效的日志文件路径（YYYY-MM-DD，文件名用本地日期避免 UTC 与本地偏移引起的跨天误判） */
function currentLogPath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return join(LOG_DIR, `bridge-${y}-${m}-${day}.log`);
}

let teeInstalled = false;
let activePath = '';
let activeDateKey = '';

/** 单条日志行追加：跨天切换文件路径（按日期），末尾补 \n */
function writeLine(line: string): void {
  const d = new Date();
  const dateKey = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  if (dateKey !== activeDateKey) {
    activeDateKey = dateKey;
    activePath = currentLogPath();
  }
  try {
    appendFileSync(activePath, line + '\n', 'utf8');
  } catch { /* 磁盘满/权限异常：不阻断主流程，console 仍在 */ }
}

/** 序列化 console.args 为单行字符串（对象 JSON 化、Error 走 message） */
function formatArgs(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ?? a.message;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }).join(' ');
}

let origLog: typeof console.log | undefined;
let origWarn: typeof console.warn | undefined;
let origErr: typeof console.error | undefined;

/** 安装 console tee：进程生命周期内仅首次调用生效，后续调用幂等 */
export function installLogTee(): void {
  if (teeInstalled) return;
  if (!existsSync(LOG_DIR)) return; // ensureRuntimeDirs() 未跑（独立测试等场景）——直接跳过
  origLog = console.log.bind(console);
  origWarn = console.warn.bind(console);
  origErr = console.error.bind(console);
  activePath = currentLogPath();
  activeDateKey = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
  console.log = (...args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ${formatArgs(args)}`;
    writeLine(line);
    origLog!(...args);
  };
  console.warn = (...args: unknown[]) => {
    const line = `[${new Date().toISOString()}] [WARN] ${formatArgs(args)}`;
    writeLine(line);
    origWarn!(...args);
  };
  console.error = (...args: unknown[]) => {
    const line = `[${new Date().toISOString()}] [ERROR] ${formatArgs(args)}`;
    writeLine(line);
    origErr!(...args);
  };
  teeInstalled = true;
}

/** 清理 14 天前的旧日志；通常与 installLogTee() 一并调用，进程启动时一次即可 */
export function cleanupOldLogs(): void {
  if (!existsSync(LOG_DIR)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(LOG_DIR)) {
      if (!name.startsWith('bridge-') || !name.endsWith('.log')) continue;
      const p = join(LOG_DIR, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch { /* 单文件失败不影响其他 */ }
    }
  } catch { /* 目录不可读等：忽略 */ }
}