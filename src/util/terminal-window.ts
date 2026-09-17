// 跨平台拉起终端窗口执行一段脚本（飞书 CLI 的安装/更新 + 授权登录引导）。
//
// 三个关键设计决定：
//  ① 与 src/web/lifecycle.ts 的 spawnBridgeDetached 同款：detached + stdio:ignore + unref，
//     不保留 child 引用、绝不 kill —— 桥接器重启/退出都不能连累已经打开的终端
//     （授权是分钟级流程，而「一键更新」恰好会重启桥接器）。
//  ② Windows 写临时 .cmd 文件而非内联命令串：内联要穿过「Node argv 引号 → cmd 解析 →
//     start 的标题规则 → 嵌套 .cmd 再解析」四层，& / && / 空格路径任一处出错都是静默失败。
//     写成文件后整条命令只剩下一个路径参数。
//  ③ 纯函数与副作用分离：platform / env / fs / spawnFn / writeScript 全部可注入，
//     单测不真拉终端、不真写盘。
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export type TerminalTask = 'install' | 'auth' | 'config';

/** 烘焙进脚本的绝对路径（全部来自 OS，不含任何用户输入） */
export interface ScriptBake {
  /** 桥接器进程的 PATH —— 它跑通过 `npm prefix -g`，在 GUI 终端里最可信的来源 */
  pathEnv?: string;
  /** node 绝对路径（PATH 上没有 lark-cli 时直跑包内入口兜底） */
  nodePath?: string;
  /** lark-cli 包内入口 scripts/run.js 绝对路径 */
  larkEntry?: string;
}

/** 脚本流程开关（bridge 端判定后传入；脚本本身保持纯渲染） */
export interface ScriptOpts {
  /**
   * 未配置应用时先跑 `lark-cli config init --new`（官方安装第 ③ 步）再 auth login。
   * 由调用方用 needsLarkCliConfig() 判定传入；缺省 false（不插 config 段，兼容旧流程）。
   */
  needConfig?: boolean;
}

/**
 * Agent 上下文变量：lark-cli 检测到会走「Agent 凭证绑定」分支（拒绝 config init、
 * auth status 报 not bound）。GUI 终端继承的是注册表/登录会话环境而非 bridge 进程环境
 * （bridge 入口剔除管不到它），所以脚本里必须自己清。与 lark-cli-manager 的
 * AGENT_CONTEXT_ENV_KEYS 同源——菜单化重复声明是为了避免 util 反向依赖 src 根模块。
 */
const AGENT_CONTEXT_ENV_KEYS = ['HERMES_HOME', 'OPENCLAW_HOME', 'LARK_CHANNEL'] as const;

export const LARK_CLI_SCRIPT_PREFIX = 'lcb-larkcli-';

// ============ 纯函数：Shell 转义 ============

/** Unix 单引号封装；值内单引号用 close-escape-reopen 拼接（`'` → `'\''`） */
export function shQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * Windows `set "VAR=..."` 的值安全校验：含 cmd 元字符就返回 undefined（调用方整行省略）。
 * 宁可不烘焙这段 PATH 也不冒注入风险——空格不在禁用之列，因为 `set "VAR=值"` 的引号已覆盖它。
 */
