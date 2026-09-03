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
 * 检查认证来源（与 CLI 侧判定顺序一致）：
 * 环境变量（进程透传或 apps[].env）→ ~/.claude OAuth 凭证 → ~/.claude settings.json 认证声明。
 */
export function hasClaudeAuth(appEnv: Record<string, string | undefined>, claudeConfigDir: string): boolean {
  return hasEnvAuth(appEnv)
    || existsSync(join(claudeConfigDir, '.credentials.json'))
    || hasSettingsAuth(claudeConfigDir);
}

/** 启动预检：无任何认证来源时 warn 修复出路（managed 模式指向配置页，inherit 指向 claude login）；返回是否存在认证（测试断言用） */
export function warnIfNoClaudeAuth(
  appName: string,
  appEnv: Record<string, string | undefined>,
  claudeConfigDir: string,
  opts: { managed?: boolean; serverUrl?: string | null } = {},
): boolean {
  if (hasClaudeAuth(appEnv, claudeConfigDir)) return true;
  if (opts.managed) {
    console.warn(
      `[app:${appName}] [配置] 未检测到 Claude Code 认证来源（managed 模式）：config.yaml 的 claude 段未配置 auth_token / api_key。`
      + `发消息将报「Not logged in · Please run /login」。`
      + `修复：${opts.serverUrl ? `打开 ${opts.serverUrl} 在「Claude 认证」区填写（中转站另配 base_url），保存并重启 bridge` : '在 config.yaml 的 claude 段配置 auth_token / api_key 后重启 bridge'}`,
    );
    return false;
  }
  console.warn(
    `[app:${appName}] [配置] 未检测到 Claude Code 认证来源：环境变量无 ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY，`
    + `且 ${claudeConfigDir} 下无 .credentials.json，settings.json 也未声明认证。`
    + `发消息将报「Not logged in · Please run /login」。二选一修复：`
    + `① 在本机终端登录一次 claude login（登录态存于 ~/.claude，所有机器人共享）；`
    + `② 在 ~/.claude/settings.json 的 env 配 ANTHROPIC_AUTH_TOKEN（第三方端点另配 ANTHROPIC_BASE_URL）`,
  );
  return false;
}
