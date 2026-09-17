// 飞书官方 CLI（@larksuite/cli，命令 lark-cli）自动管理：深度拥抱飞书——
// lcb start 时检测，缺失则后台自动安装（npm install -g，尊重 .npmrc 镜像/代理），
// 失败仅告警不阻断桥接器；Web 配置页提供状态查询 / 手动安装更新（/api/lark-cli）。
//
// 对齐官方安装四步（open.feishu.cn 安装指南）：① npm 装包 → ② 装 SKILL
// （npx skills add https://open.feishu.cn，官方标"必需"，教 AI 工具怎么用 lark-cli）
// → ③ `lark-cli config init --new` 配置应用 → ④ `lark-cli auth login --recommend` 登录。
// SKILL 只装到 ~/.claude/skills（skills CLI 不支持自定义目标目录）；managed 会话的可见性
// 由既有 bridgeUserSkills() 在 lcb start 时 junction 桥接保证，本模块不做任何拷贝。
//
// 关于登录：lcb 仍然不代管凭证，但**负责把用户送到能完成授权的地方**——
// 手动安装/更新改为拉起真实终端窗口跑 `npm i -g` + `config init --new`（未配置时）+
// `lark-cli auth login --recommend`，用户能看见输出、并在同一个窗口里顺势完成
// device flow 授权（拉不起终端则安装降级静默；config/auth 是交互式向导，不降级）。
// 授权状态经 `auth status --json` 探测后在概览页展示，未授权时给「去终端授权」入口。
//
// Agent 上下文隔离：lark-cli 会按 HERMES_HOME / OPENCLAW_HOME / LARK_CHANNEL 三个环境变量
// 自动进入「Agent 凭证绑定」分支（要求 config bind 而拒绝 config init）。bridge 是
// 飞书+ClaudeCode 专用进程，与这些 Agent 无关——lcb start 入口统一剔除（见 bin/lcb.ts），
// 本模块探测也走剔除后的 env，保证 lark-cli 始终走标准 init/login 路径。
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNpm, runNpx } from './util/npm.js';
import { launchInTerminal, type LaunchTerminalResult, type ScriptBake, type TerminalTask } from './util/terminal-window.js';

/** 飞书官方 CLI 的 npm 包名（命令名 lark-cli；注意 @larksuiteoapi 作用域是 lark-mcp，勿混淆） */
export const LARK_CLI_PACKAGE = '@larksuite/cli';

/** 飞书 CLI 官方 SKILL 的来源 URL（`npx skills add` 的 well-known discovery 入口） */
export const LARK_CLI_SKILL_SOURCE = 'https://open.feishu.cn';

/**
 * 触发 lark-cli「Agent 上下文」分支的环境变量（来源：`lark-cli config bind --help` 自述
 * --source 由 OPENCLAW_HOME / HERMES_HOME / LARK_CHANNEL 自动探测）。实测本机设了
 * HERMES_HOME 时 auth status 报 "hermes not bound"、config init 被拒——与 bridge 无关的
 * 上下文不能劫持标准安装流程，入口与探测处统一剔除。
 */
export const AGENT_CONTEXT_ENV_KEYS = ['HERMES_HOME', 'OPENCLAW_HOME', 'LARK_CHANNEL'] as const;

/** 返回剔除 Agent 上下文变量后的 env 副本（不改传入对象；纯函数可测） */
export function stripAgentContextEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const k of AGENT_CONTEXT_ENV_KEYS) delete copy[k];
  return copy;
}

export interface LarkCliDetect {
  installed: boolean;
  /** 解析不到时缺省（已安装但版本未知，不算未装） */
  version?: string;
}

