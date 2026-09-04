// Claude 配置目录双模式解析与 managed 模式初始化。
// inherit（缺省）= 共享本机 ~/.claude（0.4 起行为：登录态/settings/user MCP/skills 全继承）；
// managed = bridge 自管 ~/.lark-claudecode-bridge/claude/，认证与模型由 config.yaml claude 段
// 全权写入该目录 settings.json——彻底摆脱对本机 claude login 的依赖（一键安装开箱即用）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';
import type { BridgeConfig, ClaudeConfig } from './types.js';

export const MANAGED_CLAUDE_DIR = join(CONFIG_DIR, 'claude');
/** 本机默认 ~/.claude（inherit 模式生效目录；managed 模式下作为插件第二来源目录） */
export const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');

/** 双模式目录解析：managed → bridge 自管目录；其余（含缺省）→ 共享 ~/.claude */
export function resolveClaudeDir(config: BridgeConfig): string {
  return config.claude?.mode === 'managed' ? MANAGED_CLAUDE_DIR : DEFAULT_CLAUDE_DIR;
}

/**
 * managed 目录 settings.json 构建（纯函数）：
 * 现有内容整体保留（enabledPlugins / 用户或 CLI 写入的其余键），仅重写 bridge 领土键——
 * env.ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL 与顶层 model。
 * config.yaml 的 claude 段是这几个键的唯一事实源：字段清空 = 删除对应键。
 * env 块中非领土键（如有）原样保留。
 */
export function buildManagedSettings(existing: unknown, claude: ClaudeConfig): Record<string, unknown> {
  const doc = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {};
  const envSrc = doc.env && typeof doc.env === 'object' && !Array.isArray(doc.env)
    ? { ...(doc.env as Record<string, unknown>) }
    : {};
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

/** 原子写 JSON（tmp + rename）：读-改-写窗口内崩溃不留半截文件 */
function writeAtomicJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * managed 模式初始化：建目录 + 把 claude 段最新值合并进 settings.json。
 * lcb start 启动 bridge 前调用，保证首条消息前认证就位；非 managed 模式为 no-op。
 */
export function initManagedClaudeDir(config: BridgeConfig): void {
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
  writeAtomicJson(settingsPath, buildManagedSettings(existing, config.claude));
}
