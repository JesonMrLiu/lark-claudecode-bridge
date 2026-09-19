// 开机自启（概览页开关）：三平台注册 / 注销 / 状态查询。纯逻辑全依赖注入
// （platform / execFile / 路径 / uid 可替换，tests/web/autostart.test.ts 零真实系统调用）。
//
// Windows = Startup 文件夹 VBS：explorer 登录时执行，wscript 隐藏窗口（无黑框）。
//   纯文件操作、普通用户可写——schtasks ONLOGON 触发器需管理员提升（真机报 Access is
//   denied），已弃用；开启/关闭时 best-effort 清理旧任务与任务管理器禁用标志，失败不阻断。
// macOS = launchctl bootstrap gui/uid（already bootstrapped 先 bootout 重试）；
// Linux = systemd --user（daemon-reload 必须在 enable 前）。
//
// 启动命令统一指向 process.execPath + resolveLcbEntry().entry + start：npm 全局包是就地
// 覆盖更新（node_modules/@jesonliu/... 路径不变），更新后自启自然有效；换 Node / 移动安装
// 目录后磁盘启动器内容与期望不符 → stale 置位，页面提示关闭再开启即可修复。
//
// 注册状态以 OS 查询为权威（config.autostart.enabled 仅意图记录，供配置页回显）。
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../config.js';

/** Windows 旧版 schtasks 任务名（仅迁移清理用：ONLOGON 触发器需管理员，已改用 Startup 文件夹） */
export const AUTOSTART_TASK_NAME = 'LarkClaudeCodeBridge';
/** Windows Startup 文件夹启动器文件名 */
export const AUTOSTART_STARTUP_VBS = 'lark-claudecode-bridge.vbs';
/** 任务管理器「启动应用」对 Startup 文件夹项的禁用标志键（值名 = 启动器文件名） */
export const AUTOSTART_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';
/** macOS LaunchAgent Label（= plist 文件名去后缀） */
export const AUTOSTART_LABEL = 'com.lark-claudecode-bridge';
/** Linux systemd 用户服务单元名 */
export const AUTOSTART_UNIT = 'lark-claudecode-bridge.service';