/** 纯函数（可测）：从 `lark-cli --version` 输出解析语义化版本（如 1.2.3 / 1.2.3-beta.1） */
export function parseLarkCliVersion(out: string): string | undefined {
  // 遇空白 / 引号 / 逗号 / 花括号即止——同一条正则也用于宽松场景，避免把 JSON 尾巴吞进版本号
  const m = out.match(/(\d+\.\d+\.\d+[^\s"',}]*)/);
  return m?.[1];
}

/**
 * 纯函数（可测）：从 `npm ls -g @larksuite/cli --json` 输出解析已装版本。
 * JSON.parse 的结果可能是 null（字面量 "null" 也合法），必须挡住非对象再取属性
 */
export function parseNpmLsVersion(out: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(out);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const v = (parsed as { dependencies?: Record<string, { version?: unknown }> })
      .dependencies?.[LARK_CLI_PACKAGE]?.version;
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 纯函数（可测）：包内 CLI 入口绝对路径（不依赖 PATH 的检测/调用锚点）；实测 execFile 正反斜杠均可执行，用平台原生形式即可 */
export function larkCliEntryPath(prefix: string): string {
  return join(prefix, 'node_modules', LARK_CLI_PACKAGE, 'scripts', 'run.js');
}

type ExecRunner = (file: string, args: string[], opts: { timeout: number; windowsHide: boolean; encoding: 'utf8'; env?: NodeJS.ProcessEnv }) => Promise<string>;

/** 生产 runner：execFile promisify；win32 走 cmd /c（.cmd shim，同 npmCommand 先例） */
const defaultRunner: ExecRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, opts as Parameters<typeof execFile>[2], (e, stdout) => {
      if (e) reject(e);
      else resolve(String(stdout));
    });
  });

/**
 * npm 全局前缀：同一进程内稳定，故缓存一次。
 * 但安装完 CLI 前后会变（此前可能压根没有 node_modules），install 成功后主动弃缓存重取。
 * 失败不缓存（下次可重试）。
 */
let prefixCache: string | undefined;

/** npm 全局安装前缀（`npm prefix -g`）；供不依赖 PATH 的检测/调用锚定包位置 */
export async function npmGlobalPrefix(timeoutMs = 15_000): Promise<string> {
  if (prefixCache) return prefixCache;
  const out = await runNpm(['prefix', '-g'], timeoutMs);
  const p = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
  if (!p) throw new Error('npm prefix -g 无输出');
  prefixCache = p;
  return p;
}

/** 弃掉前缀缓存（安装成功后调用；测试用同一入口重置） */
export function resetNpmGlobalPrefixCache(): void {
  prefixCache = undefined;
}

/**
 * 检测 lark-cli 是否已安装 + 版本。**多路兜底，任一命中即已安装**（顺序固定，全部不依赖调用方的 PATH）：
 *   ① `lark-cli` 直接调用（快路径：PATH 正常时一次到位，含非默认安装位置）
 *   ② npm 全局前缀下的包内入口 `scripts/run.js`（主力兜底：绕开 PATH，锁定本机真实安装）
 *   ③ `npm ls -g @larksuite/cli --json`（最后兜底：包在但入口跑不起来时仍能给出已装 + 版本）
 * 历史教训：旧实现只有 ①，PATH 查不到就误报「未安装」，前端据此给出安装按钮，
 * 用户点了反而撞上 npm 重装的文件锁（EBUSY）——已安装的 CLI 被误判成裸机。
 */
export async function detectLarkCli(
  timeoutMs = 10_000,
  runner: ExecRunner = defaultRunner,
  getPrefix: () => Promise<string> = npmGlobalPrefix,
): Promise<LarkCliDetect> {
  const opts = { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' as const, env: stripAgentContextEnv(process.env) };
  // ① PATH 直调（win32 下 lark-cli 是 .cmd shim，execFile 无 PATHEXT 处理，复用 cmd /c 前缀）
  const direct = process.platform === 'win32'
    ? { file: 'cmd', prefixArgs: ['/c', 'lark-cli'] }
    : { file: 'lark-cli', prefixArgs: [] as string[] };
  // 判据统一为「跑通 **且** 解析出版本」：只凭「没抛错」就认已安装，遇到任何不含版本号的
  // 输出都会误报（反向的误判同样有害——页面会显示「已安装/版本未知」而不再给安装入口）
  try {
    const version = parseLarkCliVersion(await runner(direct.file, [...direct.prefixArgs, '--version'], opts));
    if (version) return { installed: true, version };
  } catch { /* 落 ②③ */ }
  // ②③ 需先知道 npm 全局前缀（② 锚定包内入口，③ 锚定 npm 全局装了什么）
  let prefix: string | undefined;
  try { prefix = await getPrefix(); } catch { return { installed: false }; }
  // ② 用 node 绝对路径跑包内入口（不依赖 PATH）
  try {
    const version = parseLarkCliVersion(await runner(process.execPath, [larkCliEntryPath(prefix), '--version'], opts));
    if (version) return { installed: true, version };
  } catch { /* 落 ③ */ }
  // ③ npm 全局装了什么（包在但入口跑不起来时仍能给出已装 + 版本）
  try {
    const out = await runner('cmd', ['/c', 'npm', 'ls', '-g', LARK_CLI_PACKAGE, '--json'], opts);
    const version = parseNpmLsVersion(out);
    // npm ls 在某些情况下对缺失包仍输出 `{"dependencies":{}}`（退出码 0）——**无版本一律视为未安装**，
    // 否则「未安装」会被误报成已装（版本 undefined），前端就不再提供安装入口
    if (version) return { installed: true, version };
  } catch { /* 未装/超时 */ }
  return { installed: false };
}

/** 纯函数（可测）：win32 上 npm 就地重装全局包被文件锁挡住的瞬时错误——退避重试可自愈 */
export function isTransientNpmLockError(message: string): boolean {
  return /EBUSY|EPERM|resource busy or locked|errno -4082|-4094/i.test(message);
}

/** 默认退避：setTimeout 包装（unref 避免拖住进程退出） */
function delay(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

/** install 的重试参数（测试注入 attempts=1 + 零退避即可关掉重试） */
export interface InstallRetryOpts {
  attempts?: number;
  delaysMs?: number[];
  /** 覆盖 npm 执行（测试注入用）；缺省真实 runNpm */
  runNpmFn?: (args: string[], timeoutMs: number) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * npm install -g @larksuite/cli（安装与升级同一命令）；返回 npm 输出。
 *
 * win32 下「就地升级」要先 rename 旧目录再解包，杀毒实时扫描 / 并发 npm / 刚跑过的
 * lark-cli 进程都可能瞬时锁住该目录 → EBUSY。实测该场景下 rename 未留下任何残留、
 * 旧版本毫发无伤，只是这一次没换成——故对**锁类错误**退避重试（共 3 次，1.5s / 3s）；
 * 网络/404 等确定性失败立即抛出，不浪费用户时间。
 */
export async function installLarkCli(timeoutMs = 5 * 60_000, opts: InstallRetryOpts = {}): Promise<string> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delaysMs = opts.delaysMs ?? [1500, 3000];
  const run = opts.runNpmFn ?? runNpm;
  const sleep = opts.sleep ?? delay;
  const log = opts.log ?? ((msg: string) => console.log('[lark-cli]', msg));
  const args = ['install', '-g', `${LARK_CLI_PACKAGE}@latest`];
  let lastMsg = '';
  let lockRelated = false;
  let tried = 0; // 实际尝试次数（非锁类失败会提前放弃，报「3 次」是误导）
  for (let i = 1; i <= attempts; i++) {
    tried = i;
    try {
      const out = await run(args, timeoutMs);
      resetNpmGlobalPrefixCache(); // 装上了 ⇒ 此前缓存的「包不存在」判断作废
      return out;
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
      lockRelated = isTransientNpmLockError(lastMsg);
      // 非锁类错误（网络不可达 / 404 / 无权限装全局）确定性失败，重试没有意义
      if (!lockRelated || i >= attempts) break;
      const wait = delaysMs[Math.min(i - 1, delaysMs.length - 1)] ?? 0;
      log(`⚠️ 安装被文件锁挡住（第 ${i}/${attempts} 次），${wait}ms 后重试…`);
      await sleep(wait);
    }
  }
  // 建议只对锁类失败给出（网络超时却让人去关 lark-cli 终端是误导）
  const hint = lockRelated
    ? '\n若为 Windows 文件锁冲突，请关闭正在运行的 lark-cli 终端及其它 npm 进程后重试（杀毒软件实时扫描也可能短暂占用）。'
    : '';
  throw new Error(`lark-cli 安装失败（尝试 ${tried} 次后放弃）：${lastMsg}${hint}`);
}

/** npm view 查询最新版本（页面「有新版本」提示用） */
export async function checkLarkCliLatest(timeoutMs = 15_000): Promise<string> {
  const out = await runNpm(['view', LARK_CLI_PACKAGE, 'version'], timeoutMs);
  const v = (out.split(/\r?\n/).filter(Boolean).pop() ?? '').trim().replace(/^"|"$/g, '');
  if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error(`无法解析 npm 返回的版本号："${v.slice(0, 50)}"`);
  return v;
}

// ============ 官方 SKILL 安装（官方安装四步的第 ② 步，官方标注"必需"） ============

/** 纯函数（可测）：skill 目录名是否为飞书系 SKILL（feishu / lark 子串均命中） */
export function isFeishuSkillDirName(name: string): boolean {
  return /feishu|lark/i.test(name);
}

export interface LarkCliSkillDetect {
  installed: boolean;
  /** 命中的 skill 目录名（首个） */
  name?: string;
}

/** skill 目录扫描的注入点（测试用）；缺省读真实文件系统 */
export interface SkillDirFs {
  exists(p: string): boolean;
  readdir(d: string): string[];
}

const defaultSkillFs: SkillDirFs = {
  exists: existsSync,
  readdir: (d) => { try { return readdirSync(d); } catch { return []; } },
};

/**
 * 列出已装的飞书官方 SKILL 目录名（默认 ~/.claude/skills，与安装动作同源）。
 * 判据：目录名命中 feishu/lark **且** 内含 SKILL.md（防同名散目录误报）。
 * managed 会话的可见性由 bridgeUserSkills() 启动桥接保证，这里不查托管目录。
 *
 * 以扫盘而非解析 `npx skills add` 的输出来确定「装了什么」：那份输出是带 ANSI 的
 * 进度表，既难读也不可靠；目录才是既成事实。
 */
export async function listLarkCliSkills(
  skillsDir: string = join(homedir(), '.claude', 'skills'),
  fs: SkillDirFs = defaultSkillFs,
): Promise<string[]> {
  if (!fs.exists(skillsDir)) return [];
  const names: string[] = [];
  for (const name of fs.readdir(skillsDir)) {
    if (!isFeishuSkillDirName(name)) continue;
    if (fs.exists(join(skillsDir, name, 'SKILL.md'))) names.push(name);
  }
  return names;
}

/** 检测飞书官方 SKILL 是否已装：取扫盘结果的首个（保持既有返回结构不变） */
export async function detectLarkCliSkill(
  skillsDir: string = join(homedir(), '.claude', 'skills'),
  fs: SkillDirFs = defaultSkillFs,
): Promise<LarkCliSkillDetect> {
  const [name] = await listLarkCliSkills(skillsDir, fs);
  return name ? { installed: true, name } : { installed: false };
}

export interface InstallSkillOpts {
  /** 覆盖 npx 执行（测试注入）；缺省真实 runNpx */
  runNpxFn?: (args: string[], timeoutMs: number) => Promise<string>;
  /** 装好后复扫的目标目录（测试注入用） */
  skillsDir?: string;
  log?: (msg: string) => void;
}

/**
 * 安装飞书官方 SKILL（`npx skills add`，落盘 ~/.claude/skills）：
 *  - `--copy` 必须——skills CLI 默认 symlink，Windows 上需开发者模式/管理员权限，必挂；
 *  - 装完复扫确认落盘，扫不到视为失败（npx 静默空转的场景不能谎报成功）；
 *  - **不做任何拷贝**：managed 会话由既有 bridgeUserSkills() 在 lcb start 时 junction 桥接，
 *    装完需重启桥接器生效。
 */
export async function installLarkCliSkill(timeoutMs = 3 * 60_000, opts: InstallSkillOpts = {}): Promise<string> {
  const run = opts.runNpxFn ?? runNpx;
  const log = opts.log ?? ((msg: string) => console.log('[lark-cli]', msg));
  log(`安装飞书 CLI 官方 SKILL（npx skills add ${LARK_CLI_SKILL_SOURCE}）…`);
  const output = await run(
    ['-y', 'skills', 'add', LARK_CLI_SKILL_SOURCE, '--skill', '*', '-g', '-a', 'claude-code', '--copy', '-y'],
    timeoutMs,
  );
  const skillsDir = opts.skillsDir ?? join(homedir(), '.claude', 'skills');
  const after = await detectLarkCliSkill(skillsDir);
  if (!after.installed) {
    throw new Error(`SKILL 安装命令已执行但在 ${skillsDir} 未发现飞书 skill（npx 输出：${String(output).slice(0, 200) || '空'}）`);
  }
  log(`✅ SKILL 安装完成：${after.name}（重启桥接器后 managed 会话可见）`);
  return output;
}

/**
 * 纯函数（可测）：授权状态是否为「应用未配置」——决定概览页给「配置应用」还是「去终端授权」。
 * detail 的两个来源（error.subtype / reason）实测均含 not_configured 字样。
 */
export function needsLarkCliConfig(auth: LarkCliAuthStatus): boolean {
  return auth.state === 'unauthorized' && /not_configured/i.test(auth.detail ?? '');
}

export interface StartupCheckDeps {
  detect(): Promise<LarkCliDetect>;
  detectSkill(): Promise<LarkCliSkillDetect>;
  log(msg: string): void;
}

/**
 * 启动时的飞书 CLI 检查（依赖注入可测）——**只探测，绝不安装**。
 *
 * 安装统一下沉到 Web 配置页（用户决策）：启动时静默装会让用户对安装过程无感，
 * 也就跳过了官方流程的后三步（SKILL / config init / auth login）——等打开配置页时
 * CLI 已就绪却从未配置过飞书应用，直接卡在「未授权」而无从下手；用户此时若自己点
 * 「安装」，还会和后台那次抢 npm 文件锁。这里只把现状与去处讲清楚。
 *
 * **绝不抛出**：桥接器启动不能被外部工具的探测异常拖垮。
 */
export async function checkLarkCliAtStartup(deps: Partial<StartupCheckDeps> = {}): Promise<LarkCliDetect> {
  const detect = deps.detect ?? (() => detectLarkCli());
  const detectSkill = deps.detectSkill ?? (() => detectLarkCliSkill());
  const log = deps.log ?? ((msg: string) => console.log('[lark-cli]', msg));
  const d = await detect();
  if (!d.installed) {
    log('未检测到飞书官方 CLI（@larksuite/cli）。安装统一由配置页发起，启动时不自动装——'
      + '请打开 Web 配置页（lcb ui），在「飞书 CLI」一栏点「安装」');
    return d;
  }
  log(`✅ lark-cli 已安装${d.version ? ` v${d.version}` : '（版本未知）'}`);
  // 官方安装第 ② 步（SKILL）：启动链只告警不自动装——skills add 要走网络下载，
  // 不能让桥接器启动背这个任务；Web 概览页提供「装 SKILL」按钮
  const skill = await detectSkill().catch(() => ({ installed: false } as LarkCliSkillDetect));
  if (!skill.installed) {
    log('⚠️ 官方 SKILL 未安装（教 AI 怎么用 lark-cli 的说明书）：'
      + '请在 Web 配置页概览区点「装 SKILL」，或手动执行 npx -y skills add https://open.feishu.cn --skill \'*\' -g -a claude-code --copy -y');
  }
  return d;
}

// ============ 授权状态探测 ============

export type LarkCliAuthState = 'authorized' | 'unauthorized' | 'unknown';

export interface LarkCliAuthStatus {
  state: LarkCliAuthState;
  /** 未授权的原因（error.subtype / message / reason），供 UI 悬浮提示 */
  detail?: string;
  /** 已授权时的可读身份（账号名 / 邮箱） */
  identity?: string;
}

/** 未授权类信号（ok:true 也可能带这些 reason —— 见 parseLarkCliAuth 的第二个实测陷阱） */
const NEGATIVE_REASON = /not_configured|not_authenticated|unauthenticated|no_credential|expired/i;

/**
 * 纯函数（可测）：取文本里第一个**大括号平衡**的 JSON 对象。
 * lark-cli 的输出前后可能夹日志，且未授权时整个 JSON 走 stderr——两个流都要能扫。
 */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function pickIdentity(u: unknown): string | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const o = u as Record<string, unknown>;
  // 蛇形（旧格式）与驼峰（v1.0.96 identities）并存：两种形状都用同一套候选
  return str(o.name) ?? str(o.user_name) ?? str(o.userName)
    ?? str(o.email) ?? str(o.open_id) ?? str(o.openId) ?? str(o.user_id);
}

/** 解析不出结构时的诊断线索：正文首片段（压缩空白 + 截断），供前端 tooltip 自查 */
function unknownDetail(raw: { stdout: string; stderr: string }): string {
  const text = (raw.stdout.trim() || raw.stderr.trim()).replace(/\s+/g, ' ');
  return text ? `无法识别的输出：${text.slice(0, 120)}` : '命令没有任何输出（lark-cli 可能未正常运行）';
}

/**
 * 纯函数（可测）：解析 v1.0.96 的 `identities` 结构。
 * 非该形状（无 identities / 空对象）返回 undefined——交给旧格式判定，不在这里下结论。
 *
 * 实测形状（已授权）：`{appId, brand, defaultAs, identities:{bot:{status},user:{status:"ready",userName,...}}, identity}`
 */
function parseIdentities(v: unknown): LarkCliAuthStatus | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const ids = v as Record<string, unknown>;
  const user = ids.user;
  if (!user || typeof user !== 'object') {
    // 只有 bot 就绪、没有 user 键：auth login 授权的是 **user 身份**，bot ready 不等于已登录
    if (ids.bot && typeof ids.bot === 'object') {
      return { state: 'unauthorized', detail: '未登录用户身份（仅 bot 就绪，需执行 lark-cli auth login）' };
    }
    return undefined;
  }
  const u = user as Record<string, unknown>;
  if (str(u.status) === 'ready') return { state: 'authorized', identity: pickIdentity(u) };
  return { state: 'unauthorized', detail: str(u.status) ?? str(u.message) ?? '用户身份未就绪' };
}

/**
 * 纯函数（可测）：从 auth status 的原始输出判定登录态。
 *
 * 两个**实测**陷阱（都不可靠地凭直觉推导）：
 *  ① 未授权时 JSON 写在 **stderr**、退出码 **3**、stdout 空 —— 判据绝不能看退出码；
 *  ② `auth list` 未登录时返回 `{ok:true, reason:"not_configured", users:[]}` ——
 *     `ok:true` 不等于已授权，必须找正向证据（users 非空）。
 *
 * 反向误判同样有害：解析不出来时退 **unknown** 而非 unauthorized ——
 * 把「不知道」说成「未授权」会让用户白跑一趟终端。
 */
export function parseLarkCliAuth(raw: { stdout: string; stderr: string; code: number | null }): LarkCliAuthStatus {
  const obj = firstJsonObject(raw.stdout) ?? firstJsonObject(raw.stderr);
  if (!obj || typeof obj !== 'object') return { state: 'unknown', detail: unknownDetail(raw) };
  const o = obj as Record<string, unknown>;
  // ③ v1.0.96 实测：已授权时输出 identities 结构，**没有** ok/users/reason 三个旧字段——
  // 只认旧字段会把「已授权」误报成「授权未知」。
  const viaIdentities = parseIdentities(o.identities);
  if (viaIdentities) return viaIdentities;
  if (o.ok === false) {
    const err = (o.error ?? {}) as Record<string, unknown>;
    return { state: 'unauthorized', detail: str(err.subtype) ?? str(err.message) };
  }
  const reason = str(o.reason);
  if (reason && NEGATIVE_REASON.test(reason)) return { state: 'unauthorized', detail: reason };
  if (Array.isArray(o.users)) {
    const first = o.users[0];
    return first
      ? { state: 'authorized', identity: pickIdentity(first) }
      : { state: 'unauthorized', detail: reason ?? '未登录任何账号' };
  }
  if (o.ok === true) {
    const identity = str(o.identity) ?? str(o.user) ?? str(o.name) ?? str(o.email);
    return identity ? { state: 'authorized', identity } : { state: 'authorized' };
  }
  return { state: 'unknown', detail: unknownDetail(raw) };
}

export type AuthRunner = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide: boolean; encoding: 'utf8'; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/** 双流捕获。字符串 code（ENOENT/EACCES）才算「没跑起来」→ reject；数字退出码一律 resolve 交给解析 */
export const defaultAuthRunner: AuthRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, opts as Parameters<typeof execFile>[2], (e, stdout, stderr) => {
      const code = (e as { code?: unknown } | null)?.code;
      if (e && typeof code === 'string') { reject(e); return; }
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: typeof code === 'number' ? code : null,
      });
    });
  });

