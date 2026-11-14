// B3 嵌入式安装器（生命周期方案 §6.7 一键流水线）：五步——runtime（uv）→ service（openviking）
// → config（ov.conf 渲染）→ start（受管子进程）→ plugin（记忆插件）。每步「检测就绪则跳过 /
// 失败可重试」，本机已有部件（uv / 服务 / 插件 / 现有服务探活通过）全部自动复用——安装器对
// 已部署环境是幂等升级器而非重复安装。零新依赖：zip/tar.gz 解压用系统自带 tar（Win10+
// bsdtar 支持 zip），下载用原生 fetch，子进程 node:child_process。
//
// 事实依据（2026-10-13 本机探源）：
// - uv 官方单文件：github.com/astral-sh/uv/releases/latest/download/<平台包>（win=.zip / mac-linux=.tar.gz）
// - 服务安装：`uv tool install openviking==<pin>` → bin 里出现 openviking-server；`--config/--host/--port` 全自管
// - ov.conf schema（本机蓝本）：storage.workspace / embedding.dense{provider:"openai",model,api_key,api_base}
//   / vlm{provider("glm"|"openai"),model,api_base,api_key} / server{host,port,root_api_key}
// - 插件源：codeload.github.com/volcengine/OpenViking/<zip|tar.gz>/refs/<ref> → examples/claude-code-memory-plugin
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, copyFileSync, constants as FS_CONSTANTS, type Dirent } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { BridgeConfig, MemoryConfig, MemoryModelConfig } from './types.js';
import { probeMemoryHealth, MEMORY_PLUGIN_NAME, memoryAccount, memoryEndpoint } from './memory.js';

/** 服务默认 pin 版本（实测环境；memory.version 可覆盖） */
export const DEFAULT_OPENVIKING_PIN = '0.5.0';
/** 插件源（市场清单 git-subdir 事实）：主仓库 examples 子目录 */
const PLUGIN_REPO_ZIP = (ref: string) =>
  `https://codeload.github.com/volcengine/OpenViking/zip/refs/heads/${ref}`;
const PLUGIN_REPO_TGZ = (ref: string) =>
  `https://codeload.github.com/volcengine/OpenViking/tar.gz/refs/heads/${ref}`;
const PLUGIN_SUBDIR = 'examples/claude-code-memory-plugin';

/** CLI 市场渠道（真实安装：插件页可见、enable/disable/update 全套 CLI 语义可用）。
 *  市场名与上游 .claude-plugin/marketplace.json 一致（name: "openviking"）。
 *  注册源按序尝试（实测教训：CLI 内部 fetch 对 raw.githubusercontent 直链只有 10s 超时，
 *  国内网络易撞；github 简写走 git clone 稳得多）：github 简写优先，清单直链兜底 */
const MARKETPLACE_NAME = 'openviking';
const MARKETPLACE_ADD_SOURCES = [
  'volcengine/OpenViking',
  'https://raw.githubusercontent.com/volcengine/OpenViking/main/.claude-plugin/marketplace.json',
];
const MARKETPLACE_KEY = `${MEMORY_PLUGIN_NAME}@${MARKETPLACE_NAME}`;

// ============ 安装状态机（web server 进程内单例） ============

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export interface InstallStep {
  id: string;
  title: string;
  status: StepStatus;
  detail?: string;
}
/** kind 区分两条流水线：install=一键安装（5 步）；start=启动服务（3 步，LCB 接管式拉起） */
export interface InstallState {
  kind: 'install' | 'start';
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  steps: InstallStep[];
}

const FRESH_STEPS = (): InstallStep[] => [
  { id: 'runtime', title: '运行时（uv）', status: 'pending' },
  { id: 'service', title: '安装 OpenViking 服务', status: 'pending' },
  { id: 'config', title: '生成服务配置（ov.conf）', status: 'pending' },
  { id: 'start', title: '拉起受管服务', status: 'pending' },
  { id: 'plugin', title: '接入记忆插件', status: 'pending' },
];

/** 「启动服务」流水线步骤（§6.8 启动接管）：与安装同款 stepper 展示，启动 ≠ 只拉进程 */
const START_STEPS = (): InstallStep[] => [
  { id: 'locate', title: '检查服务与配置', status: 'pending' },
  { id: 'launch', title: '拉起并探活', status: 'pending' },
  { id: 'plugin', title: '接入记忆插件', status: 'pending' },
];

let installState: InstallState = { kind: 'install', running: false, steps: FRESH_STEPS() };
export function getInstallState(): InstallState { return installState; }

// ============ 受管服务子进程（崩溃重启 + 随 LCB 关停） ============

interface ManagedProc { proc: ReturnType<typeof spawn>; port: number; restarts: number; stopped: boolean; confPath: string; startedAt: string; output: string[] }
let managed: ManagedProc | undefined;

/** 受管进程最近输出环形缓冲上限（行；P0：失败文案带真实输出而非笼统指引） */
const MANAGED_OUTPUT_CAP = 40;
/** stdout/stderr 行入环形缓冲（spawnManaged 的两个 data 回调共用） */
function pushManagedOutput(line: string): void {
  if (!managed) return;
  managed.output.push(line.slice(0, 300));
  if (managed.output.length > MANAGED_OUTPUT_CAP) managed.output.shift();
}

/** 受管进程最近输出尾部（失败文案「最近输出：…」的数据源；exported 便于单测验证截断语义） */
export function managedRecentOutput(maxLines = 12): string {
  return (managed?.output ?? []).slice(-maxLines).join('\n');
}

/** 停受管实例（页面 stop / LCB shutdown / 重装前）：幂等，未运行为 no-op */
export function stopManagedServer(): void {
  if (!managed) return;
  managed.stopped = true;
  try { managed.proc.kill(); } catch { /* 已退出 */ }
  managed = undefined;
}

/** LCB 优雅关闭钩子注册点（index.ts shutdown 调用） */
export function isManagedRunning(): boolean { return managed !== undefined; }

/** 受管实例本次拉起时间（ISO；崩溃自动重启会重置）——status 页「运行时间」展示源，仅受管时有值 */
export function managedStartedAt(): string | undefined { return managed?.startedAt; }

// ============ 小工具 ============

