// 桥接器进程生命周期：PID 文件探活 / 后台拉起 / 跨进程停止 / 旧进程退出后重启 / 端口实占清场。
// 消费方：Web 配置页 /api/bridge/* 端点（页面按钮启停）；startBridge 写/清 PID（src/index.ts）。
// 路径参数可注入（默认 CONFIG_DIR），便于测试用临时目录
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from '../config.js';

const PID_PATH = join(CONFIG_DIR, 'bridge.pid');
/** 后台运行日志落 ~/.lark-claudecode-bridge/logs/bridge-YYYY-MM-DD.log（#7：按天拆分，由进程内 console tee 自管）。
 * 历史版本曾重定向 stdio 到 bridge.log（被本文件保留字段 LOG_PATH 引用但不再使用），现统一走 logs/。 */

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

/** 后台拉起桥接器：detached 守护进程，stdio 走 ignore（#7：日志由进程内 console tee 自管到 logs/，
 * 不再重定向到 bridge.log——既避免文件双写分裂，也避免 detach 后日志继续堆在单文件） */
export function spawnBridgeDetached(): { ok: true; pid: number } | { ok: false; error: string } {
  const r = resolveLcbEntry();
  if (!r.ok) return r;
  const child = spawn(process.execPath, [r.entry, 'start'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
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

// ---- 端口实占清场（主人原始方案：重启/启动时若端口被旧 LCB 进程占用，先杀掉再起新的）。
// 背景：PID 文件是「登记制」，旧进程异常退出会留陈旧记录、外部旧版本进程不登记——只认 PID 文件
// 杀不到真正的端口占用者（2026-10-17 2.0.0 升级期事故根因）。这里补第二条路径：直接探测端口 ----

export interface PortOccupier {
  isLcb: boolean; // 占用者是否 LCB 自己人（/api/status 应答带 version，401 特批亦带）
  pid: number | null; // 占用者 PID：优先取响应顶层 pid（≥2.0.1 提供），回退 netstat/lsof 反查
  version: string | null;
}

/** 反查监听指定端口的进程 PID（回退路径：占用者未提供顶层 pid 时使用）。
 * win32=netstat -ano（LISTENING 行末列 PID）；darwin/linux= lsof -ti（缺失则放弃返回 null） */
export async function pidListeningOnPortAsync(port: number): Promise<number | null> {
  const exec = (cmd: string, args: string[], timeoutMs = 5000): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, stdout) =>
        e ? reject(e) : resolve(String(stdout)),
      );
    });
  try {
    if (process.platform === 'win32') {
      const out = await exec('netstat', ['-ano']);
      // 行形如：TCP    127.0.0.1:17317    0.0.0.0:0    LISTENING    2708（IPv6 为 [::]:17317）
      for (const line of out.split('\n')) {
        const m = line.match(new RegExp(String.raw`^\s*TCP\s+\S+:${port}\s+\S+\s+LISTENING\s+(\d+)`, 'i'));
        if (m) return Number.parseInt(m[1], 10);
      }
      return null;
    }
    const out = await exec('lsof', ['-ti', `tcp:${port}`]); // darwin / 装了 lsof 的 linux：每行一个 PID
    const pid = Number.parseInt(out.trim().split('\n')[0] ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // netstat/lsof 缺失或执行失败：拿不到 PID，调用方降级为仅凭 version 判断
  }
}

/** 探测 127.0.0.1:port 的占用者身份。端口无人监听（连接拒绝/超时）→ null */
export async function probePortOccupier(port: number): Promise<PortOccupier | null> {
  let st: { version?: unknown; pid?: unknown } | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(2000),
    });
    st = (await res.json().catch(() => null)) as { version?: unknown; pid?: unknown } | null;
  } catch {
    return null; // 端口无人监听或非 HTTP 服务
  }
  const isLcb = typeof st?.version === 'string';
  const respPid = typeof st?.pid === 'number' && Number.isInteger(st.pid) && st.pid > 0 ? st.pid : null;
  const pid = respPid ?? (isLcb ? await pidListeningOnPortAsync(port) : null);
  return { isLcb, pid, version: isLcb ? (st!.version as string) : null };
}

export interface PortFreeResult {
  freed: boolean;
  pid: number | null;
  detail: string;
}

/**
 * 端口实占清场：占用者是 LCB 进程（/api/status 带 version）→ 强制结束并轮询等端口释放；
 * 非 LCB 占用者（别的软件占端口）不动，交由调用方按 EADDRINUSE 提示换端口。
 * 防自杀：占用者即本进程时不杀（理论上启动清场阶段本进程尚未监听，纯防御）
 */
export async function freeLcbOccupiedPort(port: number, timeoutMs = 10_000): Promise<PortFreeResult> {
  const occ = await probePortOccupier(port);
  if (!occ) return { freed: true, pid: null, detail: '端口空闲' };
  if (!occ.isLcb) {
    return { freed: false, pid: occ.pid, detail: `端口被非 LCB 进程占用${occ.pid ? `（PID ${occ.pid}）` : ''}，不动` };
  }
  if (occ.pid === null) {
    return { freed: false, pid: null, detail: `端口被 LCB 进程（v${occ.version}）占用，但未能定位 PID，无法自动清场` };
  }
  if (occ.pid === process.pid) {
    return { freed: true, pid: occ.pid, detail: '占用者为本进程，跳过' };
  }
  if (!stopBridgeByPid(occ.pid)) {
    return { freed: false, pid: occ.pid, detail: `向占用者（PID ${occ.pid}）发送停止信号失败（无权限或已退出）` };
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await probePortOccupier(port)) === null) {
      return { freed: true, pid: occ.pid, detail: `已结束占用端口的旧 LCB 进程（PID ${occ.pid}）并释放端口` };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { freed: false, pid: occ.pid, detail: `已向占用者（PID ${occ.pid}）发送停止信号，但端口 ${timeoutMs / 1000}s 内未释放` };
}

/**
 * 内嵌重启 helper（CJS，node -e 执行）：补刀杀旧进程 → 轮询确认退出 → 拉起新桥接器 → 自退。
 * 不能「先拉新再杀旧」：新进程的 Web 配置页会因端口仍被旧进程占用而启动失败，
 * 导致重启后页面失联。超时 30s 放弃（保留旧进程运行态，页面可重试）。
 * 补刀延迟 500ms：embedded 模式 server.ts 的 selfStop 在 300ms 后优雅退出（关长连接/停受管
 * 服务/清 PID），这刀落空（catch 忽略）；独立模式原本「只等不杀」——旧进程永生导致必撞
 * 页面 120s 重启超时（2026-10-17 定性），这刀是关键修复。Windows 上 SIGTERM=硬杀，风险
 * 与 stopBridgeByPid 同口径（状态逐消息落盘，可控）。
 * #7：stdio 走 ignore，日志由进程内 console tee 自管到 logs/bridge-YYYY-MM-DD.log
 */
const RESTART_HELPER = `
const { spawn } = require('node:child_process');
const [oldPid, entry] = process.argv.slice(1);
const t0 = Date.now();
setTimeout(function () { try { process.kill(+oldPid, 'SIGTERM'); } catch (e) {} }, 500);
(function wait() {
  try { process.kill(+oldPid, 0); } catch {
    try {
      const child = spawn(process.execPath, [entry, 'start'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
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
  const helper = spawn(process.execPath, ['-e', RESTART_HELPER, String(oldPid), r.entry], {
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