export function cmdSafeEnvValue(v: string): string | undefined {
  return /[%^&|<>"\r\n]/.test(v) ? undefined : v;
}

// ============ 纯函数：脚本生成 ============

/**
 * Windows .cmd：CRLF 行尾、UTF-8 无 BOM、**全文纯 ASCII**。
 *
 * 真机实测（Win11）：cmd 按 512 字节块读批处理文件，**多字节 UTF-8 字符跨块时该行会被
 * 从中间截断、后半截当命令执行**（幻影换行）——垫字节对齐可以复现/消除，但烘焙的 PATH
 * 动辄数 KB，文件必然跨多个块边界，对齐守不住；BOM 也救不了。故中文指引放配置页弹窗，
 * 终端里的固定文案用英文；`chcp 65001` 保留，让 lark-cli 自己的 UTF-8 输出正常显示。
 *
 * 不用 goto/标签（顺带规避 goto 在多字节批处理里的定位漂移），失败路径用
 * `exit /b 1` 终止（cmd /k 下落到交互提示符，窗口保持打开）。
 */
export function buildWindowsScript(task: TerminalTask, bake: ScriptBake = {}, opts: ScriptOpts = {}): string {
  const L: string[] = [];
  // 绝不能加 BOM：它会让首行的 @echo off 变成垃圾并被回显
  L.push('@echo off');
  L.push('chcp 65001 >nul 2>&1');
  L.push('title lark-cli install / config / auth (from lcb)');
  const safePath = bake.pathEnv ? cmdSafeEnvValue(bake.pathEnv) : undefined;
  if (safePath) L.push(`set "PATH=${safePath};%PATH%"`);
  // Agent 上下文清场：不清则 lark-cli 走「Agent 绑定」分支（拒绝 config init）——见上方常量注释
  for (const k of AGENT_CONTEXT_ENV_KEYS) L.push(`set "${k}="`);
  L.push('echo.');
  L.push('echo ============================================================');
  // 步骤总数随任务/流程开关变化，编号 [n/total] 动态拼
  const total = task === 'install' ? (opts.needConfig ? 3 : 2) : task === 'config' ? 2 : 1;
  if (task === 'install') {
    L.push('echo   Lark CLI (@larksuite/cli) install / update + skill + config + auth');
    L.push('echo   Launched from the lcb web console. Keep this window open;');
    L.push('echo   the following steps run automatically once install finishes.');
  } else if (task === 'config') {
    L.push('echo   Lark CLI (@larksuite/cli) app configuration (config init --new)');
    L.push('echo   Launched from the lcb web console. Complete the setup in the');
    L.push('echo   browser page it prints; auth login starts automatically after.');
  } else {
    L.push('echo   Lark CLI (@larksuite/cli) auth login');
    L.push('echo   Launched from the lcb web console. Follow the prompts below.');
  }
  L.push('echo ============================================================');
  L.push('echo.');
  if (task === 'install') {
    L.push('where npm >nul 2>&1');
    L.push('if errorlevel 1 (');
    L.push('  echo [x] npm not found. Install Node.js first and make sure npm is on PATH.');
    L.push('  echo.');
    L.push('  exit /b 1');
    L.push(')');
    L.push('echo ^> npm install -g @larksuite/cli@latest');
    // 必须 call：npm 是 .cmd shim，批处理里不加 call 会移交控制权且永不返回
    L.push('call npm install -g @larksuite/cli@latest');
    L.push('if errorlevel 1 (');
    L.push('  echo.');
    L.push('  echo [x] Install failed (see npm output above). Auth login skipped.');
    L.push('  echo     Check network / registry mirror, then retry.');
    L.push('  echo.');
    L.push('  exit /b 1');
    L.push(')');
    L.push('echo.');
    L.push(`echo [1/${total}] Install/update done. Installing the official SKILL (teaches AI tools how to drive lark-cli)...`);
    L.push('echo.');
    // npx 同为 .cmd shim 必须 call；失败仅提示不阻断（SKILL 可稍后在 lcb 配置页补装）
    L.push('call npx -y skills add https://open.feishu.cn --skill "*" -g -a claude-code --copy -y');
    L.push('if errorlevel 1 (');
    L.push('  echo.');
    L.push('  echo [!] SKILL install failed (non-fatal). Retry later via the lcb web console.');
    L.push('  echo.');
    L.push(')');
  }
  if (task === 'config' || opts.needConfig) {
    const n = task === 'config' ? 1 : 2;
    L.push('echo.');
    L.push(`echo [${n}/${total}] Configuring the Feishu app: complete the setup in the browser page it prints...`);
    L.push('echo.');
    L.push('call lark-cli config init --new');
    L.push('if errorlevel 1 (');
    L.push('  echo.');
    L.push('  echo [x] Config not completed or cancelled. Auth login skipped.');
    L.push('  echo     You can retry via the lcb web console.');
    L.push('  echo.');
    L.push('  exit /b 1');
    L.push(')');
  }
  L.push('echo.');
  if (total > 1) L.push(`echo [${total}/${total}] Starting auth login (confirm in browser or Feishu/Lark app)...`);
  L.push('echo.');
  L.push('call lark-cli auth login --recommend');
  L.push('if errorlevel 1 (');
  L.push('  echo.');
  L.push('  echo [x] Auth not completed or cancelled. You can retry via the web console.');
  L.push('  echo     If not configured yet, run first: lark-cli config init');
  L.push(') else (');
  L.push('  echo.');
  L.push('  echo [Done] Auth flow finished. Click "Check" on the web console to verify.');
  L.push(')');
  L.push('echo.');
  return L.join('\r\n') + '\r\n';
}

/** Unix .sh：LF 行尾（CRLF 会毁掉 shebang：/bin/sh^M: bad interpreter） */
export function buildUnixScript(task: TerminalTask, bake: ScriptBake = {}, opts: ScriptOpts = {}): string {
  const L: string[] = [];
  L.push('#!/bin/sh');
  L.push('# 由 lcb 配置页拉起；窗口保持打开是刻意的——用户可能需要就地补跑 config init');
  if (bake.nodePath) L.push(`LARK_NODE=${shQuote(bake.nodePath)}`);
  if (bake.larkEntry) L.push(`LARK_ENTRY=${shQuote(bake.larkEntry)}`);
  L.push('');
  // 1) 先用桥接器自己的 PATH（它跑通过 npm prefix -g）
  if (bake.pathEnv) L.push(`export PATH=${shQuote(bake.pathEnv)}:"$PATH"`);
  // 2) GUI 终端（macOS Terminal.app / 桌面双击）常不加载 .zshrc / .bashrc：补 nvm 与常见 node 位置
  L.push('[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true');
  L.push('export PATH="$HOME/.volta/bin:$HOME/.asdf/shims:$HOME/.local/share/mise/shims:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"');
  // 3) Agent 上下文清场：不清则 lark-cli 走「Agent 绑定」分支（拒绝 config init）——见常量注释
  L.push('unset HERMES_HOME OPENCLAW_HOME LARK_CHANNEL');
  L.push('');
  const total = task === 'install' ? (opts.needConfig ? 3 : 2) : task === 'config' ? 2 : 1;
  L.push('echo "============================================================"');
  if (task === 'install') {
    L.push('echo "  飞书官方 CLI（@larksuite/cli）安装 / 更新 + SKILL + 配置 + 授权"');
    L.push('echo "  本窗口由 lcb 配置页拉起，请勿关闭；各步骤会自动依次执行"');
  } else if (task === 'config') {
    L.push('echo "  飞书官方 CLI（@larksuite/cli）应用配置（config init --new）"');
    L.push('echo "  本窗口由 lcb 配置页拉起，按它打印的链接在浏览器完成创建后自动继续"');
  } else {
    L.push('echo "  飞书官方 CLI（@larksuite/cli）授权登录"');
    L.push('echo "  本窗口由 lcb 配置页拉起，请按提示完成授权"');
  }
  L.push('echo "============================================================"');
  L.push('echo');
  if (task === 'install') {
    L.push('if ! command -v npm >/dev/null 2>&1; then');
    L.push('  echo "[x] 未找到 npm：请先安装 Node.js（nvm/asdf 用户请确认已设置 default 版本）"');
    L.push('  echo "    按回车关闭本窗口"; read -r _ || true');
    L.push('  exit 1');
    L.push('fi');
    L.push('');
    L.push('echo "> npm install -g @larksuite/cli@latest"');
    L.push('npm install -g @larksuite/cli@latest');
    L.push('if [ $? -ne 0 ]; then');
    L.push('  echo');
    L.push('  echo "[x] 安装失败（见上方 npm 输出），已跳过后续步骤。请检查网络 / registry 镜像后重试。"');
    L.push('  echo "    按回车关闭本窗口"; read -r _ || true');
    L.push('  exit 1');
    L.push('fi');
    L.push('');
    L.push(`echo "[1/${total}] 安装/更新完成，安装官方 SKILL（教 AI 工具使用 lark-cli；失败不影响后续）..."`);
    L.push("npx -y skills add https://open.feishu.cn --skill '*' -g -a claude-code --copy -y \\");
    L.push('  || echo "[!] SKILL 安装失败（不影响后续步骤），可稍后在 lcb 配置页重试"');
    L.push('');
  }
  if (task === 'config' || opts.needConfig) {
    const n = task === 'config' ? 1 : 2;
    L.push(`echo "[${n}/${total}] 配置飞书应用：按它打印的链接/页面在浏览器完成创建，完成后自动继续..."`);
    L.push('if command -v lark-cli >/dev/null 2>&1; then');
    L.push('  lark-cli config init --new');
    if (bake.nodePath && bake.larkEntry) {
      L.push('else');
      L.push('  "$LARK_NODE" "$LARK_ENTRY" config init --new');
    } else {
      L.push('else');
      L.push('  echo "[x] 未找到 lark-cli：请确认全局安装目录在 PATH 中（npm prefix -g）"');
    }
    L.push('fi');
    L.push('if [ $? -ne 0 ]; then');
    L.push('  echo');
    L.push('  echo "[x] 配置未完成或已取消，已跳过授权登录。可回 lcb 配置页重试。"');
    L.push('  echo "    按回车关闭本窗口"; read -r _ || true');
    L.push('  exit 1');
    L.push('fi');
    L.push('');
  }
  if (total > 1) L.push(`echo "[${total}/${total}] 开始授权登录（按提示在浏览器或飞书中确认）..."`);
  L.push('if command -v lark-cli >/dev/null 2>&1; then');
  L.push('  lark-cli auth login --recommend');
  if (bake.nodePath && bake.larkEntry) {
    // 两段各自加引号：路径带空格也安全，不能拼成单个 $LARK（会被词分割）
    L.push('else');
    L.push('  "$LARK_NODE" "$LARK_ENTRY" auth login --recommend');
  } else {
    L.push('else');
    L.push('  echo "[x] 未找到 lark-cli：请确认全局安装目录在 PATH 中（npm prefix -g）"');
  }
  L.push('fi');
  L.push('if [ $? -ne 0 ]; then');
  L.push('  echo');
  L.push('  echo "[x] 授权未完成或已取消。可在概览页点「去终端授权」重新发起。"');
  L.push('  echo "    若提示未配置应用，请先在本窗口执行：lark-cli config init"');
  L.push('fi');
  L.push('echo');
  L.push('echo "[完成] 请回到配置页点「检测」查看状态。"');
  L.push('echo "按回车关闭本窗口"; read -r _ || true');
  return L.join('\n') + '\n';
}

// ============ 探测：可用终端 ============

export interface WhichFs {
  exists(p: string): boolean;
  executable(p: string): boolean;
}

const realFs: WhichFs = {
  exists: (p) => { try { accessSync(p, constants.F_OK); return true; } catch { return false; } },
  executable: (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } },
};