/** 跑命令收 stdout（trim）；非零退出抛带 stderr 摘要的 Error */
function run(cmd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(cmd, args, {
      windowsHide: true,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill();
      rejectP(new Error(`${cmd} 超时（>${opts.timeoutMs ?? 120_000}ms）`));
    }, opts.timeoutMs ?? 120_000);
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', (e) => { clearTimeout(timer); rejectP(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveP(out.trim());
      else rejectP(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}${err ? `：${err.trim().slice(0, 300)}` : ''}`));
    });
  });
}

async function canExec(p: string): Promise<boolean> {
  try { await access(p, FS_CONSTANTS.X_OK); return true; } catch { return false; }
}

/** 解压命令定位（实测教训：Windows PATH 里 Git Bash 的 GNU tar 常排在 System32 之前，
 *  GNU tar 不认 zip → 解压失败。Windows 显式用系统自带 bsdtar（Win10 1803+ 必有），
 *  缺失时回退 PATH tar（mac/linux 均系统自带）。返回 [cmd, 前置参数]。 */
function tarCommand(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(bsdtar)) return { cmd: bsdtar, args: [] };
    console.warn('[memory-installer] 未找到系统 bsdtar（System32\\tar.exe），回退 PATH tar（若为 Git Bash GNU tar 将无法解 zip）');
  }
  return { cmd: 'tar', args: [] };
}

/** 下载到临时文件返回路径（fetch 流式写盘；root key 等不涉密，普通下载） */
async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}（${url}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

// ============ 步骤 1：uv ============

const UV_INSTALL_DIR = join(process.env.LCB_CONFIG_DIR ?? String(process.env.USERPROFILE ?? process.env.HOME ?? ''),
  '.lark-claudecode-bridge', 'bin');

/** 检测 uv：PATH → 常见安装位 → LCB 管理域。返回可执行路径或 null */
export async function detectUv(): Promise<string | null> {
  const candidates = [
    'uv', // PATH
    join(String(process.env.USERPROFILE ?? process.env.HOME ?? ''), '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
    join(UV_INSTALL_DIR, process.platform === 'win32' ? 'uv.exe' : 'uv'),
  ];
  if (process.platform === 'win32') {
    candidates.splice(2, 0, join(String(process.env.LOCALAPPDATA ?? ''), 'hermes', 'bin', 'uv.exe'));
  }
  for (const c of candidates) {
    if (c === 'uv') {
      try { await run('uv', ['--version'], { timeoutMs: 10_000 }); return 'uv'; } catch { continue; }
    }
    if (existsSync(c)) {
      try { await run(c, ['--version'], { timeoutMs: 10_000 }); return c; } catch { continue; }
    }
  }
  return null;
}

/** uv 官方单文件包名（win 用 zip / mac-linux 用 tar.gz——后者保证 GNU tar 也能解） */
function uvAssetName(): { file: string; extract: 'zip' | 'tgz' } {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'win32') return { file: `uv-${arch}-pc-windows-msvc.zip`, extract: 'zip' };
  if (process.platform === 'darwin') return { file: `uv-${arch}-apple-darwin.tar.gz`, extract: 'tgz' };
  return { file: `uv-${arch}-unknown-linux-gnu.tar.gz`, extract: 'tgz' };
}

async function installUv(): Promise<string> {
  const { file, extract } = uvAssetName();
  mkdirSync(UV_INSTALL_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'lcb-uv-'));
  try {
    const archive = join(tmp, file);
    await downloadTo(`https://github.com/astral-sh/uv/releases/latest/download/${file}`, archive);
    // 系统 bsdtar/GNU tar 解压（Windows 显式 System32 bsdtar——PATH 里的 Git Bash tar 不认 zip）
    const t = tarCommand();
    await run(t.cmd, [...t.args, '-xf', archive, '-C', tmp], { timeoutMs: 60_000 });
    // 解包结构：uv-<target>/uv(.exe) —— 遍历两层的候选路径直接定位
    const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
    const candidates = [
      join(tmp, exe),
      ...existsSync(join(tmp, 'uv-' + file.replace(extract === 'zip' ? '.zip' : '.tar.gz', '')))
        ? [join(tmp, 'uv-' + file.replace(extract === 'zip' ? '.zip' : '.tar.gz', ''), exe)]
        : [],
    ];
    const src = candidates.find((p) => existsSync(p));
    if (!src) throw new Error('解包后未找到 uv 可执行文件（归档结构可能已变化）');
    const dest = join(UV_INSTALL_DIR, exe);
    copyFileSync(src, dest);
    await run(dest, ['--version'], { timeoutMs: 15_000 });
    return dest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ============ 步骤 2：openviking 服务 ============

/** uv tool 安装的 openviking server 可执行路径（uv tool dir/openviking/{Scripts|bin}/openviking-server[.exe]） */
export async function resolveServerBin(uv: string): Promise<string | null> {
  try {
    const toolDir = (await run(uv, ['tool', 'dir'], { timeoutMs: 15_000 })).trim();
    const exe = process.platform === 'win32' ? 'openviking-server.exe' : 'openviking-server';
    const candidates = [
      join(toolDir, 'openviking', process.platform === 'win32' ? 'Scripts' : 'bin', exe),
      join(String(process.env.USERPROFILE ?? process.env.HOME ?? ''), '.local', 'bin', exe),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return null;
  } catch { return null; }
}

async function stepService(uv: string, pin: string): Promise<{ skipped: boolean; detail: string; bin: string }> {
  const existing = await resolveServerBin(uv);
  if (existing) {
    let ver = '';
    try { ver = (await run(existing, ['--version'], { timeoutMs: 15_000 })).replace(/^[^0-9]*/, ''); } catch { /* 版本查询失败不阻塞（二进制在即视为可用） */ }
    return { skipped: true, detail: `已安装${ver ? `（v${ver}）` : ''}：${existing}`, bin: existing };
  }
  // 尊重 pip/uv 镜像配置（UV_INDEX_URL / UV_DEFAULT_INDEX / PIP_INDEX_URL 经 process.env 自动透传）
  await run(uv, ['tool', 'install', `openviking==${pin}`], { timeoutMs: 300_000 });
  const bin = await resolveServerBin(uv);
  if (!bin) throw new Error(`安装完成但未定位到 openviking-server（uv tool dir 下无产物，请反馈）`);
  return { skipped: false, detail: `已安装 openviking==${pin}：${bin}`, bin };
}

// ============ 步骤 3：ov.conf 渲染 ============

/** LCB 记忆管理域（嵌入式数据全收敛于此：卸载即整目录删） */
export const MEMORY_MANAGED_DIR = join(process.env.LCB_CONFIG_DIR ?? String(process.env.USERPROFILE ?? process.env.HOME ?? ''),
  '.lark-claudecode-bridge', 'openviking');
export const MANAGED_OV_CONF = join(MEMORY_MANAGED_DIR, 'ov.conf');

/** vlm provider 映射：glm 预设用服务端原生 "glm"，其余 OpenAI 协议端点统一 "openai"（本机蓝本口径） */
function vlmProvider(p: MemoryModelConfig['provider']): string {
  return p === 'glm' ? 'glm' : 'openai';
}

/** 渲染 ov.conf（纯函数 exported 便于单测）。rootKey 已有则复用（重装不换 key，否则插件侧缓存/用户侧配置全部失效）。
 *  P2 双端点拆分：embedding.dense 与 vlm 各自独立——向量块显式配置（embeddingApiBase/embeddingApiKey）
 *  优先，未设置回退主块（apiBase/apiKey），既有单份配置零迁移即可用；跨厂商组合（vlm=glm +
 *  embedding=openai 系）填向量块两字段即可。
 *  检索增强双可选段（2026-11-14）：
 *  - query_planner：模型名是触发开关（填写才渲染），端点/Key 留空在渲染层回退主块——保证段
 *    一旦出现即凭证完整（上游 get_query_planner() 对空段本就回退 vlm，这里提前在 LCB 侧完成
 *    同一语义的回退，跨厂商组合也成立）；provider 沿用主块映射（意图模型是轻量对话模型，
 *    与 vlm 同协议域）。
 *  - rerank：三件齐全才渲染（上游校验器对 openai provider 强制 api_key + api_base，半填会
 *    产出非法配置让服务启动崩溃循环——渲染层硬门禁）；api_base 是完整请求 URL（上游直接
 *    POST 不拼接）；Key 不回退主块（rerank 常是另一家厂商，回退会埋错凭证）。 */
export function renderOvConf(
  model: MemoryModelConfig,
  opts: { workspaceDir: string; port: number; rootApiKey?: string },
): { conf: Record<string, unknown>; rootApiKey: string } {
  const rootApiKey = opts.rootApiKey ?? randomBytes(24).toString('hex');
  const conf: Record<string, unknown> = {
    storage: { workspace: opts.workspaceDir },
    embedding: {
      dense: {
        provider: 'openai',
        model: model.embeddingModel ?? '',
        api_key: model.embeddingApiKey ?? model.apiKey ?? '',
        api_base: model.embeddingApiBase ?? model.apiBase ?? '',
      },
    },
    vlm: {
      provider: vlmProvider(model.provider),
      model: model.vlmModel ?? '',
      api_base: model.apiBase ?? '',
      temperature: 0.0,
      max_retries: 2,
      api_key: model.apiKey ?? '',
    },
    server: {
      host: '127.0.0.1',
      port: opts.port,
      root_api_key: rootApiKey,
    },
  };
  // 意图模型（可选段）：模型名填写才渲染；端点/Key 渲染层回退主块（段出现即凭证完整）。
  // provider 映射随端点回退语义：端点沿用主块 → 沿用主块 provider 映射（同厂商换轻量模型的
  // 典型场景，glm 原生适配器最贴合）；端点显式独立 → 协议域独立，恒走 openai 适配器
  //（显式指定另一端点即另一协议域——Ollama/硅基流动等；智谱 /api/paas/v4 本就 openai 兼容，
  // 误配成独立端点也照常工作，不会像沿用 glm 适配器那样打错协议）
  if (model.queryPlannerModel) {
    conf.query_planner = {
      provider: model.queryPlannerApiBase ? 'openai' : vlmProvider(model.provider),
      model: model.queryPlannerModel,
      api_base: model.queryPlannerApiBase ?? model.apiBase ?? '',
      api_key: model.queryPlannerApiKey ?? model.apiKey ?? '',
      temperature: 0.0,
      max_retries: 2,
    };
  }
  // Rerank（可选段）：三件齐全才渲染——上游 openai provider 校验 api_key+api_base 必填，
  // 半填段 = 服务启动崩溃循环；缺段 = is_available()=false 纯向量召回（安全缺省）
  if (model.rerankModel && model.rerankApiBase && model.rerankApiKey) {
    conf.rerank = {
      provider: 'openai',
      model: model.rerankModel,
      api_base: model.rerankApiBase,
      api_key: model.rerankApiKey,
    };
  }
  return { conf, rootApiKey };
}

/** 读现有受管 conf 的 root_api_key（存在时复用） */
function existingRootKey(): string | undefined {
  try {
    const doc = JSON.parse(readFileSync(MANAGED_OV_CONF, 'utf8')) as { server?: { root_api_key?: string } };
    return doc.server?.root_api_key;
  } catch { return undefined; }
}

/** 外部（用户手动 init，如 `openviking-server init`）ov.conf 的默认位置——已装未跑时
 *  「启动服务」按钮的兜底配置源（LCB 只代为拉起，不改写其内容） */
export const EXTERNAL_OV_CONF = join(String(process.env.USERPROFILE ?? process.env.HOME ?? ''),
  '.openviking', 'ov.conf');

/** 读 conf 的 server.port（JSON；读取失败按缺省 1933 兜底，不让状态展示路径抛错） */
function readConfPort(confPath: string): number {
  try {
    return (JSON.parse(readFileSync(confPath, 'utf8')) as { server?: { port?: number } }).server?.port ?? 1933;
  } catch { return 1933; }
}

// ============ 客户端接入配置（ovcli.conf，§6.7 第 4 步落地） ============
// 插件 isPluginEnabled() 的第 3 优先级判据 + 连接信息兜底层（env > ovcli.conf > ov.conf，
// 插件 scripts/shared/credentials.mjs 实测口径）。LCB 只写「无 key 骨架」：key 永远走 env
// 下发（§6.6），绝不落盘到 ~/.openviking/ 域。全新机器一键安装后即启用插件，用户零手工。

/** 客户端配置文件位置（与 EXTERNAL_OV_CONF 同款 home 解析口径） */
export const OVCLI_CONF = join(String(process.env.USERPROFILE ?? process.env.HOME ?? ''),
  '.openviking', 'ovcli.conf');

export type ClientConfWrite = 'written' | 'updated' | 'kept' | 'skipped-external' | 'skipped-foreign';

/** LCB 骨架形状签名：恰好 {url, account, user} 三个 string 键。这是「文件归 LCB 所有」的判定
 *  依据——插件 setup 向导 / `ov login` 恒写 api_key（含 api_key 的文件永不与本形状同形），
 *  且形状判定与端点/账号现值解耦：重装 findFreePort 换端口后旧骨架仍被识别为 LCB 所有
 *  （这是 ensure 能刷新、cleanup 能删中的关键；勿改成内容比对，否则端口漂移后清理永不触发） */
function isLcbClientConfShape(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  return keys.length === 3 && ['url', 'account', 'user'].every((k) => typeof o[k] === 'string')
    && keys.every((k) => ['url', 'account', 'user'].includes(k));
}

/** 渲染 ovcli.conf（纯函数 exported 便于单测）。刻意不含 api_key / plugin 段；user 取 account
 *  值：保证直连场景 identity 非空 → 插件判 trusted header 身份（dev 模式服务可用）；留空会被
 *  判成 api_key 模式而 401 */
export function renderOvcliConf(memory: Pick<MemoryConfig, 'endpoint' | 'account'>): Record<string, string> {
  const account = memoryAccount(memory);
  return { url: memoryEndpoint(memory), account, user: account };
}

/** 写/刷新客户端配置（幂等可重跑）。决策表：
 *  ① EXTERNAL_OV_CONF 存在 → 'skipped-external'（~/.openviking 域归用户自管，整体不碰；
 *     外部 ov.conf 本身就满足插件启用判定，LCB 会话另有 env 通道兜底）
 *  ② 文件缺失 → mkdir recursive + writeAtomic(渲染值) → 'written'
 *  ③ 文件存在且为 LCB 骨架：内容与渲染值全等 → 'kept'（幂等零写）；否则重写 → 'updated'
 *     （端口漂移/账号改名/remote↔embedded 切换后的自愈路径）
 *  ④ 其余（含 api_key 的用户手配、plugin 段、损坏 JSON）→ 'skipped-foreign'（尊重不动）
 *  dirOverride 供单测注入临时目录（ov.conf/ovcli.conf 一并重定向，摆脱模块常量的 home 依赖） */
export function ensureClientCliConf(
  memory: Pick<MemoryConfig, 'endpoint' | 'account'>,
  dirOverride?: string,
): ClientConfWrite {
  const ovConf = dirOverride ? join(dirOverride, 'ov.conf') : EXTERNAL_OV_CONF;
  const ovcli = dirOverride ? join(dirOverride, 'ovcli.conf') : OVCLI_CONF;
  if (existsSync(ovConf)) return 'skipped-external';
  const next = renderOvcliConf(memory);
  let cur: unknown;
  try { cur = JSON.parse(readFileSync(ovcli, 'utf8')); } catch { cur = undefined; }
  if (cur === undefined && !existsSync(ovcli)) {
    writeAtomic(ovcli, JSON.stringify(next, null, 2));
    return 'written';
  }
  if (isLcbClientConfShape(cur)) {
    if (JSON.stringify(cur) === JSON.stringify(next)) return 'kept';
    writeAtomic(ovcli, JSON.stringify(next, null, 2));
    return 'updated';
  }
  return 'skipped-foreign';
}

/** 关记忆的对称清理：仅当解析后命中 LCB 骨架形状才删（返回是否删除）。刻意不做内容匹配
 *  （见 isLcbClientConfShape 注释）；损坏/手配文件一律保留 */
export function cleanupClientCliConf(dirOverride?: string): boolean {
  const ovcli = dirOverride ? join(dirOverride, 'ovcli.conf') : OVCLI_CONF;
  let cur: unknown;
  try { cur = JSON.parse(readFileSync(ovcli, 'utf8')); } catch { return false; }
  if (!isLcbClientConfShape(cur)) return false;
  rmSync(ovcli, { force: true });
  return true;
}

/** 客户端配置归属态（状态页展示用） */
export type ClientConfState = 'lcb-managed' | 'user-managed' | 'external' | 'missing';

/** 状态页分类（exported 便于 memory-api 与单测复用；路径入参可注入摆脱 home 依赖）。
 *  external 优先：外部 ov.conf 存在即整个 ~/.openviking 域归用户（与 ensure 的守卫口径一致） */
export function classifyClientConf(paths: { ovcli: string; ovConf: string }): { state: ClientConfState; path: string } {
  if (existsSync(paths.ovConf)) return { state: 'external', path: paths.ovConf };
  let cur: unknown;
  try { cur = JSON.parse(readFileSync(paths.ovcli, 'utf8')); } catch { cur = undefined; }
  if (isLcbClientConfShape(cur)) return { state: 'lcb-managed', path: paths.ovcli };
  if (existsSync(paths.ovcli)) return { state: 'user-managed', path: paths.ovcli };
  return { state: 'missing', path: paths.ovcli };
}

// ============ 步骤 4：受管拉起 ============

/** 找空闲端口：从 1933 起「net 试探 + HTTP 探活」双重确认（Windows SO_REUSEADDR 允许抢绑，
 *  net listen 成功 ≠ 端口空闲——已有 OpenViking 服务在监听时 listen 可能误报空闲；探活有
 *  响应 = 确定被占）。候选端口同时两者皆过才采用。 */
export async function findFreePort(startPort = 1933, tries = 20): Promise<number> {
  const { createServer } = await import('node:net');
  for (let p = startPort; p < startPort + tries; p++) {
    const netOk = await new Promise<boolean>((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (!netOk) continue;
    const health = await probeMemoryHealth(`http://127.0.0.1:${p}`, 800);
    if (health.healthy) continue; // 有活服务：占用
    return p;
  }
  throw new Error(`${startPort}-${startPort + tries - 1} 端口段均被占用`);
}

/** 拉起受管实例并探活等待就绪（安装流水线第 4 步与「启动服务」按钮共用）。
 *  P0 启动可靠性（记忆系统最终方案 v1.1 §五）：
 *  - 探活预算 30 → 120 轮（首装冷启动最坏路径：OS 缓存全冷 + Defender 实时扫描 + 重依赖加载，
 *    常超 30s——旧预算 + 超时即杀是「第一次必败」竞态的根因）；
 *  - 超时不杀进程：预算耗尽且进程仍活 → 返回 { ready:false, crashed:false }，调用方转后台续等
 *    （waitSlowStart），UI 显示「启动中（已等 N 秒）」而非红叉，就绪后自动续跑后续步骤；
 *  - 进程退出（崩溃 3 次放弃 / 被停止）→ { ready:false, crashed:true }，文案带最近真实输出。 */
const PROBE_BUDGET_ROUNDS = 120;
/** 慢启动后台续等窗口（预算耗尽且进程存活时；10 分钟仍未见就绪才放弃并停止进程，防僵尸占端口） */
const SLOW_START_MAX_MS = 600_000;

/** launchManagedAndWait 的结果：ready=就绪；crashed=进程已放弃（崩溃超限/被停）；二者皆否 = 慢启动 */
export interface LaunchOutcome { ready: boolean; crashed: boolean; detail: string; port: number }

async function launchManagedAndWait(bin: string, confPath: string, port: number, external = false, opts: { budgetRounds?: number } = {}): Promise<LaunchOutcome> {
  const budget = opts.budgetRounds ?? PROBE_BUDGET_ROUNDS;
  spawnManaged(bin, confPath, port);
  for (let i = 1; i <= budget; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await probeMemoryHealth(`http://127.0.0.1:${port}`, 1500);
    if (h.healthy) {
      return {
        ready: true, crashed: false, port,
        detail: `服务已就绪：http://127.0.0.1:${port}${external ? '（外部配置 ~/.openviking/ov.conf，LCB 仅代为拉起、不改写）' : ''}${i > 15 ? `（冷启动 ${i} 秒）` : ''}`,
      };
    }
    if (!managed) {
      // 崩溃自动重启 3 次放弃 / 被主动停止：managed 已清。文案带最近输出（stdout+stderr 合流），
      // 不再误导为「模型配置问题」——真实原因看输出（方案 §五-P0）
      return { ready: false, crashed: true, port, detail: `服务进程已退出（等待 ${i} 秒）。最近输出：\n${managedRecentOutput() || '（无输出）'}` };
    }
  }
  if (managed) {
    // 预算耗尽但进程存活：绝不杀进程（调用方转后台续等）
    return { ready: false, crashed: false, port, detail: `探活预算（${budget} 秒）内未见就绪，服务进程仍在运行，转后台继续等待` };
  }
  return { ready: false, crashed: true, port, detail: `服务进程在等待期间退出。最近输出：\n${managedRecentOutput() || '（无输出）'}` };
}

/** P0 慢启动后台续等：预算耗尽但进程存活时，后台每 2s 探活；onTick 上报累计已等秒数（UI 实时
 *  「启动中（已等 N 秒）」）。就绪 → ok；进程放弃（崩溃 3 次/被停止）或窗口耗尽 → !ok——窗口
 *  耗尽时停止未就绪进程（防僵尸占端口），文案如实说明并附最近输出。 */
async function waitSlowStart(port: number, onTick: (elapsedSec: number) => void): Promise<{ ok: boolean; detail: string }> {
  const begin = Date.now();
  while (Date.now() - begin < SLOW_START_MAX_MS) {
    await new Promise((r) => setTimeout(r, 2000));
    const elapsed = PROBE_BUDGET_ROUNDS + Math.round((Date.now() - begin) / 1000);
    const h = await probeMemoryHealth(`http://127.0.0.1:${port}`, 1500);
    if (h.healthy) return { ok: true, detail: `服务已就绪（累计等待 ${elapsed} 秒）：http://127.0.0.1:${port}` };
    if (!managed) return { ok: false, detail: `服务进程已退出（累计等待 ${elapsed} 秒）。最近输出：\n${managedRecentOutput() || '（无输出）'}` };
    onTick(elapsed);
  }
  const detail = `服务启动超时（已等 ${PROBE_BUDGET_ROUNDS + Math.round(SLOW_START_MAX_MS / 1000)} 秒仍未见就绪），已停止该进程。最近输出：\n${managedRecentOutput() || '（无输出）'}`;
  stopManagedServer();
  return { ok: false, detail };
}

/** 流水线统一收尾：err 时把 running 步骤置 failed，无论成败都关闭 running 态（后台续跑路径共用） */
function finalizeInstallState(steps: InstallStep[], err?: unknown): void {
  const failed = steps.find((x) => x.status === 'running');
  if (err && failed) {
    failed.status = 'failed';
    failed.detail = err instanceof Error ? err.message : String(err);
  }
  installState.running = false;
  installState.finishedAt = new Date().toISOString();
}

async function stepStart(bin: string, confPath: string, opts: { forceRestart?: boolean } = {}): Promise<LaunchOutcome & { skipped: boolean }> {
  const port = readConfPort(confPath);
  // 已有受管实例：探活通即跳过（幂等重跑）；forceRestart（P1 保存即生效）则重启以应用新配置
  if (managed && !managed.stopped) {
    const h = await probeMemoryHealth(`http://127.0.0.1:${managed.port}`, 2000);
    if (h.healthy && !opts.forceRestart) {
      return { skipped: true, ready: true, crashed: false, detail: `受管实例已在运行（127.0.0.1:${managed.port}）`, port: managed.port };
    }
    stopManagedServer();
    await new Promise((r) => setTimeout(r, 1000)); // 端口释放窗口（TIME_WAIT）
  }
  const r = await launchManagedAndWait(bin, confPath, port);
  return { ...r, skipped: false };
}

// ============ 单独启动（「启动服务」按钮 → LCB 接管式启动流水线） ============

/** 启动流水线尾部（③插件接入 + 回写）：正常路径与慢启动后台续跑共用 */
async function finishStartTail(opts: { configPath: string }, port: number, external: boolean, set: (id: string, status: StepStatus, detail?: string) => void): Promise<void> {
  set('plugin', 'running');
  const pl = await stepPlugin({
    endpoint: `http://127.0.0.1:${port}`,
    account: await readMemoryAccount(opts.configPath),
  });
  set('plugin', pl.skipped ? 'skipped' : 'done', pl.detail);
  if (pl.writeback) {
    // 插件新装/调和才回写：受管场景顺带对齐 endpoint/mode；外部场景不动用户配置（只补插件引用）
    writeBackConfig(opts.configPath,
      external ? {} : { endpoint: `http://127.0.0.1:${port}`, mode: 'embedded' },
      pl.writeback.pluginPath, pl.writeback.opts);
  }
}

/**
 * 启动流水线（kind='start'，后台执行 + 与安装同款 stepper 轮询展示）：LCB 已接管 OpenViking，
 * 「启动」就应当是接管的启动——不只拉进程，还要把记忆链路整段拉就绪：
 * ① 检查服务与配置（bin / ov.conf 定位，缺失即 failed + 指引改走「检查修复 / 一键安装」）
 * ② 拉起并探活（受管拉起 + P0 预算 120s；预算耗尽且进程存活 → 转后台续等（UI 显示
 *    「启动中（已等 N 秒）」），就绪自动续跑 ③；已在运行则 skipped，幂等重跑）
 * ③ 接入记忆插件（CLI 市场渠道真实安装：已登记启用 → skipped；缺失 → marketplace add/install/enable
 *  三步幂等安装，插件页可见可管理；CLI 失败回退 zip 下载自管副本）
 * 完成后无须再点「检查修复」——启动结束即完整接管态。任何一步失败即停（同安装流水线语义）。
 */
export async function runStartPipeline(opts: { configPath: string }): Promise<InstallState> {
  if (installState.running) return installState;
  installState = { kind: 'start', running: true, startedAt: new Date().toISOString(), steps: START_STEPS() };
  const steps = installState.steps;
  const set = (id: string, status: StepStatus, detail?: string) => {
    const s = steps.find((x) => x.id === id)!;
    s.status = status;
    if (detail !== undefined) s.detail = detail;
  };
  try {
    // ① 定位 bin + conf（受管 conf 优先 → 外部 conf 兜底；缺失即挡下并给改道指引）
    set('locate', 'running');
    const uv = await detectUv();
    const bin = uv ? await resolveServerBin(uv) : null;
    if (!bin) throw new Error('未检测到已安装的 OpenViking 服务（openviking-server）——请点「检查修复」自动补齐运行时与服务');
    const confPath = existsSync(MANAGED_OV_CONF) ? MANAGED_OV_CONF
      : existsSync(EXTERNAL_OV_CONF) ? EXTERNAL_OV_CONF : undefined;
    if (!confPath) throw new Error('未找到服务配置（ov.conf）——请点「检查修复」自动生成（需先在「模型配置」卡填好并保存）');
    const external = confPath === EXTERNAL_OV_CONF;
    set('locate', 'done', `服务：${bin}${external ? `；配置：${confPath}（外部，LCB 仅代为拉起、不改写）` : '；配置：受管 ov.conf'}`);
    // ② 拉起 + 探活（已有受管实例且探活通过 → skipped）
    set('launch', 'running');
    let port = managed?.port;
    let needLaunch = true;
    if (managed && !managed.stopped) {
      const h = await probeMemoryHealth(`http://127.0.0.1:${managed.port}`, 2000);
      if (h.healthy) {
        set('launch', 'skipped', `受管实例已在运行（127.0.0.1:${managed.port}）`);
        needLaunch = false;
      } else {
        stopManagedServer();
      }
    }
    if (needLaunch) {
      const r = await launchManagedAndWait(bin, confPath, readConfPort(confPath), external);
      if (!r.ready) {
        if (r.crashed) {
          set('launch', 'failed', r.detail);
          throw new Error(r.detail);
        }
        // P0 慢启动：进程存活 → 不杀不红叉，保持流水线 running 转后台续等，就绪自动续跑 ③
        set('launch', 'running', `启动中（已等 ${PROBE_BUDGET_ROUNDS} 秒）…`);
        void (async () => {
          const slow = await waitSlowStart(r.port, (s) => set('launch', 'running', `启动中（已等 ${s} 秒）…`));
          if (!slow.ok) {
            set('launch', 'failed', slow.detail);
            finalizeInstallState(steps);
            return;
          }
          set('launch', 'done', slow.detail);
          try {
            await finishStartTail(opts, r.port, external, set);
            finalizeInstallState(steps);
          } catch (e) {
            finalizeInstallState(steps, e);
          }
        })();
        return installState; // running 保持 true：前端持续轮询看实时秒数
      }
      port = r.port;
      set('launch', 'done', r.detail);
    }
    // ③ 插件接入（启动完整性的另一半：插件缺失时记忆照样不工作——补齐并回写显式引用；
    //    client 传 endpoint/account：顺带落客户端接入配置 ovcli.conf，外部模式由 ensure 自守卫跳过）
    await finishStartTail(opts, port ?? 1933, external, set);
    finalizeInstallState(steps);
    return installState;
  } catch (e) {
    finalizeInstallState(steps, e);
    return installState;
  }
}

// ============ 启动自举（LCB 启动时自动拉起受管记忆服务） ============

/**
 * 自举结果（控制台分步提示 + 配置页状态区展示共用）。ready=false 一律**不阻断 LCB**：
 * 记忆是增强能力，桥接器本体必须在任何记忆故障下照常服务（与「记忆不可用不阻断机器人」同基调）。
 * hint 是给用户的下一步指引——自举失败时页面/控制台直接展示「去哪手动起」，不必自己猜。
 */
export interface MemoryAutoStartReport {
  at: string;
  trigger: 'lcb-start';
  ready: boolean;
  /** 本次是否真的拉起了进程（false=已在跑/远程模式/未安装/失败） */
  started: boolean;
  /**
   * 自举阶段（配置页重启弹窗分步展示的判定源）：starting=服务拉起中（含前台等待与慢启动
   * 后台续等）；ready=已就绪（含「已在运行」幂等跳过与后台续等成功）；failed=失败/未启用
   * 等终态。历史缺陷：后台续等（waitSlowStart）结果不回写，报告永远停在转后台那一刻的
   * 「启动中」文案——页面无从得知最终就绪与否，本字段随结果回写一并闭环。
   */
  phase: 'starting' | 'ready' | 'failed';
  detail: string;
  hint?: string;
}

let autoStartReport: MemoryAutoStartReport | undefined;

/** 最近一次启动自举结果（配置页状态区展示源；从未自举过则 undefined） */
export function getMemoryAutoStartReport(): MemoryAutoStartReport | undefined {
  return autoStartReport;
}

/** endpoint 是否指向本机回环（远程服务 LCB 不代管拉起） */
function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const h = new URL(endpoint).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
  } catch { return false; }
}

/**
 * 启动自举：LCB 启动时确保受管 OpenViking 服务在跑（embedded + 本机回环才代管）。
 * 设计约束（三条，缺一不可）：
 *  ① **绝不阻断启动**：任何失败/超时都只产出 report（ready=false + hint），由调用方打印提示；
 *  ② **有界等待**：前台最多等 foregroundMs（默认 60s），超时但进程存活 → 转后台续等
 *     （waitSlowStart），既不空等也不杀进程；崩溃 → 立刻失败并附最近输出；
 *  ③ **幂等**：已在跑（含外部自管服务占用同一端口且健康）直接 skipped，重启 LCB 无副作用。
 * 不碰插件接入（stepPlugin 属安装/启动流水线语义）：插件缺失由配置页「检查修复」补齐，
 * 启动自举只负责「服务在不在」这一件事，避免启动路径被 npm/marketplace 安装拖住。
 */
export async function ensureMemoryServiceRunning(opts: {
  endpoint: string;
  mode?: string;
  trigger?: 'lcb-start';
  foregroundMs?: number;
}): Promise<MemoryAutoStartReport> {
  const trigger = opts.trigger ?? 'lcb-start';
  const foregroundMs = opts.foregroundMs ?? 60_000;
  const finish = (
    r: Omit<MemoryAutoStartReport, 'at' | 'trigger' | 'phase'>,
    phaseOverride?: MemoryAutoStartReport['phase'],
  ): MemoryAutoStartReport => {
    // phase：ready=true 即终态就绪；慢启动转后台续等显式传 'starting'（终态由 waitSlowStart
    // 回写）；其余（未安装/缺配置/崩溃/远程不可达）为终态 failed——页面据此决定继续轮询还是亮黄警示
    const phase: MemoryAutoStartReport['phase'] = phaseOverride ?? (r.ready ? 'ready' : 'failed');
    autoStartReport = { at: new Date().toISOString(), trigger, phase, ...r };
    return autoStartReport;
  };
  // 远程模式：只探活不代管（拉起别人的服务是越权）
  if ((opts.mode ?? 'embedded') !== 'embedded' || !isLoopbackEndpoint(opts.endpoint)) {
    const h = await probeMemoryHealth(opts.endpoint, 2000);
    return finish({
      ready: h.healthy,
      started: false,
      detail: h.healthy
        ? `远程记忆服务正常：${opts.endpoint}`
        : `远程记忆服务不可达：${h.detail ?? '未知原因'}（LCB 不代管拉起外部服务）`,
      ...(h.healthy ? {} : { hint: '请自行确认远程记忆服务已启动；本机地址与端口见 config.yaml 的 memory.endpoint' }),
    });
  }
  // 已健康（含用户手工起的外部实例）→ 幂等跳过
  const before = await probeMemoryHealth(opts.endpoint, 2000);
  if (before.healthy) {
    return finish({ ready: true, started: false, detail: `服务已在运行：${opts.endpoint}${before.authMode ? `（${before.authMode} 模式）` : ''}` });
  }
  // 定位二进制与配置（与启动流水线 ① 同款判定，缺任一即给「检查修复」指引）
  const uv = await detectUv();
  const bin = uv ? await resolveServerBin(uv) : null;
  if (!bin) {
    return finish({
      ready: false, started: false,
      detail: `服务未运行，且未检测到 OpenViking 运行时（openviking-server）：${before.detail ?? '端口无监听'}`,
      hint: '请到配置页「记忆增强 → 检查修复」补装运行时与服务',
    });
  }
  const confPath = existsSync(MANAGED_OV_CONF) ? MANAGED_OV_CONF
    : existsSync(EXTERNAL_OV_CONF) ? EXTERNAL_OV_CONF : undefined;
  if (!confPath) {
    return finish({
      ready: false, started: false,
      detail: `服务未运行，且未找到服务配置（ov.conf）：${before.detail ?? '端口无监听'}`,
      hint: '请到配置页「记忆增强」填好模型三件套并保存（生成 ov.conf），再点「检查修复」',
    });
  }
  const external = confPath === EXTERNAL_OV_CONF;
  const port = readConfPort(confPath);
  // 受管实例仍在但探不通（假活）→ 先回收再拉起，避免端口占用导致新进程秒退
  if (managed && !managed.stopped) {
    stopManagedServer();
    await new Promise((r) => setTimeout(r, 1000));
  }
  const r = await launchManagedAndWait(bin, confPath, port, external, { budgetRounds: Math.max(5, Math.ceil(foregroundMs / 1000)) });
  if (r.ready) {
    return finish({
      ready: true, started: true,
      detail: `已拉起受管记忆服务：http://127.0.0.1:${port}${external ? '（外部 ov.conf，LCB 仅代为拉起、不改写）' : ''}`,
    });
  }
  if (r.crashed) {
    return finish({
      ready: false, started: true,
      detail: `自动拉起失败（服务进程已退出）：${r.detail}`,
      hint: '请到配置页「记忆增强」检查模型三件套与 ov.conf，或点「检查修复」查看完整安装流水线',
    });
  }
  // 慢启动：进程活着只是还没就绪 → 后台续等，不红叉、不杀进程；后续签发由调用方重试兜上。
  // 续等结果回写报告（phase → ready/failed）：否则报告永远停在「启动中」，重启弹窗/状态区
  // 无从得知最终就绪与否（历史盲区）
  void waitSlowStart(r.port, () => { /* 后台续等进度不进控制台（启动已结束），页面轮询 install 状态即可见 */ })
    .then((w) => {
      if (!autoStartReport) return;
      autoStartReport = {
        ...autoStartReport,
        at: new Date().toISOString(),
        phase: w.ok ? 'ready' : 'failed',
        ready: w.ok,
        detail: w.detail,
        ...(w.ok ? {} : { hint: '请到配置页「记忆增强」检查模型三件套与 ov.conf，或点「检查修复」查看完整安装流水线' }),
      };
    });
  return finish({
    ready: false, started: true,
    detail: `记忆服务正在启动（冷启动超过 ${Math.round(foregroundMs / 1000)} 秒，进程仍在运行，已转入后台等待）`,
    hint: '通常 1-3 分钟内就绪；若长时间未起，请到配置页「记忆增强」查看受管服务输出',
  }, 'starting');
}

function spawnManaged(bin: string, confPath: string, port: number): void {
  const proc = spawn(bin, ['--config', confPath, '--host', '127.0.0.1', '--port', String(port)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  managed = { proc, port, restarts: 0, stopped: false, confPath, startedAt: new Date().toISOString(), output: [] };
  proc.on('exit', () => {
    if (!managed || managed.proc !== proc) return;
    if (managed.stopped) { managed = undefined; return; }
    // 崩溃自动重启（上限 3 次，防坏配置循环拉起刷屏）
    if (managed.restarts < 3) {
      managed.restarts += 1;
      console.warn(`[memory] 受管服务退出，${2}s 后自动重启（第 ${managed.restarts}/3 次）：${bin}`);
      setTimeout(() => {
        if (managed && !managed.stopped && managed.restarts <= 3) {
          try { spawnManaged(bin, confPath, port); } catch (e) { console.error('[memory] 重启失败：', e); }
        }
      }, 2000);
    } else {
      console.error('[memory] 受管服务连续崩溃 3 次，已停止自动重启——请检查 ov.conf 后在页面重新拉起');
      managed = undefined;
    }
  });
  // P0：stdout 原先只 pipe 不消费——缓冲写满会阻塞子进程且信息全丢；现转发控制台并入环形缓冲
  //（stderr 同款），失败文案「最近输出：…」即来源于此
  proc.stdout?.on('data', (d: Buffer) => {
    for (const raw of String(d).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      pushManagedOutput(line);
      console.log('[memory-server]', line.slice(0, 300));
    }
  });
  proc.stderr?.on('data', (d: Buffer) => {
    for (const raw of String(d).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      pushManagedOutput(line);
      console.warn('[memory-server]', line.slice(0, 300));
    }
  });
}

// ============ 步骤 5：插件 ============

/** LCB 自管插件目录：zip 下载兜底路径的落点（CLI 市场渠道失败时；正常安装走 marketplace 登记，
 *  插件页可见可管理），<根>/<版本>/ 版本目录化可并存 */
const MANAGED_PLUGIN_ROOT = join(process.env.LCB_CONFIG_DIR ?? String(process.env.USERPROFILE ?? process.env.HOME ?? ''),
  '.lark-claudecode-bridge', 'plugins', MEMORY_PLUGIN_NAME);

/** 记忆插件定位结果：path 恒为真实可加载目录（.claude-plugin/plugin.json 在）。
 *  where 标注渠道——marketplace=CLI 安装且 enabledPlugins 启用（SDK 自动发现，无须显式引用）；
 *  explicit=config.yaml apps[].plugins 显式引用（运行时实际加载源）；managed=LCB 自管副本
 *  （stepPlugin 的下载落点，未被引用时运行时不会加载——只对修复流水线有意义） */
export interface MemoryPluginLocation {
  path: string;
  where: 'marketplace' | 'explicit' | 'managed';
  version?: string;
  marketplace?: string;
}

/** 自管目录最新合法副本：扫 MANAGED_PLUGIN_ROOT 下一层版本目录，取语义化版本最高且
 *  plugin.json 在的（字符串比较会把 0.7.6 排在 0.7.11 后——按数字段比较）。目录缺失/无合法副本返回 null */
function latestManagedCopy(): { path: string; version: string } | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(MANAGED_PLUGIN_ROOT, { withFileTypes: true });
  } catch { return null; } // 目录不存在 = 从未下载过，正常态
  const candidates: Array<{ path: string; version: string; parts: number[] }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const marker = join(MANAGED_PLUGIN_ROOT, e.name, '.claude-plugin', 'plugin.json');
    if (!existsSync(marker)) continue;
    let version = e.name;
    try { version = (JSON.parse(readFileSync(marker, 'utf8')) as { version?: string }).version ?? e.name; } catch { /* 清单损坏按目录名 */ }
    candidates.push({ path: join(MANAGED_PLUGIN_ROOT, e.name), version, parts: version.split('.').map((n) => parseInt(n, 10) || 0) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    for (let i = 0; i < 3; i++) { const d = (a.parts[i] ?? 0) - (b.parts[i] ?? 0); if (d) return d; }
    return 0;
  });
  return candidates[candidates.length - 1];
}

/**
 * 记忆插件三渠道定位（状态页与安装流水线的共用口径，取代「只看 marketplace」的旧探测——
 * CLI 卸载只清 installed_plugins.json/enabledPlugins 登记，config.yaml 显式引用与自管副本
 * 依旧在工作的场景曾被误报「未安装」）。探测顺序对齐 resolvePluginPaths 的装配语义
 * （同名显式优先）：运行时实际加载谁，状态就报谁。
 * ① config.yaml apps[].plugins 显式引用（任意 bot 命中即可；路径须 plugin.json 在——SDK 对
 *    无效路径静默跳过，死路径按未装处理，交给修复流水线改指）；
 * ② marketplace 自动发现（与 executeTask 同款双目录口径）；
 * ③ LCB 自管副本（仅 opts.includeManaged=true 时计入——未被引用的副本运行时不会加载，
 *    状态页不算已装；修复流水线算，据其免重装并回写补引用）。
 * 全程容错：单渠道异常按未命中继续，全 miss 返回 null。
 */
export async function locateMemoryPlugin(
  config: BridgeConfig,
  opts: { includeManaged?: boolean } = {},
): Promise<MemoryPluginLocation | null> {
  for (const app of config.apps ?? []) {
    const ref = (app.plugins ?? []).find((p) => p.name === MEMORY_PLUGIN_NAME);
    if (ref?.path && existsSync(join(ref.path, '.claude-plugin', 'plugin.json'))) {
      return { path: ref.path, where: 'explicit' };
    }
  }
  try {
    const { discoverPlugins } = await import('./executor/plugin-discovery.js');
    const { DEFAULT_CLAUDE_DIR, resolveClaudeDir } = await import('./claude-config.js');
    const claudeDir = resolveClaudeDir(config);
    const dirs = claudeDir === DEFAULT_CLAUDE_DIR ? [claudeDir] : [claudeDir, DEFAULT_CLAUDE_DIR];
    for (const d of dirs) {
      const found = discoverPlugins(d).find((p) => p.name === MEMORY_PLUGIN_NAME);
      if (found) {
        return {
          path: found.path, where: 'marketplace',
          ...(found.version ? { version: found.version } : {}),
          ...(found.marketplace ? { marketplace: found.marketplace } : {}),
        };
      }
    }
  } catch { /* 插件发现容错契约（配置损坏等）：本渠道按未命中继续 */ }
  if (opts.includeManaged) {
    const managed = latestManagedCopy();
    if (managed) return { path: managed.path, where: 'managed', version: managed.version };
  }
  return null;
}

/** stepPlugin 的回写指令：pluginPath + writeBackConfig 调和选项一并携带（调用方透传） */
export interface PluginWriteback {
  pluginPath: string;
  opts?: WriteBackOpts;
}

// ============ CLI 同构登记（zip 兜底路径用） ============
// 实测教训（2026-10-14 本机）：`claude plugin install` 对 git-subdir 源走 partial-clone，
// blob 懒拉取（promisor fetch）在部分网络下必挂（HTTP 400 expected 'packfile'，HTTP/1.1 亦然），
// 而全量归档（codeload zip）稳定可达。兜底路径改为 zip 落地 + 手工合并 CLI 登记状态——
// 文件形状与 CLI 真实产物同构（~/.claude/plugins/installed_plugins.json v2 实测蓝本），
// 插件页列表与 CLI enable/disable/uninstall 均按同一状态原生工作。

interface CliInstalledEntry { scope?: string; installPath?: string; version?: string; installedAt?: string; lastUpdated?: string; gitCommitSha?: string }
interface CliInstalledDoc { version?: number; plugins?: Record<string, CliInstalledEntry[]> }

/** installed_plugins.json（v2）合并登记：保留既有插件条目，仅 upsert 本插件（scope=user）。
 *  文件缺失/损坏重建为最小合法文档；installedAt 沿用旧值（重装不洗安装时间）。
 *  exported 便于单测验证合并语义 */
export function registerInstalledPlugin(claudeDir: string, key: string, item: { installPath: string; version?: string }): void {
  const path = join(claudeDir, 'plugins', 'installed_plugins.json');
  const doc = (() => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as CliInstalledDoc;
      if (parsed.version === 2 && parsed.plugins && typeof parsed.plugins === 'object') {
        return { version: 2, plugins: parsed.plugins };
      }
    } catch { /* 缺失/损坏 → 重建 */ }
    return { version: 2, plugins: {} as Record<string, CliInstalledEntry[]> };
  })();
  const prev = Array.isArray(doc.plugins[key]) ? doc.plugins[key].find((e) => e.scope === 'user') : undefined;
  const now = new Date().toISOString();
  doc.plugins[key] = [{
    scope: 'user',
    installPath: item.installPath,
    ...(item.version ? { version: item.version } : {}),
    installedAt: prev?.installedAt ?? now,
    lastUpdated: now,
  }];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
}

