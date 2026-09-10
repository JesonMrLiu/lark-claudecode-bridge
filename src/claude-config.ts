// Claude 配置目录双模式解析与 managed 模式初始化。
// inherit（缺省）= 共享本机 ~/.claude（0.4 起行为：登录态/settings/user MCP/skills 全继承）；
// managed = bridge 自管 ~/.lark-claudecode-bridge/claude/，认证与模型由 config.yaml claude 段
// 全权写入该目录 settings.json——彻底摆脱对本机 claude login 的依赖（一键安装开箱即用）。
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from './config.js';
import type { BridgeConfig, ClaudeConfig } from './types.js';

export const MANAGED_CLAUDE_DIR = join(CONFIG_DIR, 'claude');
/** 本机默认 ~/.claude（inherit 模式生效目录；managed 模式下作为插件第二来源目录） */
export const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');

/** 双模式目录解析：managed → bridge 自管目录；其余（含缺省）→ 共享 ~/.claude */
export function resolveClaudeDir(config: BridgeConfig): string {
  return config.claude?.mode === 'managed' ? MANAGED_CLAUDE_DIR : DEFAULT_CLAUDE_DIR;
}

/** 领土键清单：managed 模式下由 config.yaml claude 段认证/模型字段全权决定，不从任何 env 配置并入 */
const TERRITORY_ENV_KEYS = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);

/**
 * managed 目录 settings.json 构建（纯函数）：
 * 现有内容整体保留（enabledPlugins / 用户或 CLI 写入的其余键），仅重写 bridge 领土键——
 * env.ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL 与顶层 model。
 * config.yaml 的 claude 段是这几个键的唯一事实源：字段清空 = 删除对应键。
 * env 块非领土键的合并优先级（低→高）：托管目录既有值 → userEnv（本机 ~/.claude
 * settings env 自动继承，已剔除领土键）→ configEnv（claude.env 显式配置）。
 * 两处入口都过滤领土键：认证与模型由 config 认证字段全权决定，清空即删除的语义
 * 不能被本机值或 env 配置绕过。
 */
export function buildManagedSettings(
  existing: unknown,
  claude: ClaudeConfig,
  userEnv?: Record<string, string>,
  configEnv?: Record<string, string>,
): Record<string, unknown> {
  const doc = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {};
  const envSrc = doc.env && typeof doc.env === 'object' && !Array.isArray(doc.env)
    ? { ...(doc.env as Record<string, unknown>) }
    : {};
  const mergeNonTerritory = (src?: Record<string, string>): void => {
    if (!src) return;
    for (const [k, v] of Object.entries(src)) {
      if (TERRITORY_ENV_KEYS.has(k) || typeof v !== 'string' || !v) continue;
      envSrc[k] = v;
    }
  };
  mergeNonTerritory(userEnv);
  mergeNonTerritory(configEnv);
  const setEnv = (key: string, v: string | undefined): void => {
    if (v) envSrc[key] = v;
    else delete envSrc[key];
  };
  setEnv('ANTHROPIC_AUTH_TOKEN', claude.authToken);
  setEnv('ANTHROPIC_API_KEY', claude.apiKey);
  setEnv('ANTHROPIC_BASE_URL', claude.baseUrl);
  setEnv('ANTHROPIC_MODEL', claude.model);
  if (Object.keys(envSrc).length > 0) doc.env = envSrc;
  else delete doc.env;
  if (claude.model) doc.model = claude.model;
  else delete doc.model;
  return doc;
}

/** 领土键清单：managed 模式下由 config.yaml claude 段全权决定，不从用户 settings.json 并入 */

/** 读本机 ~/.claude/settings.json 的 env 块（剔除领土键）；读取失败/不存在返回 undefined */
function readUserSettingsEnv(userClaudeDir: string): Record<string, string> | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(userClaudeDir, 'settings.json'), 'utf8'));
    const env = raw?.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;
    const picked: Record<string, string> = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (!TERRITORY_ENV_KEYS.has(k) && typeof v === 'string' && v) picked[k] = v;
    }
    return Object.keys(picked).length > 0 ? picked : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 同步本机 ~/.claude.json 的 mcpServers 到 managed 目录 .claude.json（单向：本机 → 自管）。
 * CLI 的全局 MCP 读 $CLAUDE_CONFIG_DIR/.claude.json，managed 模式下自管目录没有这份配置，
 * 用户的全局 MCP server 会全体消失。仅整体搬运 mcpServers 键，其余键（pluginUsage 等
 * CLI 运行时状态）不动；本机无 mcpServers 时 no-op（不清空自管侧）。
 */