/**
 * 在 PATH 里查可执行文件（自己拆 PATH，不 spawn `which`——12 条候选要起 12 个进程，
 * 且 `which` 本身可能不存在）。
 *
 * 拼接刻意不走 path.join：那会让分隔符由**宿主**决定而非 platform 参数，
 * 注入非宿主平台（测试）时就会拼出 `/usr/bin\konsole` 这种四不像。
 */
export function whichFromPath(
  bin: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fs: WhichFs = realFs,
): string | undefined {
  const raw = env.PATH ?? env.Path ?? '';
  if (!raw) return undefined;
  const listSep = platform === 'win32' ? ';' : ':';
  const dirSep = platform === 'win32' ? '\\' : '/';
  const exts = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of raw.split(listSep).filter(Boolean)) {
    for (const ext of exts) {
      const full = dir.endsWith(dirSep) ? `${dir}${bin}${ext}` : `${dir}${dirSep}${bin}${ext}`;
      if (fs.exists(full) && fs.executable(full)) return full;
    }
  }
  return undefined;
}

export interface TerminalCandidate {
  /** 要 spawn 的程序 */
  bin: string;
  /** 人类可读名称（日志/测试断言用） */
  terminal: string;
  args(scriptPath: string): string[];
}

export interface DetectOpts {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fs?: WhichFs;
}