/** settings.json enabledPlugins 启用（整体读改写保留其余键；文件缺失/损坏建最小对象）。
 *  exported 便于单测验证保留语义 */
export function enablePluginInSettings(claudeDir: string, key: string): void {
  const path = join(claudeDir, 'settings.json');
  let doc: Record<string, unknown> = {};
  try { doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { /* 缺失/损坏 → 新建 */ }
  const ep = (doc.enabledPlugins && typeof doc.enabledPlugins === 'object' && !Array.isArray(doc.enabledPlugins))
    ? doc.enabledPlugins as Record<string, unknown> : {};
  ep[key] = true;
  doc.enabledPlugins = ep;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
}

/** 已登记市场名集合（known_marketplaces.json 键；url/github 源市场不物化清单副本，登记表即事实源） */
function knownMarketplaceNames(claudeDir: string): Set<string> {
  try {
    const doc = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'known_marketplaces.json'), 'utf8')) as Record<string, unknown>;
    return new Set(Object.keys(doc));
  } catch { return new Set(); } // 从未添加过任何市场
}

/**
 * CLI 市场渠道真实安装：marketplace add（缺登记时）→ plugin install（缺装/产物失效时）
 * → plugin enable（未启用时）→ discoverPlugins 终验（双登记 + 路径有效 = 任务装配可加载）。
 * 三步各自幂等可重跑；产物路径从安装清单回读（installPath 供调和回写）。
 * 任何一步失败返回 { detail } 不抛出——调用方回退 zip 下载兜底。
 */
