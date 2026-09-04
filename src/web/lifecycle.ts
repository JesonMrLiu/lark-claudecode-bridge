// 桥接器进程生命周期：PID 文件探活 / 后台拉起 / 跨进程停止 / 旧进程退出后重启。
// 消费方：Web 配置页 /api/bridge/* 端点（页面按钮启停）；startBridge 写/清 PID（src/index.ts）。
// 路径参数可注入（默认 CONFIG_DIR），便于测试用临时目录
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from '../config.js';

const PID_PATH = join(CONFIG_DIR, 'bridge.pid');
const LOG_PATH = join(CONFIG_DIR, 'bridge.log');
/** 后台运行日志超 5MB 先截断，避免常驻进程日志无限增长 */
const LOG_TRUNCATE_BYTES = 5 * 1024 * 1024;

/** 桥接器进程启动成功后自写 PID 文件（页面据此探活/跨进程停止） */
export function writePidFile(pidPath: string = PID_PATH): void {
  writeFileSync(pidPath, String(process.pid), 'utf8');
}

/** 优雅关闭时自清 PID 文件；文件已被其它进程覆写（重启竞态）时不误删 */
export function clearPidFile(pidPath: string = PID_PATH): void {
  try {
    if (readPidFile(pidPath) === process.pid) rmSync(pidPath, { force: true });
  } catch { /* 文件不存在等：无事 */ }
}

function readPidFile(pidPath: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 进程是否存活：signal 0 仅探测不发送；EPERM = 存在但属他人，仍视为存活 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface BridgeStatus { running: boolean; pid: number | null }

/** 探活桥接器；PID 文件指向已消亡进程（崩溃/被硬杀未及清理）时顺手清掉陈旧文件 */
export function bridgeStatus(pidPath: string = PID_PATH): BridgeStatus {
  const pid = readPidFile(pidPath);
  if (pid === null) return { running: false, pid: null };
  if (isPidAlive(pid)) return { running: true, pid };
  try { rmSync(pidPath, { force: true }); } catch { /* 并发清理竞态：忽略 */ }
  return { running: false, pid: null };
}

/**
 * 解析 lcb CLI 入口（发布包 dist/bin/lcb.js；模块位置相对定位，tsx 源码模式下该路径不存在）。
 * 源码运行时返回 error——页面按钮禁用并提示手动启停
 */
export function resolveLcbEntry(): { ok: true; entry: string } | { ok: false; error: string } {
  // dist/web/lifecycle.js → ../bin/lcb.js = dist/bin/lcb.js；tsx 源码模式下对应 src/bin/lcb.js
  // （实际是 lcb.ts，node 跑不了）→ 不存在即返回 error，页面按钮禁用提示手动启停
  const entry = fileURLToPath(new URL('../bin/lcb.js', import.meta.url));
  if (!existsSync(entry)) {
    return { ok: false, error: '未找到 dist/bin/lcb.js：源码（tsx）运行模式不支持由页面启停桥接器，请手动运行 lcb start' };
  }
  return { ok: true, entry };
}

/** 打开后台日志 fd（append；超 5MB 先截断） */
function openLogFd(): number {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_TRUNCATE_BYTES) rmSync(LOG_PATH, { force: true });
  } catch { /* 截断失败继续 append */ }
  return openSync(LOG_PATH, 'a');
}

/** 后台拉起桥接器：detached 守护进程，stdio 落 bridge.log，父进程退出不影响其存活 */
export function spawnBridgeDetached(): { ok: true; pid: number } | { ok: false; error: string } {
  const r = resolveLcbEntry();
  if (!r.ok) return r;
  const fd = openLogFd();
  const child = spawn(process.execPath, [r.entry, 'start'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  closeSync(fd); // 父进程关闭自有 fd 副本（子进程已继承）
  return { ok: true, pid: child.pid ?? -1 };
}

/**
 * 停止指定 PID 的桥接器。Windows 上 SIGTERM 等效 TerminateProcess（不走进程内优雅关闭
 * handler）；会话/配对状态均逐消息落盘，硬终止风险可控。同进程内（embedded）停止走
 * server.ts 注入的 selfStop 优雅路径，不经本函数
 */
export function stopBridgeByPid(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false; // 已退出或无权限
  }
}

/**
 * 内嵌重启 helper（CJS，node -e 执行）：轮询旧进程退出 → 拉起新桥接器 → 自退。
 * 不能「先拉新再杀旧」：新进程的 Web 配置页会因端口仍被旧进程占用而启动失败，
 * 导致重启后页面失联。超时 30s 放弃（保留旧进程运行态，页面可重试）
 */
const RESTART_HELPER = `
const { spawn } = require('node:child_process');
const { openSync, closeSync, existsSync, statSync, rmSync } = require('node:fs');
const [oldPid, entry, logPath] = process.argv.slice(1);
const t0 = Date.now();
(function wait() {
  try { process.kill(+oldPid, 0); } catch {
    try {
      if (existsSync(logPath) && statSync(logPath).size > 5*1024*1024) rmSync(logPath, { force: true });
      const fd = openSync(logPath, 'a');
      const child = spawn(process.execPath, [entry, 'start'], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
      child.unref();
      closeSync(fd);
    } catch (e) { try { console.error('restart helper failed:', e); } catch {} }
    process.exit(0);
  }
  if (Date.now() - t0 > 30000) process.exit(1);
  setTimeout(wait, 300);
})();
`;

/** 重启桥接器：spawn detached helper 由其等待旧进程退出后拉起新进程（跨平台统一路径） */
export function restartBridgeWithHelper(oldPid: number): { ok: true } | { ok: false; error: string } {
  const r = resolveLcbEntry();
  if (!r.ok) return r;
  const helper = spawn(process.execPath, ['-e', RESTART_HELPER, String(oldPid), r.entry, LOG_PATH], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  helper.unref();
  return { ok: true };
}

/**
 * lcb start 启动早期调用：探活并终止 pid 文件登记的旧实例，轮询等待真正退出。
 * 旧实例占着 Web 配置页端口会让本进程配置页静默失联（浏览器仍打到旧进程）。
 * Windows 上 SIGTERM=硬杀仍为异步，端口释放有延迟，故轮询（300ms 节奏同 RESTART_HELPER）。
 * 纯逻辑不打日志（由调用方输出），便于测试
 */
export async function stopExistingBridgeAndWait(
  timeoutMs = 10_000,
  pidPath: string = PID_PATH,
): Promise<{ stopped: boolean; pid: number | null }> {
  const st = bridgeStatus(pidPath); // 指向已消亡进程时顺手清理陈旧文件
  if (!st.running || st.pid === null || st.pid === process.pid) return { stopped: false, pid: null };
  const pid = st.pid;
  if (!stopBridgeByPid(pid)) return { stopped: false, pid }; // 无权限等：交给调用方提示
  const t0 = Date.now();
  while (isPidAlive(pid)) {
    if (Date.now() - t0 > timeoutMs) return { stopped: false, pid };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { stopped: true, pid };
}