export interface ListCandidatesResult {
  candidates: TerminalCandidate[];
  reason?: string;
}

/** Linux 终端候选表：顺序即优先级；args 按各终端自己的语法（kitty/foot 直接吃命令，不吃 -e） */
const LINUX_TERMINALS: Array<{ bin: string; args(script: string): string[] }> = [
  { bin: 'x-terminal-emulator', args: (s) => ['-e', s] },
  { bin: 'gnome-terminal', args: (s) => ['--', s] },
  { bin: 'kgx', args: (s) => ['--', s] },
  { bin: 'konsole', args: (s) => ['-e', s] },
  { bin: 'xfce4-terminal', args: (s) => ['-x', s] },
  { bin: 'mate-terminal', args: (s) => ['-x', s] },
  { bin: 'tilix', args: (s) => ['-e', s] },
  { bin: 'kitty', args: (s) => [s] },
  { bin: 'alacritty', args: (s) => ['-e', s] },
  { bin: 'foot', args: (s) => [s] },
  { bin: 'wezterm', args: (s) => ['start', s] },
  { bin: 'xterm', args: (s) => ['-e', s] },
];

/**
 * 列出可用的终端候选（按优先级）。
 * Linux 上先用 DISPLAY/WAYLAND_DISPLAY 挡掉 SSH/headless —— 省掉一轮无谓的 spawn 试探。
 */
