// 每任务构造 Claude Code 子进程 env（纯函数，exported 便于单测）。
// 热生效语义：apps[].env 与 claude.env 每任务现读最新 config——改盘/配置页保存后
// 下一条消息即生效，消灭「改 env 必须重启」（1.0.x 前 appEnv 在 createBridge 定稿的坑）。
// 优先级（低→高）：process.env < CLAUDE_CONFIG_DIR(启动定稿) < claude.env(过滤领土键) < apps[].env。
// 领土键过滤与 buildManagedSettings 的 TERRITORY_ENV_KEYS 同源：认证四键不允许多源，
// claude.env 里配认证键无效（永远以认证表单/本机 settings 为准）；app.env 不过滤（历史语义保留）。
// 注意：生效目录 settings.json 的 env 块由 CLI 自行应用且优先级更高（README 已知限制）——
// 同名键以 settings.json 为准，此处注入适合放 settings.json 里没有的键（如 MCP 工具依赖的 LARK_APP_ID）。
import { TERRITORY_ENV_KEYS } from './claude-config.js';
import type { BridgeConfig, FeishuAppConfig } from './types.js';

export function buildTaskEnv(
  config: BridgeConfig,
  app: FeishuAppConfig,
  /** 启动时 resolveClaudeDir 定稿；mode 变更仍需重启（保持现状） */
  claudeDir: string,
): Record<string, string | undefined> {
  const claudeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.claude?.env ?? {})) {
    if (!TERRITORY_ENV_KEYS.has(k)) claudeEnv[k] = v;
  }
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeDir,
    ...claudeEnv,
    ...app.env,
  };
}
