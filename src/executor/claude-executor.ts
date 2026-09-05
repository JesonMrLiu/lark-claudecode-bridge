// Claude 执行器：封装 Agent SDK 的 query()，把流消息转成进度事件并收集产出
// 注意：不覆盖/清理任何 ANTHROPIC_* 环境变量，凭证与代理配置透传 process.env
import { query, type McpServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { OutputCollector } from './output-collector.js';
import type { ProgressEvent, SessionInventory, TaskOutcome } from '../types.js';

export interface ExecutorCallbacks {
  onProgress(event: ProgressEvent): Promise<void> | void;
  /** SDK init(system/init) 消息到达时回调（每 query 仅一次）；提取本会话实际加载的模型/技能/插件/MCP 清单 */
  onInit?(inventory: Omit<SessionInventory, 'workspace' | 'loadedAt'>): void;
}

/** canUseTool 第三参（SDK 原样透传的子集）：suggestions 为 CLI 建议的权限更新（如 ExitPlanMode 后 setMode acceptEdits） */
export interface CanUseToolContext {
  suggestions?: unknown[];
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
  /** SDK 权限模式：code-dev 工作区传 'plan'（先出计划 → 飞书卡片批准后切 acceptEdits），缺省 'default' */
  permissionMode?: 'default' | 'plan';
  // 收窄签名：SDK 的 CanUseTool 返回值还支持 updatedPermissions 等，此处暴露宿主需要的子集。
  // deny 分支 message 必填，与 SDK PermissionResult 判别联合结构兼容，可直接透传；
  // allow 分支可带 updatedInput（AskUserQuestion 的用户答案经此回传 CLI）
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    ctx?: CanUseToolContext,
  ) => Promise<
    { behavior: 'allow'; message?: string; updatedInput?: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  >;
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
  // collector 按 cwd 过滤：只收集工作区内文件（plan mode 的计划文件写在 ~/.claude/plans/
  // 等工作区外路径，不属于「本次修改/新增的文件」，不应进入收尾清单与文件追踪）
  const collector = new OutputCollector(opts.cwd);
  // Streaming Input（官方推荐姿势）：prompt 经 AsyncGenerator 送入，yield 一条用户消息后挂起不结束——
  // stdin 在整个会话期间保持打开。字符串 prompt 的单轮模式在收到第一条 result 后即关 stdin
  // （SDK isSingleUserTurn 行为，agent-sdk#384），plan mode 下 ExitPlanMode/AskUserQuestion 这类
  // 轮次边界的权限请求落在 result 之后，CLI 侧 inputClosed 后全部报 "Stream closed" 中断审批流
  async function* inputStream(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };
    await new Promise<never>(() => {}); // 永不自然结束：由消费端收到最终 result 后 break 收尾
  }
  let resultErrorText = '';
  const q: Query = query({
    prompt: inputStream(),
    options: {
      cwd: opts.cwd,
      settingSources: ['user', 'project'],
      permissionMode: opts.permissionMode ?? 'default',
      includePartialMessages: false,
      ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
      ...(opts.canUseTool
        ? {
          canUseTool: async (
            toolName: string,
            input: Record<string, unknown>,
            ctx?: { suggestions?: unknown[] },
          ) => {
            const decision = await opts.canUseTool!(toolName, input, { suggestions: ctx?.suggestions });
            // 计划批准即授权写操作：对齐 Claude Code CLI「plan 批准 → accept edits on」语义，
            // 后续 Write/Edit 不再逐次弹确认卡（SDK Query.setPermissionMode，官方 permissions 文档姿势）
            if (decision.behavior === 'allow' && toolName === 'ExitPlanMode') {
              await q.setPermissionMode('acceptEdits').catch((e) => {
                console.warn('[executor] setPermissionMode(acceptEdits) 失败（继续按批准前模式执行）:', e instanceof Error ? e.message : e);
              });
            }
            return decision;
          },
        }
        : {}),
      ...(opts.signal ? { abortController: bridgeSignal(opts.signal) } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.plugins ? { plugins: opts.plugins.map((p) => ({ type: 'local' as const, path: p.path })) } : {}),
    },
  });
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
        // 非成功终态（error_during_execution / error_max_turns 等，错误文本在 errors 数组）：
        // 带出循环后统一抛出，消息格式与单轮模式 SDK throw 保持一致（index.ts catch 的 hint 依赖该格式）
        else if (message.subtype.startsWith('error')) resultErrorText = message.errors?.join('\n') || message.subtype;
        if ('session_id' in message && typeof message.session_id === 'string') sessionId = message.session_id;
        // 最终 result 到手即主动结束：break 触发 q.return() → SDK 清理输入流与子进程
        //（streaming 输入永不自终，不 break 任务会一直挂起）
        if (message.subtype === 'success' || message.subtype.startsWith('error')) return finalize();
        break;
      }
    }
  }
  return finalize();

  function finalize(): TaskOutcome {
    if (resultErrorText) {
      // 携带 sessionId 抛出：wiring 侧据此把出错任务的会话也归档进 /resume 历史
      //（错误任务的会话上下文同样有价值；早期不归档导致历史列表难积累）
      const err = new Error(`Claude Code returned an error result: ${resultErrorText}`) as Error & { sessionId?: string };
      err.sessionId = sessionId || undefined;
      throw err;
    }
    return { sessionId, finalText, producedFiles: collector.files(), turns, ...(inventory ? { inventory } : {}) };
  }
}