async function cliInstallViaMarketplace(claudeDir: string, dirs: string[]): Promise<{ detail: string; installPath?: string }> {
  const { runPluginCli } = await import('./executor/plugin-manager.js');
  const { discoverPlugins, listInstalledPlugins } = await import('./executor/plugin-discovery.js');
  if (!knownMarketplaceNames(claudeDir).has(MARKETPLACE_NAME)) {
    let lastErr = '';
    for (const src of MARKETPLACE_ADD_SOURCES) {
      const r = await runPluginCli(['marketplace', 'add', src], { claudeConfigDir: claudeDir });
      if (r.ok && knownMarketplaceNames(claudeDir).has(MARKETPLACE_NAME)) { lastErr = ''; break; }
      lastErr = r.text;
    }
    if (lastErr || !knownMarketplaceNames(claudeDir).has(MARKETPLACE_NAME)) {
      return { detail: `注册市场 ${MARKETPLACE_NAME} 失败：${lastErr || '登记表未见该市场'}` };
    }
  }
  // 安装（已装且产物在位则跳过；install 自带 -y 非交互确认）
  const entry = listInstalledPlugins(claudeDir).find((p) => p.key === MARKETPLACE_KEY || p.name === MEMORY_PLUGIN_NAME);
  if (!entry?.path || !existsSync(entry.path)) {
    const r = await runPluginCli(['install', MARKETPLACE_KEY], { claudeConfigDir: claudeDir });
    if (!r.ok) return { detail: `安装 ${MARKETPLACE_KEY} 失败：${r.text}` };
  }
  // 启用（install 不保证 enabledPlugins 落 true；enable 对已启用为幂等 no-op）
  const discoverHit = (): string | undefined => {
    for (const d of dirs) {
      const hit = discoverPlugins(d).find((p) => p.name === MEMORY_PLUGIN_NAME);
      if (hit) return hit.path;
    }
    return undefined;
  };
  if (!discoverHit()) {
    const r = await runPluginCli(['enable', MARKETPLACE_KEY], { claudeConfigDir: claudeDir });
    if (!r.ok) return { detail: `启用 ${MARKETPLACE_KEY} 失败：${r.text}` };
  }
  const installPath = discoverHit();
  return installPath
    ? { detail: `已安装并启用：${installPath}`, installPath }
    : { detail: `安装动作已完成但未能自动发现 ${MARKETPLACE_KEY}（installed_plugins/enabledPlugins 未生效，请反馈）` };
}

