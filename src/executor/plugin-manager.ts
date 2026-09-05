// 插件管理执行器：spawn SDK bundled 的 Claude Code 原生 CLI（claude plugin install/enable/…）。
// 复刻 @anthropic-ai/claude-agent-sdk 内部的平台包解析（sdk.mjs 未导出该路径），
// 让「安装插件」与「运行任务」一样不依赖用户预装的 claude CLI。
// 环境仅白名单透传 + CLAUDE_CONFIG_DIR：插件装到 bridge 解析的配置目录（managed 模式与 ~/.claude 隔离）
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { listInstalledPlugins } from './plugin-discovery.js';

/** 平台二进制包候选（与 sdk.mjs 解析序一致：linux 优先 musl 变体；win32 带 .exe） */
function cliCandidates(): string[] {
  const { platform, arch } = process;
  const ext = platform === 'win32' ? '.exe' : '';
  const base = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  if (platform === 'linux') return [`${base}-musl/claude`, `${base}/claude`];
  return [`${base}/claude${ext}`];
}

let cachedCliPath: string | null = null;

/**
 * 定位 SDK bundled CLI 可执行文件。找不到抛可读错误——SDK 平台包是 optionalDependencies，
 * 用户若以 --omit=optional / 忽略平台不匹配安装会缺失，此时指引改用完整安装或本机 claude。
 */
export function resolveBundledCliPath(): string {
  if (cachedCliPath) return cachedCliPath;
  const req = createRequire(import.meta.url);
  for (const candidate of cliCandidates()) {
    try {
      const p = req.resolve(candidate);
      cachedCliPath = p;
      return p;
    } catch { /* 试下一个候选 */ }
  }
  throw new Error(
    '未找到 SDK 附带的 claude CLI 可执行文件（@anthropic-ai/claude-agent-sdk 平台二进制包缺失）。'
    + '请完整重装本包（勿用 --omit=optional）；或在可访问 claude CLI 的环境执行插件操作。',
  );
}

export interface PluginCliResult {
  ok: boolean;
  /** stdout 尾部提炼（成功）或 stderr 尾部（失败），供聊天/页面直接展示 */
  text: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 安装含 git clone marketplace，可能较慢

/** 提炼输出尾部（CLI 帮助/清单可能很长，聊天场景只关心结尾结果） */
function tail(text: string, max = 800): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/**
 * 执行 `claude plugin <args…> -y`（-y：非 TTY 环境跳过交互确认）。
 * env 白名单透传：CLI 需要 PATH（git）、Windows 需要 SystemRoot（spawn 系统调用），
 * 其余变量一律不带——杜绝外部 ANTHROPIC_* 凭证把认证带偏到非预期端点。
 */
export function runPluginCli(
  args: string[],
  opts: { claudeConfigDir: string; timeoutMs?: number },
): Promise<PluginCliResult> {
  const cli = resolveBundledCliPath();
  const passThrough: Record<string, string | undefined> = {};
  for (const key of ['PATH', 'SystemRoot', 'windir', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP', 'LANG']) {
    if (process.env[key] !== undefined) passThrough[key] = process.env[key];
  }
  // -y（非 TTY 跳过确认）仅 install 支持（实测其余子命令报 unknown option）
  const fullArgs = ['plugin', ...args, ...(args[0] === 'install' ? ['-y'] : [])];
  return new Promise((resolve) => {
    const child = spawn(cli, fullArgs, {
      env: { ...passThrough, CLAUDE_CONFIG_DIR: opts.claudeConfigDir },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      err += `\n[超时 ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s，已终止]`;
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `无法启动 CLI：${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, text: tail(out) || '完成' });
      else resolve({ ok: false, text: tail(err || out) || `退出码 ${code}` });
    });
  });
}

/** 逐插件更新结果（update-all 汇总展示用） */
export interface PluginUpdateDetail {
  key: string;
  ok: boolean;
  text: string;
}

export interface PluginUpdateAllResult extends PluginCliResult {
  details: PluginUpdateDetail[];
}

/** 单插件 update 的超时：比 install 略紧（通常只拉一个小仓库，不含完整 marketplace clone） */
const UPDATE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * 「全部更新」：先刷新市场索引（marketplace update），再逐个更新已装插件
 * （plugin update name@marketplace）。关键语义：marketplace update 只是拉取市场仓库
 * 最新清单，不会升级已装插件——必须逐个 update 才会把新版本写进 installed_plugins.json。
 * 市场刷新失败不中断后续（插件 update 自身会按需拉取），逐项结果聚合进 text/details。
 */
export async function updateAllPlugins(claudeConfigDir: string): Promise<PluginUpdateAllResult> {
  const lines: string[] = [];
  const details: PluginUpdateDetail[] = [];
  const market = await runPluginCli(['marketplace', 'update'], { claudeConfigDir });
  lines.push(`${market.ok ? '✅' : '❌'} 刷新市场索引${market.ok ? '' : `：${tail(market.text, 300)}`}`);
  const installed = listInstalledPlugins(claudeConfigDir);
  for (const p of installed) {
    const r = await runPluginCli(['update', p.key], { claudeConfigDir, timeoutMs: UPDATE_TIMEOUT_MS });
    details.push({ key: p.key, ok: r.ok, text: r.text });
    lines.push(`${r.ok ? '✅' : '❌'} 更新 ${p.key}${r.ok ? '' : `：${tail(r.text, 300)}`}`);
  }
  if (!installed.length) lines.push('（该目录尚未安装任何插件，仅刷新了市场索引）');
  const allOk = market.ok && details.every((d) => d.ok);
  return { ok: allOk, text: lines.join('\n'), details };
}