export function listTerminalCandidates(opts: DetectOpts = {}): ListCandidatesResult {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? realFs;

  if (platform === 'win32') {
    // Windows 必有控制台，无需探测
    return { candidates: [{ bin: 'cmd', terminal: '命令提示符', args: (s) => ['/c', 'start', '', 'cmd', '/k', s] }] };
  }
  if (platform === 'darwin') {
    // open -a 是 execFile 语义（路径是单个 argv），不像 osascript 要在 AppleScript 里再嵌一层 shell 转义
    return { candidates: [{ bin: 'open', terminal: 'Terminal.app', args: (s) => ['-a', 'Terminal', s] }] };
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { candidates: [], reason: '无图形会话（SSH / 无桌面环境），无法打开终端窗口' };
  }

  const table = [...LINUX_TERMINALS];
  // $TERMINAL 优先——但仅当它是**裸 token**：含空格的 "kitty --single-instance" 按裸名查会全盘落空
  const preferred = env.TERMINAL;
  if (preferred && /^[A-Za-z0-9._/-]+$/.test(preferred)) {
    const name = preferred.split('/').pop() ?? preferred;
    const known = table.find((t) => t.bin === name);
    const bin = known ? whichFromPath(name, env, platform, fs) : undefined;
    if (bin) {
      const idx = table.findIndex((t) => t.bin === name);
      const entry = table[idx];
      table.splice(idx, 1);
      table.unshift(entry);
    }
  }

  const candidates: TerminalCandidate[] = [];
  for (const t of table) {
    const bin = whichFromPath(t.bin, env, platform, fs);
    if (bin) candidates.push({ bin, terminal: t.bin, args: t.args });
  }
  return candidates.length
    ? { candidates }
    : { candidates: [], reason: '未找到可用的终端程序（已尝试 x-terminal-emulator / gnome-terminal / konsole / xterm 等）' };
}

export type DetectTerminalResult =
  | ({ ok: true } & TerminalCandidate)
  | { ok: false; reason: string; code: 'no-terminal' };

/** 探测首个可用终端（只探测，不落盘、不 spawn） */
export function detectTerminal(opts: DetectOpts = {}): DetectTerminalResult {
  const { candidates, reason } = listTerminalCandidates(opts);
  const first = candidates[0];
  if (!first) return { ok: false, reason: reason ?? '未找到可用的终端程序', code: 'no-terminal' };
  return { ok: true, ...first };
}

// ============ 拉起（唯一副作用入口） ============