type ExecFileFn = (file: string, args: string[], cb: (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void) => void;

export interface AutostartDeps {
  platform?: NodeJS.Platform;
  execFileFn?: ExecFileFn;
  configDir?: string;
  homeDir?: string;
  /** Windows %APPDATA%（Startup 文件夹根）；缺省 env APPDATA，缺失再按 homeDir 标准布局推导 */
  appDataDir?: string;
  /** dist/bin/lcb.js 绝对路径；缺省视为入口不可用（tsx 源码模式）→ supported:false */
  entryPath?: string;
  /** node 可执行文件；缺省 process.execPath */
  nodePath?: string;
  uid?: number;
}

export interface AutostartStatus {
  /** dist 入口可用且平台受支持（tsx 源码模式 false，页面按钮禁用） */
  supported: boolean;
  /** OS 层已注册（权威判定，非 config 意图） */
  enabled: boolean;
  platform: NodeJS.Platform;
  /** 人类可读实现方式 / 异常原因（页面 hint 展示） */
  detail?: string;
  /** 生成的启动器文件路径（展示用） */
  registeredPath?: string;
  /** 已注册但启动器内容与当前安装不符（换 Node 等）→ 提示关闭再开启 */
  stale?: boolean;
}

/** 统一 execFile 包装：永不 reject，按退出码分支（err.code 可能是数字退出码或 'ENOENT' 等字符串） */
function run(deps: AutostartDeps, file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const execFileFn = deps.execFileFn ?? (execFileCb as unknown as ExecFileFn);
  return new Promise((resolve) => {
    execFileFn(file, args, (err, stdout, stderr) => {
      const rawCode = (err as unknown as { code?: unknown })?.code;
      resolve({
        code: err ? (typeof rawCode === 'number' ? rawCode : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

/** stderr 首行摘要（schtasks / launchctl / systemctl 的报错都足够一句话说清） */
function errSummary(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/)[0] ?? '';
  return line.slice(0, 200) || '未知错误';
}

/**
 * VBS 读写单源（utf16le + BOM）：wscript 按 UTF-16 解析带 BOM 的 .vbs——utf8 写盘会被按
 * ANSI 读，node/entry 路径含非 ASCII 字符时启动器静默失效。写读同源保证 stale 比对有效。
 */
function writeVbs(path: string, content: string): void {
  writeFileSync(path, '﻿' + content, 'utf16le');
}
function readVbs(path: string): string {
  return readFileSync(path, 'utf16le').replace(/^﻿/, '');
}

/** resolveDeps 的返回（deps 全部具名解析后），供平台内部 helper 传参 */
type ResolvedDeps = ReturnType<typeof resolveDeps>;

/** win32 启动器路径：Startup 文件夹（explorer 登录时逐项执行，.vbs 由 wscript 解释） */
function win32LauncherPath(d: ResolvedDeps): string {
  return join(d.appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', AUTOSTART_STARTUP_VBS);
}

/**
 * win32 best-effort 迁移清理（enable / disable 共用，全部无条件忽略失败）：
 * ① 旧版 schtasks ONLOGON 任务——需管理员已弃用，残留会导致登录双启动；
 * ② 任务管理器「启动应用」禁用标志——配置页本次点击是最新意图，重开应立即生效；
 * ③ 旧版遗留启动器（CONFIG_DIR/autostart/）。
 */
async function win32CleanupLegacy(deps: AutostartDeps, d: ResolvedDeps): Promise<void> {
  await run(deps, 'schtasks', ['/Delete', '/TN', AUTOSTART_TASK_NAME, '/F']);
  await run(deps, 'reg', ['delete', AUTOSTART_APPROVED_KEY, '/v', AUTOSTART_STARTUP_VBS, '/f']);
  try {
    const legacyDir = join(d.configDir, 'autostart');
    rmSync(join(legacyDir, 'lcb-autostart.vbs'), { force: true });
    rmdirSync(legacyDir); // 仅空目录可删；目录里有用户文件则整体保留
  } catch { /* best-effort */ }
}

/**
 * 期望启动器内容（纯函数，注册写盘与 stale 比对共用单源）。
 * Windows = wscript VBS（隐藏窗口不闪控制台）；macOS = launchd plist；Linux = systemd unit。
 * KeepAlive=false / Restart=on-failure 刻意偏离 deploy/ 模板（true/always）：配置页有「停止」
 * 按钮，守护拉起会跟用户手动停止互相打架；崩溃不自愈由 PID 探活 + 页面手动启动兜底。
 */
export function buildAutostartLauncher(platform: NodeJS.Platform, nodePath: string, entry: string, configDir: string): string {
  if (platform === 'win32') {
    const q = (s: string) => s.replace(/"/g, '""'); // VBS 字符串内引号翻倍（路径本身不含引号，防御性）
    return [
      `' lark-claudecode-bridge 开机自启启动器（Web 配置页生成，勿手改）：隐藏窗口 + 不等待`,
      `CreateObject("WScript.Shell").Run """${q(nodePath)}"" ""${q(entry)}"" start", 0, False`,
      '',
    ].join('\n');
  }
  if (platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entry}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- KeepAlive=false 刻意偏离 deploy 模板（true）：配置页有「停止」按钮，true 会把手动停掉的桥无限拉起 -->
  <key>KeepAlive</key><false/>
  <key>WorkingDirectory</key><string>${configDir}</string>
  <key>StandardOutPath</key><string>${join(configDir, 'logs', 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(configDir, 'logs', 'launchd.err.log')}</string>
</dict>
</plist>
`;
  }
  // linux（deploy/ 同名 unit 的运行时生成版）
  return `[Unit]
Description=lark-claudecode-bridge（Web 配置页生成的用户级自启）
After=network-online.target

[Service]
ExecStart=${nodePath} ${entry} start
WorkingDirectory=${configDir}
# on-failure 刻意偏离 deploy 模板的 always：与配置页「停止」按钮共存（手动停止不再被拉起）
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** 平台实现要点：文件路径 / 注册注销命令 / 状态判定。统一在 deps 解析后工作 */
function resolveDeps(deps: AutostartDeps): Required<Pick<AutostartDeps, 'platform' | 'configDir' | 'homeDir' | 'nodePath' | 'appDataDir'>> & { uid: number } {
  const homeDir = deps.homeDir ?? homedir();
  return {
    platform: deps.platform ?? process.platform,
    configDir: deps.configDir ?? CONFIG_DIR,
    homeDir,
    // explorer 以 APPDATA 定位 Startup 文件夹：优先环境变量，缺失再按标准布局推导
    appDataDir: deps.appDataDir ?? process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'),
    nodePath: deps.nodePath ?? process.execPath,
    uid: deps.uid ?? process.getuid?.() ?? 0,
  };
}

/** 平台不支持 / 入口缺失时的统一兜底状态 */
function unsupported(platform: NodeJS.Platform, detail: string): AutostartStatus {
  return { supported: false, enabled: false, platform, detail };
}

/** 查询 OS 层注册状态（enabled 权威判定 + stale 比对） */
export async function getAutostartStatus(deps: AutostartDeps = {}): Promise<AutostartStatus> {
  const d = resolveDeps(deps);
  if (!deps.entryPath) return unsupported(d.platform, '未找到 dist/bin/lcb.js：源码（tsx）运行模式不支持开机自启，请手动运行 lcb start');
  const launcher = buildAutostartLauncher(d.platform, d.nodePath, deps.entryPath, d.configDir);
  if (d.platform === 'win32') {
    // 文件即注册物：查询零外部命令（Node 读盘无 mojibake，编码可靠）
    const vbsPath = win32LauncherPath(d);
    const vbsExists = existsSync(vbsPath);
    const stale = vbsExists && readVbs(vbsPath) !== launcher;
    return {
      supported: true, enabled: vbsExists, platform: d.platform,
      detail: `Windows 登录启动（Startup 文件夹 · 可在任务管理器「启动应用」中管理）`,
      registeredPath: vbsPath, ...(stale ? { stale: true } : {}),
    };
  }
  if (d.platform === 'darwin') {
    const plistPath = join(d.homeDir, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
    const p = await run(deps, 'launchctl', ['print', `gui/${d.uid}/${AUTOSTART_LABEL}`]);
    const plistExists = existsSync(plistPath);
    const stale = p.code === 0 && plistExists && readFileSync(plistPath, 'utf8') !== launcher;
    return {
      supported: true, enabled: p.code === 0 && plistExists, platform: d.platform,
      detail: `macOS LaunchAgent · ${AUTOSTART_LABEL}（登录时启动）`,
      registeredPath: plistPath, ...(stale ? { stale: true } : {}),
    };
  }
  if (d.platform === 'linux') {
    const unitPath = join(d.homeDir, '.config', 'systemd', 'user', AUTOSTART_UNIT);
    const ie = await run(deps, 'systemctl', ['--user', 'is-enabled', AUTOSTART_UNIT]);
    const unitExists = existsSync(unitPath);
    const stale = ie.code === 0 && unitExists && readFileSync(unitPath, 'utf8') !== launcher;
    return {
      supported: true, enabled: ie.code === 0 && ie.stdout.trim() === 'enabled' && unitExists, platform: d.platform,
      detail: `Linux systemd 用户服务 · ${AUTOSTART_UNIT}（登录时启动；无桌面常驻服务器需 loginctl enable-linger）`,
      registeredPath: unitPath, ...(stale ? { stale: true } : {}),
    };
  }
  return unsupported(d.platform, `平台 ${d.platform} 暂不支持自动注册，请参考 deploy/ 目录模板手动配置`);
}

/** 注册 / 注销开机自启。OS 操作失败抛错（stderr 首行摘要）；调用方（server）失败时不回写 config 意图 */
export async function setAutostartEnabled(enabled: boolean, deps: AutostartDeps = {}): Promise<AutostartStatus> {
  const d = resolveDeps(deps);
  if (!deps.entryPath) return unsupported(d.platform, '未找到 dist/bin/lcb.js：源码（tsx）运行模式不支持开机自启，请手动运行 lcb start');
  if (d.platform === 'win32') {
    // 先 best-effort 清理旧物（失败不阻断），再执行主操作（纯文件写/删，普通用户必成）
    await win32CleanupLegacy(deps, d);
    const vbsPath = win32LauncherPath(d);
    if (enabled) {
      mkdirSync(dirname(vbsPath), { recursive: true });
      writeVbs(vbsPath, buildAutostartLauncher(d.platform, d.nodePath, deps.entryPath, d.configDir));
    } else {
      rmSync(vbsPath, { force: true });
    }
  } else if (d.platform === 'darwin') {
    const plistPath = join(d.homeDir, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
    if (enabled) {
      mkdirSync(dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, buildAutostartLauncher(d.platform, d.nodePath, deps.entryPath, d.configDir), 'utf8');
      // 优先 bootstrap（10.11+）；已加载（旧注册/手动 load 残留）→ bootout 后重试一次
      let r = await run(deps, 'launchctl', ['bootstrap', `gui/${d.uid}`, plistPath]);
      if (r.code !== 0) {
        await run(deps, 'launchctl', ['bootout', `gui/${d.uid}/${AUTOSTART_LABEL}`]);
        r = await run(deps, 'launchctl', ['bootstrap', `gui/${d.uid}`, plistPath]);
      }
      if (r.code !== 0) throw new Error(`launchctl bootstrap 失败：${errSummary(r.stderr)}`);
    } else {
      await run(deps, 'launchctl', ['bootout', `gui/${d.uid}/${AUTOSTART_LABEL}`]); // 未加载时失败：忽略
      rmSync(plistPath, { force: true });
    }
  } else if (d.platform === 'linux') {
    const unitPath = join(d.homeDir, '.config', 'systemd', 'user', AUTOSTART_UNIT);
    if (enabled) {
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, buildAutostartLauncher(d.platform, d.nodePath, deps.entryPath, d.configDir), 'utf8');
      // 顺序必须 daemon-reload 在前：unit 未被 systemd 识别时 enable 会静默失败
      let r = await run(deps, 'systemctl', ['--user', 'daemon-reload']);
      if (r.code !== 0) throw new Error(`systemctl daemon-reload 失败：${errSummary(r.stderr)}（WSL/容器未启用 systemd？）`);
      r = await run(deps, 'systemctl', ['--user', 'enable', '--now', AUTOSTART_UNIT]);
      if (r.code !== 0) throw new Error(`systemctl enable 失败：${errSummary(r.stderr)}`);
    } else {
      await run(deps, 'systemctl', ['--user', 'disable', '--now', AUTOSTART_UNIT]); // 未注册时失败：忽略
      rmSync(unitPath, { force: true });
      await run(deps, 'systemctl', ['--user', 'daemon-reload']);
    }
  } else {
    return unsupported(d.platform, `平台 ${d.platform} 暂不支持自动注册，请参考 deploy/ 目录模板手动配置`);
  }
  return getAutostartStatus(deps);
}
