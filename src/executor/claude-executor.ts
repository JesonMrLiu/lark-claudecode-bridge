// Claude 执行器：封装 Agent SDK 的 query()，把流消息转成进度事件并收集产出
// 注意：不覆盖/清理任何 ANTHROPIC_* 环境变量，凭证与代理配置透传 process.env
import { query, type McpServerConfig, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { OutputCollector } from './output-collector.js';
import type { ProgressEvent, SessionInventory, TaskOutcome } from '../types.js';

export interface ExecutorCallbacks {
  onProgress(event: ProgressEvent): Promise<void> | void;
  /** SDK init(system/init) 消息到达时回调（每 query 仅一次）；提取本会话实际加载的模型/技能/插件/MCP 清单 */
  onInit?(inventory: Omit<SessionInventory, 'workspace' | 'loadedAt'>): void;
}

export interface RunTaskOptions {
  cwd: string;
  resumeSessionId?: string;
  signal?: AbortSignal;
  /** per-app 环境变量：至少含 CLAUDE_CONFIG_DIR（~/.claude，全部机器人共享）；可追加 settings.json 里没有的键 */
  env?: Record<string, string | undefined>;
  /** per-app 人格补充，直通 SDK appendSystemPrompt */
  appendSystemPrompt?: string;
  /** 通道级模型覆盖（/model 命令设置），直通 Options.model；未设 = 跟随 ~/.claude/settings.json 的 model */
  model?: string;
  // 收窄签名：SDK 的 CanUseTool 还带第三参 options（signal/suggestions 等），此处仅暴露 (toolName, input)。
  // deny 分支 message 必填，与 SDK PermissionResult 判别联合结构兼容，可直接透传
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ behavior: 'allow'; message?: string } | { behavior: 'deny'; message: string }>;
  /** 额外注入的 MCP server（如 lcb-notify 进程内通知工具），直通 Options.mcpServers */
  mcpServers?: Record<string, McpServerConfig>;
  /** 显式加载的本地插件目录（含 .claude-plugin/plugin.json），映射为 SDK 的 {type:'local', path} */
  plugins?: Array<{ path: string }>;
}

// SDK 选项只收 abortController（无 signal 项），把外部 signal 的中止转发给它
function bridgeSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
    return controller;
  }
  signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

function summarizeToolInput(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  return JSON.stringify(input).slice(0, 100);
}

export async function runTask(prompt: string, opts: RunTaskOptions, cb: ExecutorCallbacks): Promise<TaskOutcome> {
  const collector = new OutputCollector();
  const options: Options = {
    cwd: opts.cwd,
    settingSources: ['user', 'project'],
    permissionMode: 'default',
    includePartialMessages: false,
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
    ...(opts.signal ? { abortController: bridgeSignal(opts.signal) } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
    ...(opts.plugins ? { plugins: opts.plugins.map((p) => ({ type: 'local' as const, path: p.path })) } : {}),
  };
  const q = query({ prompt, options });
  let finalText = '';
  let sessionId = opts.resumeSessionId ?? '';
  let turns = 0;
  // init 消息提取的会话清单（每 query 一次）；数组字段全部 ?? [] 兜底——SDK 升级字段改名时清单为空但不崩
  let inventory: Omit<SessionInventory, 'workspace' | 'loadedAt'> | undefined;
  const toolNames = new Map<string, string>(); // tool_use_id → 工具名（tool_result 块本身不带 name）
  for await (const message of q as AsyncIterable<SDKMessage>) {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          inventory = {
            model: message.model,
            claudeCodeVersion: message.claude_code_version,
            skills: message.skills ?? [],
            slashCommands: message.slash_commands ?? [],
            plugins: (message.plugins ?? []).map((p) => ({ name: p.name, path: p.path, version: p.version })),
            mcpServers: message.mcp_servers ?? [],
            agents: message.agents ?? [],
          };
          cb.onInit?.(inventory);
        }
        break;
      }
      case 'assistant': {
        turns++;
        for (const block of message.message.content) {
          if (block.type === 'text') {
            await cb.onProgress({ kind: 'text', content: block.text });
          } else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>;
            toolNames.set(block.id, block.name);
            collector.track(block.name, input);
            await cb.onProgress({ kind: 'tool-start', content: `${block.name}: ${summarizeToolInput(input)}` });
          }
        }
        break;
      }
      case 'user': {
        const content = message.message.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === 'tool_result') {
            const name = toolNames.get(block.tool_use_id) ?? '';
            await cb.onProgress({ kind: 'tool-result', content: name, ok: !block.is_error });
          }
        }
        break;
      }
      case 'result': {
        if (message.subtype === 'success') finalText = message.result;
        if ('session_id' in message && typeof message.session_id === 'string') sessionId = message.session_id;
        break;
      }
    }
  }
  return { sessionId, finalText, producedFiles: collector.files(), turns, ...(inventory ? { inventory } : {}) };
}