/** 接入记忆插件（安装流水线第 5 步/启动流水线第 3 步共用；exported 便于运维脚本与单测直调）：
 *  ① CLI marketplace 双登记命中 → skipped；② CLI 真实安装（幂等）；③ zip 兜底 + CLI 同构登记。
 *  client 传入时（endpoint/account）同时落客户端接入配置 ovcli.conf（§6.7 第 4 步：插件启用判定
 *  的文件兜底层；写入失败只 warn 不阻塞插件接入——LCB 会话另有 env 通道兜底） */
export async function stepPlugin(client?: { endpoint: string; account?: string }):
  Promise<{ skipped: boolean; detail: string; writeback?: PluginWriteback; clientConf?: ClientConfWrite }> {
  // 客户端配置先落（三个 return 分支都要携带：①分支是高频提前 return——「已装但无文件」的
  // 存量机器最常见形态，放函数体后段会漏掉）
  let clientConf: ClientConfWrite | undefined;
  if (client) {
    try { clientConf = ensureClientCliConf(client); }
    catch (e) { console.warn('[memory-installer] ovcli.conf 写入失败（不阻塞插件接入）：', e instanceof Error ? e.message : e); }
  }
  const detailSuffix = clientConf ? `；客户端配置 ${clientConf}` : '';
  const { loadConfig } = await import('./config.js');
  const { DEFAULT_CLAUDE_DIR, resolveClaudeDir } = await import('./claude-config.js');
  let claudeDir = DEFAULT_CLAUDE_DIR;
  try { claudeDir = resolveClaudeDir(loadConfig()); } catch { /* 配置损坏按默认目录装配口径 */ }
  const dirs = claudeDir === DEFAULT_CLAUDE_DIR ? [claudeDir] : [claudeDir, DEFAULT_CLAUDE_DIR];

  // ① CLI marketplace 双登记命中 = 完整安装态（插件页可见、可启停可更新）。仍携带调和回写：
  //    把产物域旧显式引用对齐当前登记版本（writeBackConfig 值一致时零写盘，幂等）——否则
  //    CLI update 装新版后旧引用仍钉死旧版本目录，运行时与插件页版本错位
  try {
    const { discoverPlugins } = await import('./executor/plugin-discovery.js');
    for (const d of dirs) {
      const hit = discoverPlugins(d).find((p) => p.name === MEMORY_PLUGIN_NAME);
      if (hit) return {
        skipped: true,
        detail: `已安装（CLI marketplace 已启用）：${hit.path}${detailSuffix}`,
        clientConf,
        writeback: {
          pluginPath: hit.path,
          opts: { reconcileOnly: true, artifactRoots: [...dirs.map((x) => join(x, 'plugins', 'cache')), MANAGED_PLUGIN_ROOT] },
        },
      };
    }
  } catch { /* 发现容错契约：继续走安装 */ }

  // ② CLI 市场渠道真实安装（幂等可重跑）。成功即调和 config.yaml：把指向旧安装产物
  //    （plugins/cache / 自管副本域）或已失效路径的显式引用就地改指新 installPath——
  //    不新增引用（发现渠道已覆盖加载），用户显式指的 dev 目录不动（reconcileOnly 语义）
  const cli = await cliInstallViaMarketplace(claudeDir, dirs);
  if (cli.installPath) {
    return {
      skipped: false,
      detail: `${cli.detail}（插件页可见，可启停/更新）${detailSuffix}`,
      clientConf,
      writeback: {
        pluginPath: cli.installPath,
        opts: { reconcileOnly: true, artifactRoots: [...dirs.map((d) => join(d, 'plugins', 'cache')), MANAGED_PLUGIN_ROOT] },
      },
    };
  }
  console.warn(`[memory-installer] CLI 市场安装未成功，回退自管下载：${cli.detail}`);

  // ③ 兜底：CLI 市场安装不可用（partial-clone blob 拉取被网络掐断等）→ 仍以 CLI 同构状态落地：
  //    codeload 全量归档（实测比 partial-clone 稳定）→ 解出插件子目录 → 物化到 CLI 缓存布局
  //    plugins/cache/<市场>/<插件>/<版本>/ → 合并登记（installed_plugins.json v2 + enabledPlugins）
  //    → 插件页可见、CLI enable/disable/uninstall 均原生可用，与 ② 成功态完全等价
  // 下载主仓库归档 → 取 examples/claude-code-memory-plugin → 校验 plugin.json → 拷入缓存布局
  const isWin = process.platform === 'win32';
  const ref = 'main'; // pin 到 tag 的能力随 memory.version 演进（版本受控，风险 8.4）
  const tmp = mkdtempSync(join(tmpdir(), 'lcb-ovp-'));
  try {
    const archive = join(tmp, isWin ? 'repo.zip' : 'repo.tgz');
    await downloadTo(isWin ? PLUGIN_REPO_ZIP(ref) : PLUGIN_REPO_TGZ(ref), archive);
    // 只提取需要的子目录成员（实测教训：整仓解压时无关条目会触发 bsdtar 的 \\?\ 长路径 bug
    // 报错退出；且只取子目录比解 60MB 全仓快得多）。成员名与 codeload 解包根一致
    const member = `OpenViking-${ref}/${PLUGIN_SUBDIR}`;
    const t = tarCommand();
    await run(t.cmd, [...t.args, '-xf', archive, '-C', tmp, member], { timeoutMs: 180_000 });
    const srcRoot = join(tmp, `OpenViking-${ref}`, ...PLUGIN_SUBDIR.split('/'));
    const marker = join(srcRoot, '.claude-plugin', 'plugin.json');
    if (!existsSync(marker)) throw new Error('归档中未找到 examples/claude-code-memory-plugin/.claude-plugin/plugin.json（上游结构可能已变化）');
    // 版本目录化（升级可并存）：读 plugin.json 的 version
    const pkg = JSON.parse(readFileSync(marker, 'utf8')) as { version?: string };
    const version = pkg.version ?? '0.0.0';
    const dest = join(claudeDir, 'plugins', 'cache', MARKETPLACE_NAME, MEMORY_PLUGIN_NAME, version);
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    await run(process.platform === 'win32' ? 'xcopy' : 'cp', process.platform === 'win32'
      ? [srcRoot, dest, '/E', '/I', '/Q', '/Y']
      : ['-r', srcRoot, dest], { timeoutMs: 60_000 });
    if (!existsSync(join(dest, '.claude-plugin', 'plugin.json'))) throw new Error('插件拷贝后校验失败');
    // CLI 同构登记 + 启用（幂等合并写，保留既有条目/其余键），清发现缓存让本进程立即可见
    registerInstalledPlugin(claudeDir, MARKETPLACE_KEY, { installPath: dest, version });
    enablePluginInSettings(claudeDir, MARKETPLACE_KEY);
    const { invalidatePluginCache } = await import('./executor/plugin-discovery.js');
    invalidatePluginCache(claudeDir);
    return {
      skipped: false,
      detail: `已安装 v${version}（CLI 同构登记）→ ${dest}（插件页可见，可启停/更新）${detailSuffix}`,
      clientConf,
      writeback: {
        pluginPath: dest,
        opts: { reconcileOnly: true, artifactRoots: [...dirs.map((d) => join(d, 'plugins', 'cache')), MANAGED_PLUGIN_ROOT] },
      },
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ============ config.yaml 定向写（保注释，YAML AST set） ============

/** 原子写（tmp + rename）：与 web/server.ts / claude-profile.ts 的 writeAtomic 同款实现，独立内联避免反向依赖 */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

interface MemoryWriteback {
  /** 键可选：启动流水线的外部配置场景只补插件引用，不写 endpoint/mode（不动用户现值） */
  endpoint?: string;
  mode?: 'embedded';
  /** 首装生成的 root_api_key 回写 memory.api_key（复用已有 key 时不写，不动用户现值） */
  apiKey?: string;
}

/** writeBackConfig 的插件引用调和选项（CLI 渠道安装场景） */
export interface WriteBackOpts {
  /** 调和模式：不为缺引用的 app 新增显式引用（CLI 登记后发现渠道已覆盖加载，新增只会
   *  把路径钉死在某个版本目录上）；仅把指向安装产物域或已失效路径的旧引用就地改指新路径 */
  reconcileOnly?: boolean;
  /** 调和模式产物域根：路径落在其下（或不存在）的旧引用视为可改指——用户显式指的 dev 目录不动 */
  artifactRoots?: string[];
}

/** 只写 memory 段的指定键（endpoint/mode/api_key，仅写提供的键）与 apps[].plugins 显式引用；值未变跳过不重写。
 *  exported 便于单测直接验证（YAML AST 保注释 / 幂等重写行为） */
export function writeBackConfig(configPath: string, wb: MemoryWriteback, pluginPath?: string, opts: WriteBackOpts = {}): void {
  const raw = readFileSync(configPath, 'utf8');
  const doc = parseDocument(raw);
  let changed = false;
  const mem = doc.get('memory');
  const ensureSet = (node: { get(k: string): unknown; set(k: string, v: unknown): unknown }, key: string, val: unknown) => {
    if (val !== undefined && JSON.stringify(node.get(key)) !== JSON.stringify(val)) { node.set(key, val); changed = true; }
  };
  if (mem && typeof mem === 'object') {
    ensureSet(mem as unknown as { get(k: string): unknown; set(k: string, v: unknown): unknown }, 'endpoint', wb.endpoint);
    ensureSet(mem as unknown as { get(k: string): unknown; set(k: string, v: unknown): unknown }, 'mode', wb.mode);
    if (wb.apiKey) ensureSet(mem as unknown as { get(k: string): unknown; set(k: string, v: unknown): unknown }, 'api_key', wb.apiKey);
  } else if (wb.endpoint) {
    doc.set('memory', { enabled: true, mode: wb.mode ?? 'embedded', endpoint: wb.endpoint, ...(wb.apiKey ? { api_key: wb.apiKey } : {}) });
    changed = true;
  }
  if (pluginPath) {
    // YAMLSeq 非原生 Array（Array.isArray 恒 false）——统一经 .items 访问成员；追加节点用
    // doc.createNode 包装（官方 API，普通对象 → YAML 节点），避免裸对象进 AST 的序列化歧义
    const apps = doc.get('apps') as unknown as { items?: Array<unknown> } | undefined;
    for (const app of apps?.items ?? []) {
      const appNode = app as unknown as { get(k: string): unknown; set(k: string, v: unknown): unknown } | null;
      if (!appNode || typeof appNode.get !== 'function') continue;
      const plugins = appNode.get('plugins') as unknown as { items?: Array<unknown> } | null;
      // 同名条目就地更新而非整跳过（实测缺陷：CLI 卸载后旧引用指向已失效路径，按名去重
      // 恒跳过 → 修复装好的新副本永远接不进配置）：路径一致 = 幂等不写；不同 = 改指新路径
      const existing = (plugins?.items ?? []).find((p) =>
        (p as unknown as { get?(k: string): unknown })?.get?.('name') === MEMORY_PLUGIN_NAME) as
        | { get(k: string): unknown; set(k: string, v: unknown): unknown }
        | undefined;
      if (existing) {
        const cur = existing.get('path');
        if (cur === pluginPath) continue;
        if (opts.reconcileOnly) {
          // 调和口径：旧路径属产物域（cache/自管根）或已不存在/为空 → 改指；其余（用户显式
          // 指的 dev 源码目录等）不动——CLI 安装后运行时经发现渠道取新版，显式 dev 引用照旧生效
          const curStr = typeof cur === 'string' ? cur : '';
          const artifact = !curStr || !existsSync(curStr)
            || (opts.artifactRoots ?? []).some((root) => curStr.startsWith(root));
          if (!artifact) continue;
        }
        existing.set('path', pluginPath);
        changed = true;
        continue;
      }
      if (opts.reconcileOnly) continue; // 调和模式不新增引用（发现渠道已覆盖，新增反而钉死版本路径）
      if (plugins && Array.isArray(plugins.items)) {
        plugins.items.push(doc.createNode({ name: MEMORY_PLUGIN_NAME, path: pluginPath }));
      } else {
        appNode.set('plugins', doc.createNode([{ name: MEMORY_PLUGIN_NAME, path: pluginPath }]));
      }
      changed = true;
    }
  }
  if (!changed) return;
  writeAtomic(configPath, doc.toString({ lineWidth: 0 }));
}

// ============ 主流水线 ============

/** 读 config.yaml 的 memory.account（懒加载；损坏配置降级 undefined → 调用方取缺省 default）。
 *  两条流水线原本不读 config.yaml（只有 configPath），stepPlugin 落 ovcli.conf 时需要它 */
async function readMemoryAccount(configPath: string): Promise<string | undefined> {
  try {
    const { loadConfig } = await import('./config.js');
    return loadConfig(configPath).memory?.account;
  } catch { return undefined; }
}

export interface InstallOptions {
  configPath: string;
  /** memory.model（渲染 ov.conf 的模型三件套）；缺失时若受管 conf 已存在则沿用现有（重跑场景） */
  model?: MemoryModelConfig;
  /** 服务 pin 版本（memory.version ?? DEFAULT_OPENVIKING_PIN） */
  pin?: string;
  /** P1 保存即生效（「立即生效」按钮）：受管实例探活通过也强制重启——模型配置保存后
   *  ov.conf 已重渲染，但运行中的旧进程不会热加载，必须重启才能应用新模型 */
  forceRestart?: boolean;
}

/** 安装流水线尾部（⑤插件接入 + ⑥回写 config.yaml）：正常路径与慢启动后台续跑共用 */
async function finishInstallTail(opts: InstallOptions, port: number, firstInstallKey: string | undefined, set: (id: InstallStep['id'], status: StepStatus, detail?: string) => void): Promise<void> {
  // ⑤ 插件（client 传 endpoint/account：顺带落客户端接入配置 ovcli.conf，§6.7 第 4 步）
  set('plugin', 'running');
  const pl = await stepPlugin({
    endpoint: `http://127.0.0.1:${port}`,
    account: await readMemoryAccount(opts.configPath),
  });
  set('plugin', pl.skipped ? 'skipped' : 'done', pl.detail);
  // ⑥ 回写 config.yaml——全链成功才落盘（半成品不污染用户配置）：endpoint / mode=embedded /
  // 首装生成的 root_api_key 回写 memory.api_key（复用已有 key 不写）+ 插件引用回写（CLI 渠道为
  // 调和模式、zip 兜底为补齐模式，选项由 stepPlugin 携带）
  writeBackConfig(opts.configPath, {
    endpoint: `http://127.0.0.1:${port}`,
    mode: 'embedded',
    ...(firstInstallKey ? { apiKey: firstInstallKey } : {}),
  }, pl.writeback?.pluginPath, pl.writeback?.opts);
}

/**
 * 一键安装流水线（幂等锁：running 中重复调用直接返回当前状态）。
 * 任何一步失败即停（状态留 failed + detail），页面可整链重跑——已就绪步骤自动 skipped。
 * P0 慢启动语义：拉起步骤预算耗尽但进程存活时，流水线保持 running、转后台续等（UI 实时显示
 * 「启动中（已等 N 秒）」），就绪后自动续跑 ⑤⑥ 并收尾——调用方（HTTP 层）此刻即返回，
 * 前端经 /api/memory/install/status 轮询看到全过程。
 */
export async function runInstall(opts: InstallOptions): Promise<InstallState> {
  if (installState.running) return installState;
  installState = { kind: 'install', running: true, startedAt: new Date().toISOString(), steps: FRESH_STEPS() };
  const steps = installState.steps;
  const set = (id: InstallStep['id'], status: StepStatus, detail?: string) => {
    const s = steps.find((x) => x.id === id)!;
    s.status = status;
    if (detail !== undefined) s.detail = detail;
  };
  try {
    // 首装生成的 root_api_key（conf 步骤产出，⑥ 回写消费；重装/沿用场景为 undefined）
    let firstInstallKey: string | undefined;
    // ① uv
    set('runtime', 'running');
    let uv = await detectUv();
    if (uv) set('runtime', 'skipped', `已检测到 uv：${uv === 'uv' ? 'PATH' : uv}`);
    else {
      uv = await installUv();
      set('runtime', 'done', `已安装到 ${uv}`);
    }
    // ② 服务
    set('service', 'running');
    const svc = await stepService(uv, opts.pin ?? DEFAULT_OPENVIKING_PIN);
    set('service', svc.skipped ? 'skipped' : 'done', svc.detail);
    // ③ ov.conf（模型缺失 + conf 已存在 = 重跑：沿用现值；端口沿用已分配值，避免每次重跑漂移）
    set('config', 'running');
    // 首装前置校验（实测教训：空模型 conf 会让服务启动即崩、反复重启后才暴露——在生成配置
    // 这一步就把缺件挡下并给出指引，而不是让坏 conf 落盘）。conf 已存在（重跑/升级）则放行：
    // 现值来自上次有效安装
    const confExists = existsSync(MANAGED_OV_CONF);
    const m = opts.model;
    if (!confExists && (!m || !m.apiBase || !m.vlmModel || !m.embeddingModel)) {
      throw new Error('首装需要记忆模型三件套：api_base / vlm_model（提炼）/ embedding_model（向量）——请先在「记忆模型配置」卡填表并保存（可先 [测试连接] 验证），再点一键开启');
    }
    if (confExists && !m) {
      // 重跑且未传模型：沿用现有 conf 原文（不重渲染——重渲染空模型会生成坏 conf 且更换 root_api_key）
      set('config', 'skipped', `沿用现有配置：${MANAGED_OV_CONF}`);
    } else {
      const model = m!;
      const prevRootKey = existingRootKey();
      const prevPort = (() => { try { return (JSON.parse(readFileSync(MANAGED_OV_CONF, 'utf8')) as { server?: { port?: number } }).server?.port; } catch { return undefined; } })();
      const port = prevPort ?? await findFreePort();
      const { conf, rootApiKey } = renderOvConf(model, {
        workspaceDir: join(MEMORY_MANAGED_DIR, 'data'),
        port,
        rootApiKey: prevRootKey,
      });
      mkdirSync(MEMORY_MANAGED_DIR, { recursive: true });
      mkdirSync(join(MEMORY_MANAGED_DIR, 'data'), { recursive: true });
      writeFileSync(MANAGED_OV_CONF, JSON.stringify(conf, null, 2), 'utf8');
      // 首装（此前无 root_api_key）→ 本次生成的 key 需回写 memory.api_key；重装沿用则不写
      firstInstallKey = prevRootKey ? undefined : rootApiKey;
      set('config', 'done', `配置已生成：${MANAGED_OV_CONF}（端口 ${port}）`);
    }
    // ④ 拉起
    set('start', 'running');
    const st = await stepStart(svc.bin, MANAGED_OV_CONF, { forceRestart: opts.forceRestart });
    if (!st.ready) {
      if (st.crashed) {
        set('start', 'failed', st.detail);
        throw new Error(st.detail);
      }
      // P0 慢启动：进程存活 → 不杀不红叉，保持流水线 running 转后台续等，就绪自动续跑 ⑤⑥
      set('start', 'running', `启动中（已等 ${PROBE_BUDGET_ROUNDS} 秒）…`);
      void (async () => {
        const slow = await waitSlowStart(st.port, (s) => set('start', 'running', `启动中（已等 ${s} 秒）…`));
        if (!slow.ok) {
          set('start', 'failed', slow.detail);
          finalizeInstallState(steps);
          return;
        }
        set('start', 'done', slow.detail);
        try {
          await finishInstallTail(opts, st.port, firstInstallKey, set);
          finalizeInstallState(steps);
        } catch (e) {
          finalizeInstallState(steps, e);
        }
      })();
      return installState; // running 保持 true：前端持续轮询看实时秒数
    }
    set('start', st.skipped ? 'skipped' : 'done', st.detail);
    // ⑤⑥ 插件接入 + 回写（尾部提取：与慢启动后台续跑共用）
    await finishInstallTail(opts, st.port, firstInstallKey, set);
    finalizeInstallState(steps);
    return installState;
  } catch (e) {
    finalizeInstallState(steps, e);
    return installState;
  }
}