/**
 * 探测授权状态（纯本地，约百毫秒级——页面轮询靠它，因此**不加 `--verify`**：那需要联网）。
 * 命令跑不起来时退到 node + 包内入口，与 detectLarkCli 第 ② 路同源。
 */
export async function checkLarkCliAuth(timeoutMs = 8_000, runner: AuthRunner = defaultAuthRunner): Promise<LarkCliAuthStatus> {
  const opts = { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' as const, env: stripAgentContextEnv(process.env) };
  const direct = process.platform === 'win32'
    ? { file: 'cmd', prefixArgs: ['/c', 'lark-cli'] }
    : { file: 'lark-cli', prefixArgs: [] as string[] };
  try {
    return parseLarkCliAuth(await runner(direct.file, [...direct.prefixArgs, 'auth', 'status', '--json'], opts));
  } catch { /* 落②：命令没跑起来 */ }
  try {
    const prefix = await npmGlobalPrefix();
    return parseLarkCliAuth(await runner(process.execPath, [larkCliEntryPath(prefix), 'auth', 'status', '--json'], opts));
  } catch (e) {
    return { state: 'unknown', detail: `探测命令未能运行：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ============ 设备流授权（页面二维码） ============
//
// 与「拉终端」那条路并列的第二种授权方式：把 lark-cli 的 device flow 搬到配置页里，
// 用户直接扫码完成，不用切窗口。**比终端路径更通用**——它不经过终端探测，因此
// 无桌面 / SSH 环境同样可用（那条路上「去终端授权」原本是无出口的死路）。
//
// 三段式（实测 v1.0.96 的真实输出，见 parseLarkCliDeviceStart 注释）：
//   ① `auth login --recommend --no-wait --json` → device_code + verification_url（立即返回）
//   ② `auth qrcode <url> -o qr.png` → 二维码（cwd 落在 lark-cli 的允许根内，故可落盘）
//   ③ `auth login --device-code <code> --json` → 用户扫完后收尾换 token（阻塞轮询，放后台跑）
//
// 收尾必须后台跑：token 是 ③ 那次调用去飞书换回来并落盘的，不跑它 auth status 永远停在
// unauthorized；而让前端在用户扫完后触发一个阻塞请求也不可行（请求被吊住数分钟、前端
// 无从知道用户何时扫完）。故 ③ 在后台自行轮询，前端只轮询一个零成本的内存态端点。

/**
 * 纯函数（可测）：剥掉 ANSI SGR 序列与 BOM。
 * `--json` 理论上不带色，但 lark-cli changelog #169「Correct URL formatting in login --no-wait
 * output」说明这个位置历史上出过 URL 格式事故；ANSI 混进 JSON 字符串会直接毁掉 JSON.parse。
 */
export function stripAnsiAndBom(text: string): string {
  // 用 \x1b / \uFEFF 转义而非字面控制字符：后者在源码里不可见，会被编辑器或工具链悄悄吃掉
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\uFEFF/, '');
}

/** win32 下 lark-cli 是 .cmd shim，execFile 无 PATHEXT 处理，统一走 cmd /c */
function larkCliDirect(): { file: string; prefixArgs: string[] } {
  return process.platform === 'win32'
    ? { file: 'cmd', prefixArgs: ['/c', 'lark-cli'] }
    : { file: 'lark-cli', prefixArgs: [] };
}

export interface LarkCliDeviceStart {
  /** ★ 只进内存，绝不出 HTTP */
  deviceCode: string;
  verificationUrl: string;
  /** 人可读短码（手输兜底）；实测无独立字段，从 URL 的 query 里取 */
  userCode?: string;
  expiresInSec: number;
  intervalSec: number;
}

/** 字段取值：先顶层再 data 包装——实测 login 是平铺的，但也兼容 README 的 {ok,data} 信封 */
function pickField(o: Record<string, unknown>, keys: string[]): unknown {
  const data = o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : undefined;
  for (const k of keys) {
    if (o[k] !== undefined) return o[k];
    if (data && data[k] !== undefined) return data[k];
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** 从 verification_url 里取 user_code（只读提取，URL 本身仍按 opaque string 原样使用） */
function userCodeFromUrl(url: string): string | undefined {
  const m = /[?&]user_code=([^&\s]+)/.exec(url);
  return m ? m[1] : undefined;
}

/** 首个片段（压缩空白 + 截断），供失败时的诊断线索 */
function snippet(stdout: string, stderr: string): string {
  return (stdout.trim() || stderr.trim()).replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * 纯函数（可测）：解析 `auth login --no-wait --json` 的输出。
 *
 * **实测形状（v1.0.96）——平铺，没有 ok/data 信封**，与 lark-cli README 的「JSON Output Contract」
 * 不一致（该契约显然不覆盖本命令）：
 *   {"device_code":"…","expires_in":600,"hint":"…",
 *    "verification_url":"https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=…&user_code=WAFK-BYM3"}
 * 注意实测**没有** interval、也**没有**独立的 user_code 字段（只在 URL 的 query 里）。
 * 解析器仍对文件级信封与 verification_uri 命名做兼容，不赌单一形状。
 *
 * deviceCode 或 URL 任一缺失即失败——半成品会让前端显示一个扫了没反应的二维码，
 * 比直接报错难排查十倍。
 */
export function parseLarkCliDeviceStart(
  raw: { stdout: string; stderr: string; code: number | null },
): { ok: true; value: LarkCliDeviceStart } | { ok: false; error: string } {
  // 两个流都扫：与 parseLarkCliAuth 同源——lark-cli 出错时 JSON 可能整个走 stderr
  const obj = firstJsonObject(stripAnsiAndBom(raw.stdout)) ?? firstJsonObject(stripAnsiAndBom(raw.stderr));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const s = snippet(raw.stdout, raw.stderr);
    return { ok: false, error: s ? `无法识别的输出：${s}` : '命令没有任何输出（lark-cli 可能未正常运行）' };
  }
  const o = obj as Record<string, unknown>;
  if (o.ok === false) {
    const err = (o.error ?? {}) as Record<string, unknown>;
    return { ok: false, error: str(err.subtype) ?? str(err.message) ?? str(err.hint) ?? 'lark-cli 未返回设备流信息' };
  }
  const deviceCode = str(pickField(o, ['device_code', 'deviceCode']));
  const url = str(pickField(o, [
    'verification_url', 'verification_uri', 'verification_uri_complete',
    'verificationUrl', 'verificationUri',
  ]));
  if (!deviceCode || !url) {
    const missing = !deviceCode ? 'device_code' : '授权链接';
    return { ok: false, error: `设备流信息不完整（缺 ${missing}）：${snippet(raw.stdout, raw.stderr)}` };
  }
  return {
    ok: true,
    value: {
      deviceCode,
      verificationUrl: url,
      userCode: str(pickField(o, ['user_code', 'userCode'])) ?? userCodeFromUrl(url),
      // 实测 expires_in=600、无 interval 字段；取值做缺省与 clamp，防异常值把倒计时搞乱
      expiresInSec: clamp(num(pickField(o, ['expires_in', 'expiresIn'])) ?? 600, 30, 3600),
      intervalSec: clamp(num(pickField(o, ['interval'])) ?? 5, 1, 60),
    },
  };
}

/** 设备流失败时的人话映射（subtype → 用户能看懂的话） */
const DEVICE_ERR_TEXT: Record<string, string> = {
  expired_token: '二维码已过期，请重新生成',
  access_denied: '已拒绝本次授权',
  authorization_pending: '授权尚未完成',
  slow_down: '授权尚未完成',
};

function parseDeviceError(stdout: string, stderr: string): { subtype?: string; message?: string } {
  const obj = firstJsonObject(stripAnsiAndBom(stderr)) ?? firstJsonObject(stripAnsiAndBom(stdout));
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    const e = (o.error ?? {}) as Record<string, unknown>;
    return {
      subtype: str(e.subtype) ?? str(o.subtype),
      message: str(e.message) ?? str(o.message) ?? str(e.hint),
    };
  }
  return { message: snippet(stdout, stderr) || undefined };
}

export interface LarkCliDeviceOutcome {
  phase: 'done' | 'failed' | 'expired';
  identity?: string;
  error?: string;
}

/**
 * 纯函数（可测）：收尾进程结束后判定本次设备流的结果。
 *
 * **这是整个设备流最容易出错的地方**：已授权用户点「重新授权」再扫一次码时，
 * checkAuth() 前后都是 authorized——**状态探测无法区分「本来就好」与「本次扫码完成」**。
 * 唯一可靠的正向信号是收尾进程的退出码。
 *
 * 正向兜底可以有（未授权 → 已授权的跃迁必然意味着本次扫码成功），
 * 但**反向兜底绝不能有**：wasAuthorized=true 且 exit≠0 时必须 failed，
 * 否则会把「本来就已授权」误报成「本次扫码成功」——已授权用户一打开弹窗就会看到
 * "✅ 授权完成"，而他其实什么都没扫。
 */
export function decideDeviceFinishOutcome(a: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  wasAuthorized: boolean;
  authAfter?: LarkCliAuthStatus;
}): LarkCliDeviceOutcome {
  if (a.exitCode === 0) return { phase: 'done', identity: a.authAfter?.identity };
  if (!a.wasAuthorized && a.authAfter?.state === 'authorized') {
    return { phase: 'done', identity: a.authAfter.identity };
  }
  const err = parseDeviceError(a.stdout, a.stderr);
  const mapped = err.subtype ? DEVICE_ERR_TEXT[err.subtype] : undefined;
  return {
    phase: err.subtype === 'expired_token' ? 'expired' : 'failed',
    error: mapped ?? err.message ?? err.subtype ?? '授权失败',
  };
}

// ---- 内存会话状态（进程内单例） ----

export type LarkCliDeviceState = 'pending' | 'done' | 'failed' | 'expired' | 'none';

interface DeviceSession {
  /** 代号：新一轮发起时 +1；在飞的收尾进程回来后靠它丢弃过期结果（不依赖 kill） */
  gen: number;
  state: Exclude<LarkCliDeviceState, 'none'>;
  /** ★ 只存这里，任何出网构造都不带它 */
  deviceCode: string;
  verificationUrl: string;
  userCode?: string;
  /** 约 2KB data URL；存进会话，重开弹窗命中幂等复用时连图一起返回 */
  qrDataUrl?: string;
  expiresAt: number;
  intervalSec: number;
  /** 发起时的授权态快照——区分「本来就好」与「本次扫码完成」的唯一依据 */
  wasAuthorized: boolean;
  identity?: string;
  error?: string;
}

export interface LarkCliDeviceSessionInfo {
  ok: boolean;
  state?: LarkCliDeviceState;
  verificationUrl?: string;
  /** 仅 start 返回（status 每 2s 轮询，不重复传几 KB 图） */
  qrDataUrl?: string;
  userCode?: string;
  /** 每次现算的剩余秒数 */
  expiresInSec?: number;
  intervalSec?: number;
  reused?: boolean;
  identity?: string;
  error?: string;
  /** 未装 / 未配置——让前端把用户导到对应入口而不是干瞪眼 */
  hint?: 'install' | 'config';
}

let deviceSession: DeviceSession | null = null;
let deviceGen = 0;
let deviceStartInflight: Promise<LarkCliDeviceSessionInfo> | null = null;

/** 剩余不足此值视为已过期：与其返回一个马上失效的二维码，不如直接新建一轮 */
const DEVICE_MIN_REMAIN_MS = 30_000;
/** 收尾进程超时 = 设备码寿命 + 此余量 */
const DEVICE_FINISH_SLACK_MS = 30_000;
const DEVICE_MAX_LIFETIME_MS = 3_600_000;

/** 二维码临时目录（与 terminal-window.ts 的 tmp 用法同源） */
export function larkCliQrDir(tmpDir?: string): string {
  return join(tmpDir ?? tmpdir(), 'lcb-larkcli-qr');
}

/**
 * 唯一的出网构造点：**显式挑字段**（不是 {...session} 展开）——结构上杜绝 device_code 泄漏。
 * 顺带做懒过期：pending 且已超期就地转 expired，且 expired 不再返回 URL/二维码。
 */
function deviceInfo(now = Date.now(), withQr = false): LarkCliDeviceSessionInfo {
  const s = deviceSession;
  if (!s) return { ok: true, state: 'none' };
  if (s.state === 'pending' && now > s.expiresAt + DEVICE_FINISH_SLACK_MS) s.state = 'expired';
  const base: LarkCliDeviceSessionInfo = {
    ok: true,
    state: s.state,
    userCode: s.userCode,
    intervalSec: s.intervalSec,
    identity: s.identity,
    error: s.error,
  };
  if (s.state === 'pending') {
    base.verificationUrl = s.verificationUrl;
    base.expiresInSec = Math.max(0, Math.round((s.expiresAt - now) / 1000));
    if (withQr) base.qrDataUrl = s.qrDataUrl;
  }
  return base;
}

/** 内存态查询（零副作用、亚毫秒）——撑住前端 2s 轮询 */
export function getLarkCliDeviceStatus(now = Date.now()): LarkCliDeviceSessionInfo {
  return deviceInfo(now);
}

/**
 * 清掉临时二维码文件（尽力而为，失败不影响流程）。
 * **必须带文件名**：设备流与配置流各用各的文件，否则一边 abandon 会把另一边
 * 正在生成/读回的二维码删掉，或两条流互相覆盖同一文件导致画面张冠李戴。
 */
function removeQrFile(log: (m: string) => void, fileName = 'qr.png'): void {
  try {
    rmSync(join(larkCliQrDir(), fileName), { force: true });
  } catch (e) {
    log(`清理二维码临时文件失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 放弃当前会话（改用终端 / 新一轮发起前）。
 * **不 kill 子进程**：Windows 上 execFile('cmd', …) 的进程树是 cmd → node → lark-cli.exe，
 * kill 直接子进程往往留下孤儿。靠 gen 失配丢弃结果 + execFile 的 timeout 自灭即可——
 * 孤儿最多空转到 device code 过期后自行退出。
 */
export function abandonLarkCliDeviceSession(): void {
  if (!deviceSession) return;
  deviceGen++;
  deviceSession = null;
  removeQrFile(() => { /* 静默：放弃路径不打扰用户 */ });
}

/** 重置编排 + 设备流状态（测试用） */
export function resetLarkCliDeviceState(): void {
  deviceSession = null;
  deviceGen = 0;
  deviceStartInflight = null;
}

/**
 * 纯函数（可测）：cmd.exe 下的参数转义。
 *
 * **这不是洁癖，是实测踩出来的**：verification_url 必然含 `&`（`?flow_id=…&user_code=…`），
 * 而 `cmd /c lark-cli … <url>` 会把 `&` 当成**命令分隔符**，命令被截断成两条，
 * 二维码文件压根不生成（只留一个莫名其妙的 ENOENT）。
 * 注意：Node 只在参数含空格/制表符时才加引号，飞书 URL 不含空格，所以 `&` 是裸奔到 cmd 的。
 */
export function cmdEscapeArg(s: string): string {
  return s.replace(/[&|<>^()]/g, (c) => `^${c}`);
}

/**
 * 生成二维码 data URL。失败返回 undefined——**二维码只是展示层**，生成不出来就降级为
 * 只显示可复制链接，设备流照常进行。
 * cwd 设为专用 tmp 子目录：lark-cli 的写路径允许根是 cwd / /tmp / ~/files（实测 cwd 生效），
 * 故 -o 用相对名即可落进允许根。
 */
export async function defaultMakeQr(
  url: string,
  runner: AuthRunner = defaultAuthRunner,
  log: (m: string) => void = () => { /* 默认静默 */ },
  tmpDir?: string,
  fileName = 'qr.png',
): Promise<string | undefined> {
  const dir = larkCliQrDir(tmpDir);
  const args = ['auth', 'qrcode', url, '-o', fileName, '--size', '512'];
  const opts = { timeout: 10_000, windowsHide: true, encoding: 'utf8' as const, env: stripAgentContextEnv(process.env), cwd: dir };
  try {
    mkdirSync(dir, { recursive: true });
    // ★ 优先走 node + 包内入口：**不经过任何 shell 重解析**，天然免疫上面那个 `&` 陷阱。
    // 与 checkLarkCliAuth 的第 ② 路同源（绕开 PATH，锚定本机真实安装）。
    let done = false;
    try {
      const prefix = await npmGlobalPrefix();
      await runner(process.execPath, [larkCliEntryPath(prefix), ...args], opts);
      done = true;
    } catch { /* 落 cmd 兜底 */ }
    if (!done) {
      // 兜底路径要转义——这里没有 node 可锚定，只能经 cmd
      const d = larkCliDirect();
      await runner(d.file, [...d.prefixArgs, 'auth', 'qrcode', cmdEscapeArg(url), '-o', fileName, '--size', '512'], opts);
    }
    return `data:image/png;base64,${readFileSync(join(dir, fileName)).toString('base64')}`;
  } catch (e) {
    log(`二维码生成失败（降级为只显示链接）：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

export interface LarkCliDeviceDeps {
  runner: AuthRunner;
  finishRunner: AuthRunner;
  detect(): Promise<LarkCliDetect>;
  checkAuth(): Promise<LarkCliAuthStatus>;
  makeQr(url: string): Promise<string | undefined>;
  now(): number;
  log(msg: string): void;
}

/**
 * 后台收尾：spawn `auth login --device-code <CODE>` 让它自己按 interval 轮询，
 * 用户扫码（或超时）后自然返回。结果写回会话。
 * 超时 = 设备码寿命 + 30s，1 小时封顶——不设的话用户不扫时这个进程会挂满整段时间。
 */
async function runLarkCliDeviceFinish(s: DeviceSession, deps: LarkCliDeviceDeps): Promise<void> {
  const remain = Math.max(s.expiresAt - deps.now(), DEVICE_FINISH_SLACK_MS);
  const timeoutMs = Math.min(remain + DEVICE_FINISH_SLACK_MS, DEVICE_MAX_LIFETIME_MS);
  // device code 实测是 base64url 字符集（无元字符），转义对它是 no-op——纯防御：
  // 万一将来格式变了，也不至于在 cmd 下被 `&` 截断成另一个命令
  const args = ['auth', 'login', '--device-code', cmdEscapeArg(s.deviceCode), '--json'];
  const opts = { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' as const, env: stripAgentContextEnv(process.env) };
  try {
    let raw: { stdout: string; stderr: string; code: number | null };
    try {
      const d = larkCliDirect();
      raw = await deps.finishRunner(d.file, [...d.prefixArgs, ...args], opts);
    } catch (e) {
      if (typeof (e as { code?: unknown })?.code !== 'string') {
        const prefix = await npmGlobalPrefix();
        raw = await deps.finishRunner(process.execPath, [larkCliEntryPath(prefix), ...args], opts);
      } else { throw e; }
    }
    // gen 失配 = 已被新一轮取代 → 丢弃结果，绝不污染新会话
    if (deviceSession?.gen !== s.gen) return;
    const authAfter = raw.code === 0 ? await deps.checkAuth().catch(() => undefined) : undefined;
    const out = decideDeviceFinishOutcome({
      exitCode: raw.code, stdout: raw.stdout, stderr: raw.stderr,
      wasAuthorized: s.wasAuthorized, authAfter,
    });
    s.state = out.phase;
    s.identity = out.identity;
    s.error = out.error;
  } catch (e) {
    if (deviceSession?.gen !== s.gen) return;
    // 含 execFile timeout kill：超期就说过期，否则是执行失败
    s.state = deps.now() >= s.expiresAt ? 'expired' : 'failed';
    s.error = e instanceof Error ? e.message : String(e);
  }
}

/**
 * 发起设备流授权（页面二维码的主入口）。
 *
 * 四道闸挡住「每点一次就多一个 flow」：
 *   ① 幂等复用：未过期的 pending 会话直接返回同一个 URL（挡住刷新页面 / 关弹窗再开）
 *   ② in-flight 合并：并发调用 await 同一个 promise（挡住双击）
 *   ③ regenerate：用户显式要求时才新建
 *   ④ gen 代号：新建时 +1，在飞的老收尾进程靠它丢弃过期结果
 */
export async function startLarkCliDeviceAuth(
  opts: { regenerate?: boolean; deps?: Partial<LarkCliDeviceDeps> } = {},
): Promise<LarkCliDeviceSessionInfo> {
  const deps: LarkCliDeviceDeps = {
    runner: opts.deps?.runner ?? defaultAuthRunner,
    finishRunner: opts.deps?.finishRunner ?? defaultAuthRunner,
    detect: opts.deps?.detect ?? (() => detectLarkCli()),
    checkAuth: opts.deps?.checkAuth ?? (() => checkLarkCliAuth()),
    makeQr: opts.deps?.makeQr ?? ((url) => defaultMakeQr(url, opts.deps?.runner ?? defaultAuthRunner, deps.log)),
    now: opts.deps?.now ?? (() => Date.now()),
    log: opts.deps?.log ?? ((m: string) => console.log('[lark-cli]', m)),
  };
  const now = deps.now();

  // ① 幂等复用（regenerate 时跳过）
  if (!opts.regenerate && deviceSession?.state === 'pending' && deviceSession.expiresAt - now > DEVICE_MIN_REMAIN_MS) {
    return { ...deviceInfo(now, true), reused: true };
  }
  // ② 并发合并
  if (deviceStartInflight) return deviceStartInflight;

  const task = (async (): Promise<LarkCliDeviceSessionInfo> => {
    const d = await deps.detect();
    if (!d.installed) {
      return { ok: false, hint: 'install', error: 'lark-cli 未安装，请先安装后再授权' };
    }
    // 未配置应用时 --no-wait 必然失败：提前拦，给出准确引导而不是一个费解的 API 错误
    const before = await deps.checkAuth();
    if (needsLarkCliConfig(before)) {
      return { ok: false, hint: 'config', error: '飞书应用尚未配置，无法发起扫码授权（请先点「配置应用」）' };
    }

    abandonLarkCliDeviceSession(); // ③ gen++

    const args = ['auth', 'login', '--recommend', '--no-wait', '--json'];
    const runnerOpts = { timeout: 20_000, windowsHide: true, encoding: 'utf8' as const, env: stripAgentContextEnv(process.env) };
    let raw: { stdout: string; stderr: string; code: number | null };
    try {
      const direct = larkCliDirect();
      raw = await deps.runner(direct.file, [...direct.prefixArgs, ...args], runnerOpts);
    } catch {
      try {
        const prefix = await npmGlobalPrefix();
        raw = await deps.runner(process.execPath, [larkCliEntryPath(prefix), ...args], runnerOpts);
      } catch (e) {
        return { ok: false, error: `设备流命令未能运行：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const parsed = parseLarkCliDeviceStart(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const s: DeviceSession = {
      gen: ++deviceGen,
      state: 'pending',
      deviceCode: parsed.value.deviceCode,
      verificationUrl: parsed.value.verificationUrl,
      userCode: parsed.value.userCode,
      expiresAt: now + parsed.value.expiresInSec * 1000,
      intervalSec: parsed.value.intervalSec,
      wasAuthorized: before.state === 'authorized',
    };
    deviceSession = s;
    // 二维码只是展示层，生成失败不阻塞授权
    s.qrDataUrl = await deps.makeQr(s.verificationUrl).catch(() => undefined);
    void runLarkCliDeviceFinish(s, deps); // ④ 后台收尾，不 await
    return deviceInfo(deps.now(), true);
  })();

  deviceStartInflight = task;
  try {
    return await task;
  } finally {
    deviceStartInflight = null;
  }
}

// ============ 配置应用（页面二维码） ============
//
// 官方安装流程的第 ③ 步 `lark-cli config init --new` 同样搬进配置页：未配置应用的用户
// 直接扫码创建，不用切终端窗口（无桌面 / SSH 环境下那条路原本根本没有出口）。
//
// **这不是「换个地方跑」，而是回到官方设计的用法**：lark-cli 的 README.zh.md 与内置 skill
// （lark-shared/references/lark-shared-config-init.md）都明确规定——后台运行该命令，
// 从输出里解析授权链接发给用户，用户在浏览器完成后命令自动退出。bridge 早先把它丢给
// 独立终端，链接因此永远回传不了本进程（终端里的 stdout 不属于 bridge）。
//
// 与设备流的**唯一机制差异**：`config init` 没有 `--no-wait`，会一直阻塞到用户完成或过期，
// 所以不能用 execFile（那要等进程退出才拿得到输出）——必须 spawn 后**流式**监听
// stdout/stderr，边读边找链接。其余（幂等复用 / 并发合并 / gen 代号 / 出网挑字段）
// 全部沿用设备流已验证的骨架。

export type LarkCliConfigState = 'pending' | 'done' | 'failed' | 'expired' | 'none';

interface ConfigSession {
  /** 代号：新一轮发起时 +1；在飞的老子进程回来后靠它丢弃过期结果（不依赖 kill） */
  gen: number;
  state: Exclude<LarkCliConfigState, 'none'>;
  /** 从子进程输出里解析到的链接；还没解析到时为 undefined（前端显示「正在申请…」） */
  verificationUrl?: string;
  /** 人可读短码（手输兜底）；从链接的 query 里取 */
  userCode?: string;
  /** 约 2KB data URL */
  qrDataUrl?: string;
  startedAt: number;
  error?: string;
}

export interface LarkCliConfigSessionInfo {
  ok: boolean;
  state?: LarkCliConfigState;
  verificationUrl?: string;
  userCode?: string;
  qrDataUrl?: string;
  reused?: boolean;
  error?: string;
  /** 未安装——让前端把用户导到「安装」入口而不是干瞪眼 */
  hint?: 'install';
}

/**
 * 子进程最小结构（便于测试注入假实现）。
 * 真实实现由 defaultConfigSpawn 把 node 的 ChildProcess 收窄成它。
 */
export interface LarkCliConfigChild {
  stdout: { on(ev: 'data', cb: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(ev: 'data', cb: (chunk: Buffer) => void): unknown } | null;
  on(ev: 'exit', cb: (code: number | null) => void): unknown;
  on(ev: 'error', cb: (err: Error) => void): unknown;
}

export interface LarkCliConfigDeps {
  spawn: (file: string, args: string[], opts: { windowsHide: boolean; env: NodeJS.ProcessEnv }) => LarkCliConfigChild;
  detect(): Promise<LarkCliDetect>;
  checkAuth(): Promise<LarkCliAuthStatus>;
  makeQr(url: string): Promise<string | undefined>;
  now(): number;
  log(msg: string): void;
}

let configSession: ConfigSession | null = null;
let configGen = 0;
let configStartInflight: Promise<LarkCliConfigSessionInfo> | null = null;

/**
 * 迟迟解析不到链接的上限。它只负责**给前端一个出口**（UI 不留无出口死角）：
 * 走到这里说明命令既没吐链接、也没退出（网络卡住 / 输出形态和预期不一样）。
 */
const CONFIG_URL_WAIT_MS = 120_000;
/** start 请求内等待链接的时间：正常就是一次网络往返，超了就改为让前端轮询 status */
const CONFIG_START_WAIT_MS = 30_000;
/** 子进程输出缓冲上限（防无限增长；链接只有几百字节，余量充足） */
const CONFIG_OUTPUT_CAP = 64 * 1024;
/** 输出安静这么久就认为最后那行写完了（见 watchLarkCliConfig 的行缓冲注释） */
const CONFIG_QUIET_MS = 500;
/**
 * 配置流专用二维码文件名。**必须与设备流的 qr.png 分开**：两边各写各的文件，
 * 否则并发时后写的一次会覆盖前一次，把二维码画成另一条流的链接
 * （abandon 时的清理也会误删对方正在读回的文件）。
 */
const CONFIG_QR_FILE = 'qr-config.png';

/** 可在外部 resolve 的 Promise（避免把 resolve 引用深埋进 spawn 回调） */
function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** URL 字符集刻意收窄到 ASCII：中文、全角括号、引号天然是终止符，不会落进链接 */
const CONFIG_URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;

/**
 * 纯函数（可测）：取首个 URL，并剔除从散文 / 成对括号里粘来的尾部标点。
 * 收尾括号只在**不成对**时剔除——`…?a=(x)` 这种自带配对的链接不能被误伤。
 */
function firstUrl(text: string): string | undefined {
  const m = CONFIG_URL_RE.exec(text);
  if (!m) return undefined;
  let url = m[0].replace(/[.,;:!?'"）】」』]+$/, '');
  if (!url.includes('(')) url = url.replace(/\)+$/, '');
  if (!url.includes('[')) url = url.replace(/\]+$/, '');
  return url;
}

/**
 * 纯函数（可测）：从 `config init --new` 的输出里提取授权链接。
 *
 * **真实输出形态尚未用真机钉死**（本机已配置，直接跑不带 --name 的 config init 会覆盖它；
 * 抓取步骤见 docs/e2e-checklist.md 的「页面内配置应用」一节），因此解析刻意宽容，
 * 三层依次退让，保证形态猜错时也只是退化成更弱的匹配、而不是彻底解析不出来：
 *   ① JSON（兼容 {ok,data} 信封与 verification_uri / console_url 等字段别名）
 *   ② 裸 URL（从散文里抓首个 http(s) 链接）
 *   ③ 折行 URL（输出方按显示宽度插了换行时的尽力补救）
 *
 * **URL 一律视为 opaque string**：不编码、不解码、不重拼 query——lark-cli 内置 skill 明文要求。
 */
export function extractConfigUrl(text: string): string | undefined {
  const clean = stripAnsiAndBom(text);
  const obj = firstJsonObject(clean);
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const url = str(pickField(obj as Record<string, unknown>, [
      'verification_url', 'verification_uri', 'verification_uri_complete',
      'verificationUrl', 'verificationUri', 'console_url', 'consoleUrl', 'url',
    ]));
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  const direct = firstUrl(clean);
  // 折行补救：链接若被输出方按显示宽度折断，直接匹配只能拿到**前半截**——那是一个错的
  // 链接，比拿不到更糟。所以只在「去换行后的结果以直接匹配为前缀且更长」时才采用它：
  // 这个启发式只会把链接补全，绝不会把它换成另一段无关文本。
  const joinedText = clean.replace(/\r?\n(?=[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%])/g, '');
  // 拼接可能把上下文里的另一条 URL 接上来，那样得到的仍是错的——只认「整段只有一条 URL」
  if ((joinedText.match(/https?:\/\//gi) ?? []).length !== 1) return direct;
  const joined = firstUrl(joinedText);
  if (joined && (!direct || (joined.length > direct.length && joined.startsWith(direct)))) return joined;
  return direct;
}

export interface LarkCliConfigOutcome {
  phase: 'done' | 'failed' | 'expired';
  error?: string;
}

/**
 * 纯函数（可测）：配置子进程结束后判定结果。
 *
 * **正向判据优先于退出码**：以「应用是否真的配置上了」为准（`!needsLarkCliConfig(authAfter)`），
 * 而不是退出码——退出码 0 却什么都没配上，比直接报错更糟（用户以为配好了，下一步授权必然失败）。
 *
 * 判据还必须是**明确的**探测结果：`unknown`（探测失败）不算已配置，否则一次探测抖动
 * 就会把没配上的机器报成配好了——这与 decideDeviceFinishOutcome 的「反向兜底绝不能有」同源。
 */
export function decideConfigOutcome(a: {
  exitCode: number | null;
  output: string;
  spawnError?: string;
  authAfter?: LarkCliAuthStatus;
}): LarkCliConfigOutcome {
  const auth = a.authAfter;
  if (auth && auth.state !== 'unknown' && !needsLarkCliConfig(auth)) return { phase: 'done' };
  if (a.spawnError) return { phase: 'failed', error: `配置命令未能启动：${a.spawnError}` };
  const text = a.output.replace(/\s+/g, ' ').trim();
  if (/begin timed out|timed out|expired/i.test(text)) {
    return { phase: 'expired', error: '配置链接已失效，请重新生成二维码' };
  }
  if (/cancel/i.test(text)) return { phase: 'failed', error: '配置已取消' };
  // 探测失败（authAfter 缺失）时不能报成功，但也不该含糊其辞——把「没法确认」讲清楚
  if (!auth) {
    return {
      phase: 'failed',
      error: `配置命令已结束，但无法确认配置结果（状态探测失败）${text ? `：${text.slice(0, 120)}` : ''}`,
    };
  }
  if (a.exitCode === 0) {
    return { phase: 'failed', error: '配置命令已结束，但仍检测不到飞书应用（可能没在浏览器里完成创建）' };
  }
  return {
    phase: 'failed',
    error: text ? `配置未完成：${text.slice(0, 120)}` : `配置未完成（退出码 ${a.exitCode ?? '未知'}）`,
  };
}

/**
 * 唯一的出网构造点：**显式挑字段**（不是 {...session} 展开），与 deviceInfo 同源约定——
 * 配置流眼下没有 secret 类字段，但这条约定要一并继承，免得日后加字段时悄悄破防。
 * 顺带做懒超时：迟迟拿不到链接的 pending 就地转 failed，前端不会永远转圈。
 */
function configInfo(now = Date.now()): LarkCliConfigSessionInfo {
  const s = configSession;
  if (!s) return { ok: true, state: 'none' };
  if (s.state === 'pending' && !s.verificationUrl && now - s.startedAt > CONFIG_URL_WAIT_MS) {
    s.state = 'failed';
    s.error = s.error ?? `等待配置链接超时（${Math.round(CONFIG_URL_WAIT_MS / 1000)} 秒内未从 lark-cli 输出中解析到链接）`;
  }
  const base: LarkCliConfigSessionInfo = { ok: true, state: s.state, userCode: s.userCode, error: s.error };
  if (s.state === 'pending') {
    base.verificationUrl = s.verificationUrl;
    // 与设备流不同，这里 **status 也带二维码**：设备流的链接是 start 同步拿到的；
    // 配置流的链接要等子进程输出，start 有可能等不到就返回（见 CONFIG_START_WAIT_MS），
    // status 不带图的话那种情况下前端将永远拿不到二维码。
    // 代价是 pending 期间每 2s 多传约 2KB，且只走 localhost、弹窗生命周期很短——划算。
    base.qrDataUrl = s.qrDataUrl;
  }
  return base;
}

/** 内存态查询（零副作用、亚毫秒）——撑住前端 2s 轮询 */
export function getLarkCliConfigStatus(now = Date.now()): LarkCliConfigSessionInfo {
  return configInfo(now);
}

/**
 * 放弃当前配置会话（改用终端 / 新一轮发起前）。
 * **不 kill 子进程**——与 abandonLarkCliDeviceSession 同源：Windows 上
 * cmd → node → lark-cli.exe 的进程树 kill 会留孤儿，靠 gen 失配丢弃结果即可，
 * 孤儿最多空转到 registration 过期后自行退出。
 */
export function abandonLarkCliConfigSession(): void {
  if (!configSession) return;
  configGen++;
  configSession = null;
  removeQrFile(() => { /* 静默：放弃路径不打扰用户 */ }, CONFIG_QR_FILE);
}

/** 重置配置会话状态（测试用） */
export function resetLarkCliConfigState(): void {
  configSession = null;
  configGen = 0;
  configStartInflight = null;
}

/** 生产 spawn：stdin 接 /dev/null——官方要求「后台运行」，此路无人在终端应答交互输入 */
export const defaultConfigSpawn = (
  file: string,
  args: string[],
  opts: { windowsHide: boolean; env: NodeJS.ProcessEnv },
): LarkCliConfigChild =>
  spawn(file, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as LarkCliConfigChild;

/**
 * 解析该用哪条路启动 config init。
 * 优先 node + 包内入口（锚定本机真实安装、不依赖 PATH），与 defaultMakeQr 同序。
 */
async function resolveConfigCommand(): Promise<{ file: string; prefixArgs: string[] }> {
  try {
    const entry = larkCliEntryPath(await npmGlobalPrefix());
    if (existsSync(entry)) return { file: process.execPath, prefixArgs: [entry] };
  } catch { /* 取不到 npm 前缀就落 PATH 直调 */ }
  return larkCliDirect();
}

/** 子进程结束后写回会话（gen 失配即丢弃，绝不污染新会话） */
async function finishConfig(
  s: ConfigSession,
  deps: LarkCliConfigDeps,
  output: string,
  code: number | null,
  spawnError?: string,
): Promise<void> {
  if (configSession?.gen !== s.gen || s.state !== 'pending') return;
  let authAfter: LarkCliAuthStatus | undefined;
  try { authAfter = await deps.checkAuth(); } catch { /* 探测失败留 undefined，判据会拒绝它 */ }
  if (configSession?.gen !== s.gen || s.state !== 'pending') return;
  const out = decideConfigOutcome({ exitCode: code, output, spawnError, authAfter });
  s.state = out.phase;
  s.error = out.error;
  deps.log(`配置应用会话结束：${out.phase}${out.error ? `（${out.error}）` : ''}`);
}

/**
 * 后台守候配置子进程：流式抓链接 + 退出收尾。**同步返回、不 await**——
 * 用户可能几分钟后才在浏览器里完成。
 */
function watchLarkCliConfig(
  s: ConfigSession,
  deps: LarkCliConfigDeps,
  cmd: { file: string; prefixArgs: string[] },
  urlReady: (url: string | undefined) => void,
): void {
  let buf = '';
  let settled = false;
  let quietTimer: NodeJS.Timeout | undefined;
  const settle = (code: number | null, spawnError?: string): void => {
    if (settled) return; // 'error' 与 'exit' 可能都触发；且只有第一次算数
    settled = true;
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = undefined; }
    urlReady(s.verificationUrl); // 没抓到链接也要放行 start，别让它空等到超时
    void finishConfig(s, deps, buf, code, spawnError);
  };

  /** 认下这段文本里的链接；已认过或没找到就返回 false（不改状态） */
  const tryLatch = (text: string): boolean => {
    if (s.verificationUrl) return false;
    const url = extractConfigUrl(text);
    if (!url) return false;
    s.verificationUrl = url;
    s.userCode = userCodeFromUrl(url); // 只读提取；URL 本身仍按 opaque string 原样使用
    deps.log(`已从 lark-cli 输出中解析到配置链接（${buf.length} 字节输出内）`);
    urlReady(url);
    return true;
  };

  let child: LarkCliConfigChild;
  try {
    child = deps.spawn(cmd.file, [...cmd.prefixArgs, 'config', 'init', '--new'], {
      windowsHide: true,
      env: stripAgentContextEnv(process.env),
    });
  } catch (e) {
    settle(null, e instanceof Error ? e.message : String(e));
    return;
  }

  const onChunk = (d: Buffer): void => {
    buf += String(d);
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = undefined; } // 又来数据了，重新计时
    if (!s.verificationUrl) {
      // ① 先只认「已完整到达的行」：chunk 边界可能正好把链接劈成两半，拿半截 URL 去生成
      //    二维码会得到一张**指向错误地址**的图——比拿不到更糟。所以等换行到了再认。
      const complete = buf.slice(0, buf.lastIndexOf('\n') + 1);
      if (!complete || !tryLatch(complete)) {
        // ② 最后那行还没换行，先不认；但也别一直等——输出安静下来就说明这行写完了
        //    （CLI 若不给链接补换行，光靠 ① 会永远等不到）。认的仍是同一段文本，
        //    不是在赌另一个 URL。
        quietTimer = setTimeout(() => { quietTimer = undefined; tryLatch(buf); }, CONFIG_QUIET_MS);
      }
    }
    // 截断放在解析之后：先解析再丢，才不会把刚到的链接连同旧输出一起切掉
    if (buf.length > CONFIG_OUTPUT_CAP) buf = buf.slice(-CONFIG_OUTPUT_CAP);
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('error', (e: Error) => settle(null, e instanceof Error ? e.message : String(e)));
  child.on('exit', (code: number | null) => settle(code));
}

/**
 * 发起「配置应用」流程（页面二维码的主入口）。
 *
 * 四道闸与 startLarkCliDeviceAuth 同构：
 *   ① 幂等复用：pending 会话直接返回（挡住刷新页面 / 关弹窗再开）
 *   ② in-flight 合并：并发调用 await 同一个 promise（挡住双击）
 *   ③ regenerate：用户显式要求时才新建
 *   ④ gen 代号：新建时 +1，在飞的老子进程靠它丢弃过期结果
 *
 * 与设备流的一处**有意不同**：没有「剩余不足 X 秒就换新」——CLI 不吐有效期，
 * 我们也就无从编造倒计时；会话的终结一律由子进程退出（或 CONFIG_URL_WAIT_MS 兜底）驱动。
 */
export async function startLarkCliConfigFlow(
  opts: { regenerate?: boolean; deps?: Partial<LarkCliConfigDeps> } = {},
): Promise<LarkCliConfigSessionInfo> {
  const deps: LarkCliConfigDeps = {
    spawn: opts.deps?.spawn ?? defaultConfigSpawn,
    detect: opts.deps?.detect ?? (() => detectLarkCli()),
    checkAuth: opts.deps?.checkAuth ?? (() => checkLarkCliAuth()),
    makeQr: opts.deps?.makeQr ?? ((url) => defaultMakeQr(url, defaultAuthRunner, deps.log, undefined, CONFIG_QR_FILE)),
    now: opts.deps?.now ?? (() => Date.now()),
    log: opts.deps?.log ?? ((m: string) => console.log('[lark-cli]', m)),
  };

  // ① 幂等复用（regenerate 时跳过）
  if (!opts.regenerate && configSession?.state === 'pending') {
    return { ...configInfo(deps.now()), reused: true };
  }
  // ② 并发合并
  if (configStartInflight) return configStartInflight;

  const task = (async (): Promise<LarkCliConfigSessionInfo> => {
    const d = await deps.detect();
    if (!d.installed) return { ok: false, hint: 'install', error: 'lark-cli 未安装，请先安装后再配置应用' };
    const before = await deps.checkAuth();
    // 探测不出就无从判断该不该配——给一条能照做的出路，而不是含糊的「已配置」把用户堵死
    if (before.state === 'unknown') {
      return { ok: false, error: `无法确认飞书应用配置状态（${before.detail ?? '探测失败'}），请稍后重试` };
    }
    // 已配置时拒绝重复发起：覆盖配置是破坏性动作，会把已有应用顶掉（与 runLarkCliActionFlow 同判据）
    if (!needsLarkCliConfig(before)) {
      return { ok: false, error: '应用已配置，无需重复配置（如确需重配请在终端执行 lark-cli config init --new）' };
    }

    abandonLarkCliConfigSession(); // ③ gen++

    const s: ConfigSession = { gen: ++configGen, state: 'pending', startedAt: deps.now() };
    configSession = s;

    const ready = makeDeferred<string | undefined>();
    watchLarkCliConfig(s, deps, await resolveConfigCommand(), ready.resolve);

    // 等链接到位：正常情况就是一次网络往返。等不到也照常返回 pending（此时无链接），
    // 前端继续轮询 status——链接一旦到手会随轮询补上，不会丢。
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), CONFIG_START_WAIT_MS); });
    let url: string | undefined;
    try {
      url = await Promise.race([ready.promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (configSession?.gen !== s.gen) return configInfo(deps.now()); // 期间被新一轮取代
    // 二维码只是展示层，生成失败不阻塞配置（降级为只显示可复制链接）
    if (url) s.qrDataUrl = await deps.makeQr(url).catch(() => undefined);
    return configInfo(deps.now());
  })();

  configStartInflight = task;
  try {
    return await task;
  } finally {
    configStartInflight = null;
  }
}

// ============ 安装/更新/授权 的动作编排 ============

export type LarkCliOp = 'install' | 'update' | 'auth' | 'config' | 'skill';

export interface LarkCliActionResult {
  ok: boolean;
  /** 已有操作在进行 / 刚拉起过终端 */
  busy?: boolean;
  mode: 'terminal' | 'silent' | 'none';
  terminal?: string;
  scriptPath?: string;
  output?: string;
  /** skill op 专用：装完后扫盘得到的 SKILL 名单（前端列清单用，比 npx 原始输出可靠） */
  skills?: string[];
  /** 为何没用终端（降级说明，前端展示用） */
  reason?: string;
  error?: string;
}

/** 同一 op 两次拉起终端的最小间隔：挡住连点开出两个终端窗口 */
const LAUNCH_COOLDOWN_MS = 10_000;

let inFlight = false;
const lastLaunchAt: Partial<Record<LarkCliOp, number>> = {};

/** 重置编排状态（测试用）。进程内单例：并发 npm 必撞 Windows 文件锁，这里必须互斥 */
export function resetLarkCliActionState(): void {
  inFlight = false;
  delete lastLaunchAt.install;
  delete lastLaunchAt.update;
  delete lastLaunchAt.auth;
  delete lastLaunchAt.config;
  // 设备流与配置会话也在同一进程内，跟着一起清——既有 30+ 处 beforeEach 无需逐条补
  resetLarkCliDeviceState();
  resetLarkCliConfigState();
}

export interface LarkCliActionDeps {
  detect(): Promise<LarkCliDetect>;
  install(): Promise<string>;
  /** SKILL 静默安装（op:'skill'）；缺省真实 installLarkCliSkill */
  installSkill(): Promise<string>;
  /** SKILL 装完后的落盘扫描（op:'skill' 回传名单用）；缺省真实 listLarkCliSkills */
  listSkills(): Promise<string[]>;
  /** 授权/配置态探测：config op 用它拒绝重复向导；install op 用它决定脚本是否插 config init 段 */
  checkAuth(): Promise<LarkCliAuthStatus>;
  launch(task: TerminalTask, opts?: { needConfig?: boolean }): Promise<LaunchTerminalResult>;
  now(): number;
  log(msg: string): void;
}

/** 构造烘焙值：全部来自 OS，不含任何用户输入；取不到包内入口只是少一道兜底，不致命 */
async function defaultLaunch(task: TerminalTask, opts?: { needConfig?: boolean }): Promise<LaunchTerminalResult> {
  const bake: ScriptBake = { pathEnv: process.env.PATH, nodePath: process.execPath };
  try { bake.larkEntry = larkCliEntryPath(await npmGlobalPrefix()); } catch { /* 见上 */ }
  return launchInTerminal(task, { bake, needConfig: opts?.needConfig });
}

/**
 * install 任务的 config 段开关：未配置则插 `config init --new`（官方第 ③ 步顺势完成）。
 * 探测失败保守按「已配置」处理（false）——宁可让用户装完点「配置应用」按钮，
 * 也不对偶发超时的已配置机器弹出重复向导。
 */
async function needConfigQuietly(
  checkAuth: () => Promise<LarkCliAuthStatus>,
  log: (m: string) => void,
): Promise<boolean> {
  try {
    return needsLarkCliConfig(await checkAuth());
  } catch (e) {
    log(`授权态探测失败（按已配置处理，跳过 config init 段）：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * 安装/更新/授权/配置/SKILL 五条动作的统一编排。
 *
 * - install / update：优先拉起终端（用户能看见 npm 输出并顺势完成配置与授权）；
 *   拉不起终端（SSH / 无桌面）则降级静默安装，`reason` 带回降级原因。
 * - auth / config：**不降级** —— 交互式向导没有静默等价物，拉不起终端就如实报错。
 *   config 额外要求当前确属「未配置」态（needsLarkCliConfig），已配置时拒绝重复向导。
 * - skill：静默安装（npx skills add，无交互），不拉终端；失败仅返回错误不抛出。
 *
 * 互斥覆盖「探测 + 拉起」的亚秒窗口；终端存活期由 10s 冷却兜（否则用户 3 分钟后
 * 想再授权会被自己锁死）。
 */
export async function runLarkCliActionFlow(
  op: LarkCliOp,
  deps: Partial<LarkCliActionDeps> = {},
): Promise<LarkCliActionResult> {
  const detect = deps.detect ?? (() => detectLarkCli());
  const install = deps.install ?? (() => installLarkCli());
  const installSkill = deps.installSkill ?? (() => installLarkCliSkill());
  const listSkills = deps.listSkills ?? (() => listLarkCliSkills());
  const checkAuth = deps.checkAuth ?? (() => checkLarkCliAuth());
  const launch = deps.launch ?? defaultLaunch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log('[lark-cli]', m));

  if (inFlight) return { ok: false, busy: true, mode: 'none', error: '已有 lark-cli 操作正在进行，请稍候' };
  inFlight = true;
  try {
    const last = lastLaunchAt[op];
    if (last !== undefined && now() - last < LAUNCH_COOLDOWN_MS) {
      return { ok: false, busy: true, mode: 'none', error: '终端窗口刚刚已经打开，请等它跑完再试' };
    }

    if (op === 'auth' || op === 'config') {
      const d = await detect();
      if (!d.installed) return { ok: false, mode: 'none', error: `lark-cli 未安装，请先安装后再${op === 'auth' ? '授权' : '配置'}` };
      if (op === 'config') {
        // 已配置时拒绝重复向导：覆盖配置是破坏性动作，且 TUI 向导会把已有 profile 顶掉
        const auth = await checkAuth();
        if (!needsLarkCliConfig(auth)) {
          return { ok: false, mode: 'none', error: '应用已配置，无需重复配置（如确需重配请在终端执行 lark-cli config init --new）' };
        }
      }
      const r = await launch(op);
      if (!r.ok) {
        return {
          ok: false,
          mode: 'none',
          error: `未找到可用终端（${r.reason}）：请在服务器本机终端执行 ${op === 'auth' ? 'lark-cli auth login --recommend' : 'lark-cli config init --new'}`,
        };
      }
      lastLaunchAt[op] = now();
      // 用户改用终端了：作废页面上那两轮会话（设备流 / 配置应用），避免后台进程与终端里的
      // lark-cli 同时往 token store、config 文件写。放在 r.ok 之后而非函数入口——否则
      // 「点了更新又取消确认框」会把用户正在扫的二维码搞没。
      abandonLarkCliDeviceSession();
      abandonLarkCliConfigSession();
      return { ok: true, mode: 'terminal', terminal: r.terminal, scriptPath: r.scriptPath };
    }

    if (op === 'skill') {
      try {
        const output = await installSkill();
        // 装完扫盘列出实际落盘的名单交给前端渲染：npx 那段输出是带 ANSI 的进度表，
        // 直接展示既难读又易误导（同名散目录 / 部分失败都看不出来）。output 仍回传
        // 供排查，但剥掉 ANSI 与控制字符再给出去；扫盘失败不算安装失败，退空数组。
        const skills = await listSkills().catch(() => [] as string[]);
        return { ok: true, mode: 'silent', output: stripAnsiAndBom(output), skills };
      } catch (e) {
        return { ok: false, mode: 'silent', error: `SKILL 安装失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }

    const r = await launch('install', { needConfig: await needConfigQuietly(checkAuth, log) });
    if (r.ok) {
      lastLaunchAt[op] = now();
      // 用户改用终端了：作废页面上那轮设备流，避免后台收尾与终端里的 auth login
      // 同时往 token store 写。放在 r.ok 之后而非函数入口——否则「点了更新又取消确认框」
      // 会把用户正在扫的二维码搞没。
      abandonLarkCliDeviceSession();
      return { ok: true, mode: 'terminal', terminal: r.terminal, scriptPath: r.scriptPath };
    }
    log(`未找到可用终端（${r.reason}），降级为静默安装`);
    try {
      const output = await install();
      // 降级路径的输出同样要经前端展示，先剥 ANSI（npm 的彩色输出在 <pre> 里是乱码）
      return { ok: true, mode: 'silent', output: stripAnsiAndBom(output), reason: r.reason };
    } catch (e) {
      return { ok: false, mode: 'silent', error: `lark-cli 安装失败：${e instanceof Error ? e.message : String(e)}` };
    }
  } finally {
    inFlight = false;
  }
}