export type SpawnFn = (file: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

/** 脚本文件名自增序号（同毫秒内的连续调用也要拿到互不相同的文件名） */
let scriptSeq = 0;

export interface LaunchTerminalOpts extends DetectOpts {
  bake?: ScriptBake;
  /** 未配置应用时先跑 config init --new（透传给脚本 builder，见 ScriptOpts） */
  needConfig?: boolean;
  tmpDir?: string;
  spawnFn?: SpawnFn;
  /** 注入点：写脚本并返回实际落盘路径（生产实现另做 24h 残留清扫） */
  writeScript?: (filePath: string, text: string) => string;
  /** 注入点：候选列表（生产实现为 listTerminalCandidates） */
  listCandidates?: (opts?: DetectOpts) => ListCandidatesResult;
}

export type LaunchTerminalResult =
  | { ok: true; terminal: string; scriptPath: string }
  | { ok: false; reason: string; code: 'no-terminal' | 'spawn-failed' | 'script-write-failed' };

/** best-effort 清扫历史残留（系统 tmp 也会自清，这里只是不让它们无限堆积） */
function sweepStaleScripts(dir: string, maxAgeMs = 24 * 3600_000): void {
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(LARK_CLI_SCRIPT_PREFIX)) continue;
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p);
      } catch { /* 被占用 / 无权限：留给系统清理 */ }
    }
  } catch { /* tmp 目录不可读 */ }
}

function defaultWriteScript(filePath: string, text: string): string {
  sweepStaleScripts(dirname(filePath));
  // Node 默认 UTF-8 无 BOM；.cmd 绝不能有 BOM（首行会变垃圾）
  writeFileSync(filePath, text);
  if (!filePath.endsWith('.cmd')) {
    // open -a Terminal / 各 Linux 终端都要求脚本可执行
    try { chmodSync(filePath, 0o755); } catch { /* 权限受限时留给调用方降级 */ }
  }
  return filePath;
}

/**
 * 写脚本 → 逐个候选拉起终端。全部失败时返回 ok:false，由调用方决定降级（静默安装）。
 *
 * 注意：spawn 只捕获**同步**异常。候选已由 listCandidates 预筛过存在性，异步 'error'
 * 事件（极端的权限场景）不再下探——那时进程已返回，重新拉起反而可能开出多个窗口。
 */
export async function launchInTerminal(
  task: TerminalTask,
  opts: LaunchTerminalOpts = {},
): Promise<LaunchTerminalResult> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const list = opts.listCandidates ?? listTerminalCandidates;
  const { candidates, reason } = list({ platform, env, fs: opts.fs });
  if (!candidates.length) {
    return { ok: false, code: 'no-terminal', reason: reason ?? '未找到可用的终端程序' };
  }

  const bake = opts.bake ?? {};
  const scriptOpts: ScriptOpts = { needConfig: opts.needConfig };
  const text = platform === 'win32'
    ? buildWindowsScript(task, bake, scriptOpts)
    : buildUnixScript(task, bake, scriptOpts);
  const ext = platform === 'win32' ? 'cmd' : 'sh';
  // 文件名唯一（task + pid + 时间戳 + 自增序号）：重复点击不会覆盖正在运行的脚本
  // （序号兜住同毫秒内的连续调用——Date.now() 单独用不够）
  const name = `${LARK_CLI_SCRIPT_PREFIX}${task}-${process.pid}-${Date.now()}-${++scriptSeq}.${ext}`;
  const filePath = join(opts.tmpDir ?? tmpdir(), name);

  let scriptPath: string;
  try {
    scriptPath = (opts.writeScript ?? defaultWriteScript)(filePath, text);
  } catch (e) {
    return { ok: false, code: 'script-write-failed', reason: e instanceof Error ? e.message : String(e) };
  }

  const spawnFn = (opts.spawnFn ?? spawn) as SpawnFn;
  let lastErr = '';
  for (const c of candidates) {
    try {
      // windowsHide 刻意不传：它映射 CREATE_NO_WINDOW，可能把终端窗口一起藏掉
      const child = spawnFn(c.bin, c.args(scriptPath), { detached: true, stdio: 'ignore' });
      child.unref?.();
      return { ok: true, terminal: c.terminal, scriptPath };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, code: 'spawn-failed', reason: lastErr || '拉起终端失败' };
}
