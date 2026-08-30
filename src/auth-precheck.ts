// 认证预检：启动时对每个 app 检查 Claude Code 子进程是否有可用认证来源，
// 全部落空则 warn 指引（bridge 不介入鉴权，真判定在 CLI 侧，这里只提示配置去向）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 环境变量里是否带 API 凭证：ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 任一非空即可 */
function hasEnvAuth(appEnv: Record<string, string | undefined>): boolean {
  return Boolean(appEnv.ANTHROPIC_AUTH_TOKEN?.trim() || appEnv.ANTHROPIC_API_KEY?.trim());
}

/** 配置目录的 settings.json 是否声明了认证（env 块 token 或 apiKeyHelper）；文件缺失/解析失败视为无认证 */
function hasSettingsAuth(claudeConfigDir: string): boolean {
  const p = join(claudeConfigDir, 'settings.json');
  if (!existsSync(p)) return false;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as {
      env?: Record<string, unknown>;
      apiKeyHelper?: unknown;
    };
    const env = doc.env ?? {};
    return Boolean(
      (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.trim())
      || (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim())
      || (typeof doc.apiKeyHelper === 'string' && doc.apiKeyHelper.trim()),
    );
  } catch {
    return false;
  }
}

/**
 * 检查单个 app 的 Claude Code 认证来源（与 CLI 侧判定顺序一致）：
 * 环境变量（进程透传或 apps[].env）→ 配置目录 OAuth 凭证 → 配置目录 settings.json 认证声明。
 */
export function hasClaudeAuth(appEnv: Record<string, string | undefined>, claudeConfigDir: string): boolean {
  return hasEnvAuth(appEnv)
    || existsSync(join(claudeConfigDir, '.credentials.json'))
    || hasSettingsAuth(claudeConfigDir);
}

/** 启动预检：无任何认证来源时 warn 三条出路；返回是否存在认证（测试断言用） */
export function warnIfNoClaudeAuth(
  appName: string,
  appEnv: Record<string, string | undefined>,
  claudeConfigDir: string,
): boolean {
  if (hasClaudeAuth(appEnv, claudeConfigDir)) return true;
  console.warn(
    `[app:${appName}] [配置] 未检测到 Claude Code 认证来源：环境变量无 ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY，`
    + `且 ${claudeConfigDir} 下无 .credentials.json，settings.json 也未声明认证。`
    + `发消息将报「Not logged in · Please run /login」。三选一修复：`
    + `① config.yaml 该 app 的 env 配置 ANTHROPIC_AUTH_TOKEN（第三方端点另配 ANTHROPIC_BASE_URL）；`
    + `② 该 app 的 claude_config_dir 指向已登录的目录（如 ~/.claude）；`
    + `③ 在该目录登录一次：CLAUDE_CONFIG_DIR=${claudeConfigDir} claude login`,
  );
  return false;
}