function syncMcpServers(managedDir: string, userClaudeDir: string): void {
  let mcpServers: unknown;
  try {
    const raw = JSON.parse(readFileSync(join(userClaudeDir, '..', '.claude.json'), 'utf8'));
    if (raw?.mcpServers && typeof raw.mcpServers === 'object') mcpServers = raw.mcpServers;
  } catch {
    return; // 本机无 .claude.json（未用过 claude login）：no-op
  }
  if (!mcpServers) return;
  const target = join(managedDir, '.claude.json');
  let doc: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(target, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) doc = raw;
  } catch { /* 损坏按全新处理 */ }
  doc.mcpServers = mcpServers;
  writeAtomicJson(target, doc);
}

/** 原子写 JSON（tmp + rename）：读-改-写窗口内崩溃不留半截文件 */
function writeAtomicJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * managed 模式下把本机 ~/.claude/skills 桥接到托管目录的 skills/，让托管会话看到
 * user 范围的 skills（否则 ~/.claude/skills/* 永远不可见——因为 Claude Code 只从
 * $CLAUDE_CONFIG_DIR/skills 发现 user skills，managed 模式 CLAUDE_CONFIG_DIR 不再
 * 指向 ~/.claude）。每个 skill 在托管目录下用目录链接（Windows junction / POSIX
 * symlink）挂到真实位置——skill 更新在原处落地，链接侧无感。
 * 返回 bridged 名单供日志；同名已存在（非 symlink）时报错并跳过（用户已托管自定义
 * 副本，勿覆盖）。
 */
export function bridgeUserSkills(managedDir: string, userClaudeDir: string): string[] {
  const userSkills = join(userClaudeDir, 'skills');
  if (resolve(managedDir) === resolve(userClaudeDir)) return [];
  if (!existsSync(userSkills)) return [];
  const targetDir = join(managedDir, 'skills');
  mkdirSync(targetDir, { recursive: true });
  const bridged: string[] = [];
  for (const name of readdirSyncSafe(userSkills)) {
    const src = join(userSkills, name);
    if (!existsSync(join(src, 'SKILL.md'))) continue; // 非 skill 目录（散文件）跳过
    const dst = join(targetDir, name);
    // lstat 不跟随链接：能识别「源已被删除的失效链接」（existsSync 会误判为不存在）
    let dstLstat: ReturnType<typeof lstatSync> | undefined;
    try { dstLstat = lstatSync(dst); } catch { /* 不存在 */ }
    if (dstLstat) {
      if (dstLstat.isSymbolicLink()) {
        if (existsSync(dst)) continue; // 链接有效，幂等
        // 源已删除的失效链接：移除后重建（junction 删除不影响源目录）
        try { rmSync(dst, { force: true }); } catch { /* 移除失败则按占用跳过 */ continue; }
      } else {
        console.warn(`[managed] skills/${name} 在托管目录已存在且非链接，跳过桥接（若想刷新请手动删除）`);
        continue;
      }
    }
    try {
      symlinkSync(resolve(src), dst, 'junction'); // Windows 上无需管理员权限
      bridged.push(name);
    } catch (e) {
      // 单个 skill 桥接失败（权限/跨盘符等）不阻断启动：其余 skill 照常桥接
      console.warn(`[managed] skills/${name} 桥接失败：`, e instanceof Error ? e.message : e);
    }
  }
  return bridged;
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); }
  catch { return []; }
}

/**
 * managed 模式初始化：建目录 + 把 claude 段最新值合并进 settings.json，
 * 并从本机 ~/.claude 继承 MCP servers（.claude.json mcpServers）、自定义环境变量
 * （settings.json env 块，领土键除外）与 user skills（junction 桥接）——否则托管
 * 会话读不到用户全局 MCP 及其依赖变量、看不到 ~/.claude/skills 下的 skill
 * （典型表现：飞书斜杠命令 /<skill-name> 透传给 CLI 后报 Unknown command）。
 * lcb start 启动 bridge 前调用，保证首条消息前认证/环境就位；非 managed 模式为 no-op。
 */
export function initManagedClaudeDir(config: BridgeConfig, userClaudeDir: string = DEFAULT_CLAUDE_DIR): void {
  if (config.claude?.mode !== 'managed') return;
  mkdirSync(MANAGED_CLAUDE_DIR, { recursive: true });
  const settingsPath = join(MANAGED_CLAUDE_DIR, 'settings.json');
  let existing: unknown;
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      existing = undefined; // 现有文件损坏：按全新处理（rename 原子覆盖）
    }
  }
  writeAtomicJson(settingsPath, buildManagedSettings(
    existing,
    config.claude,
    readUserSettingsEnv(userClaudeDir),
    config.claude.env,
  ));
  syncMcpServers(MANAGED_CLAUDE_DIR, userClaudeDir);
  const bridged = bridgeUserSkills(MANAGED_CLAUDE_DIR, userClaudeDir);
  if (bridged.length > 0) {
    console.log(`[managed] 已桥接 user skills 到托管目录：${bridged.join('、')}（${bridged.length} 个）`);
  }
}
