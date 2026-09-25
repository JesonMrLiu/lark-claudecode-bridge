// Claude 执行器：封装 Agent SDK 的 query()，把流消息转成进度事件并收集产出
// 注意：不覆盖/清理任何 ANTHROPIC_* 环境变量，凭证与代理配置透传 process.env
import { query, type McpServerConfig, type McpServerStatus, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { OutputCollector } from './output-collector.js';
import type { ProgressEvent, SessionInventory, TaskOutcome, TaskUsage } from '../types.js';

export interface ExecutorCallbacks {
  onProgress(event: ProgressEvent): Promise<void> | void;
  /** SDK init(system/init) 消息到达时回调（每 query 仅一次）；提取本会话实际加载的模型/技能/插件/MCP 清单 */
  onInit?(inventory: Omit<SessionInventory, 'workspace' | 'loadedAt'>): void;
  /** MCP server 真实连接状态（任务收尾时经 Query.mcpServerStatus() 拉取一次）。init 快照必为 pending——
   *  此回调是 /mcp 命令在任务空闲期显示 connected/failed 的唯一数据源 */
  onMcpStatus?(servers: McpServerStatus[]): void;
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
  /** SDK 权限模式：通道 /plan 开启时传 'plan'（先出计划 → 飞书卡片批准后切 acceptEdits），缺省 'default' */
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
  /** 额外 CLI 参数（键不带 -- 前缀），直通 SDK Options.extraArgs。
   *  当前唯一用途：机器人级厂商档案的认证 settings 文件（--settings <path>）——
   *  命令行层 env 优先级最高，不被生效目录 settings.json 的 env 块压制（Step 0 实测） */
  extraArgs?: Record<string, string | null>;
  /** 技能白名单（分身机器人）：非空时透传 SDK Options.skills——未列出的技能对模型不可见
   *  且被 Skill 工具拒绝（官方语义为「上下文过滤器非沙箱」）；缺省不传 = CLI 默认全量技能 */
  allowedSkills?: string[];
  /** query 创建后回调：暴露 mcpServerStatus 窄句柄（wiring 存入 activeQueries，/mcp 命令实时拉取用）。
   *  句柄仅在该 query 存活期间有效，任务结束后调用会 reject——调用方须自行 catch */
  onQuery?(handle: { mcpServerStatus(): Promise<McpServerStatus[]> }): void;
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

/** tool_result 失败内容的首行文本（兼容 string / blocks 数组形态）：进度卡 ✘ 行的失败原因 */
function firstErrorLine(content: unknown): string | undefined {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (b && typeof b === 'object' && 'text' in b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join(' ');
  }
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 80) : undefined;
}

/** 等待后台任务期间的静默超时：超时仍无任何事件（CLI 异常/卡死）按已有信息收尾，防任务永久挂起。
 *  正常路径无须走到——后台任务完成会唤醒主循环产生新事件，最终由 result/idle 信号收尾 */
const BG_WAIT_SILENCE_TIMEOUT_MS = 15 * 60 * 1000;

export async function runTask(prompt: string, opts: RunTaskOptions, cb: ExecutorCallbacks): Promise<TaskOutcome> {
  // collector 按 cwd 过滤：只收集工作区内文件（plan mode 的计划文件写在 ~/.claude/plans/
  // 等工作区外路径，不属于「本次修改/新增的文件」，不应进入收尾清单与文件追踪）
  const collector = new OutputCollector(opts.cwd);
  // Streaming Input（官方推荐姿势）：prompt 经 AsyncGenerator 送入，yield 一条用户消息后挂起不结束——
  // stdin 在整个会话期间保持打开。字符串 prompt 的单轮模式在收到第一条 result 后即关 stdin
  //（SDK isSingleUserTurn 行为，agent-sdk#384），plan mode 下 ExitPlanMode/AskUserQuestion 这类
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
      // 转发子代理 text 块（默认只转发 tool_use/tool_result 心跳）——配合 parent_tool_use_id
      // 区分主/子代理输出，飞书进度卡能看到子代理在做什么
      forwardSubagentText: true,
      // 分身技能白名单（RunTaskOptions.allowedSkills → Options.skills）：未列出技能对模型
      // 不可见且被 Skill 工具拒绝；缺省不传 = CLI 默认全量（主机器人行为不变）
      ...(opts.allowedSkills?.length ? { skills: opts.allowedSkills } : {}),
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
      ...(opts.extraArgs && Object.keys(opts.extraArgs).length ? { extraArgs: opts.extraArgs } : {}),
    },
  });
  let finalText = '';
  let sessionId = opts.resumeSessionId ?? '';
  let turns = 0;
  // 最后一次 result 的主循环用量：input+cache 三项之和 ≈ 当前上下文规模（超长提醒判定口径）。
  // streaming 模式下每个 result 携带最近 turn 的用量，取最新值即可（不累加）
  let usage: TaskUsage | undefined;
  // 后台任务在途集合（background_tasks_changed 为 level 信号，整组替换；ambient 杂务任务不计）。
  // 主 turn result 到达时集合非空 → 不收尾挂起等待：进程一退后台子代理就被连带杀掉，
  // 永远等不到完成通知——后台任务完成会唤醒 CLI 主循环自动续跑，新事件继续流出直到真正收尾
  const bgTasks = new Map<string, { taskType: string; description: string }>();
  // 主 turn 终态已到但仍在等后台任务（true 期间静默超时看门狗生效）
  let waitingBg = false;
  let lastEventAt = Date.now();
  // init 消息提取的会话清单（每 query 一次）；数组字段全部 ?? [] 兜底——SDK 升级字段改名时清单为空但不崩
  let inventory: Omit<SessionInventory, 'workspace' | 'loadedAt'> | undefined;
  const toolNames = new Map<string, string>(); // tool_use_id → 工具名（tool_result 块本身不带 name）
  opts.onQuery?.(q);
  // 等待后台任务期间的静默看门狗：pending 期间长时间无任何事件则按已有信息收尾。
  // 经 q.return() 结束 for await（与收到 result 主动 return 走同一条清理路径）
  const silenceWatch = setInterval(() => {
    if (waitingBg && Date.now() - lastEventAt > BG_WAIT_SILENCE_TIMEOUT_MS) {
      console.warn(`[executor] 等待后台任务静默超 ${Math.round(BG_WAIT_SILENCE_TIMEOUT_MS / 60000)} 分钟无事件，按已有结果收尾（后台任务: ${[...bgTasks.values()].map((t) => t.description).join(' / ')}）`);
      void q.return(undefined).catch(() => { /* 进程已退等场景：忽略，外层自会收尾 */ });
    }
  }, 30_000);
  silenceWatch.unref?.();
  // 收尾（含 MCP 真实连接状态拉取）：result 即收尾与 idle 权威收尾两条路径共用
  const finalizeWithMcpPoll = async (): Promise<TaskOutcome> => {
    // 收尾前拉一次 MCP 真实连接状态（init 快照必为 pending，这是空闲期 /mcp 的数据源）；
    // try/catch 同时兜住同步异常（旧 mock/异常环境下方法缺失）与异步拒绝，绝不阻断收尾
    try {
      const statuses = await q.mcpServerStatus();
      cb.onMcpStatus?.(statuses);
    } catch { /* 拉取失败：保留 init 快照 */ }
    return finalize();
  };
  try {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      lastEventAt = Date.now();
      switch (message.type) {
        case 'system': {
          if (message.subtype === 'init') {
            // init 即携带 session_id：全新会话在首轮 turn 结束前被 /stop 中止时不会有 result 消息，
            // 不在此捕获则 sessionId 恒为空串 → catch 挂不上 err.sessionId → 归档 no-op，
            // 会话指针停留 null，用户随后「继续」会开全新会话丢失上下文（resume 场景两值等价）
            if (typeof message.session_id === 'string' && message.session_id) sessionId = message.session_id;
            inventory = {
              model: message.model,
              claudeCodeVersion: message.claude_code_version,
              // 顶层已注册工具清单（dynamic tool loading 下核心工具在顶层、其余经 ToolSearch 按需加载，
              // ToolSearch 索引不到顶层工具）：/status 展示与「工具不存在」误判诊断的数据源
              tools: message.tools ?? [],
              skills: message.skills ?? [],
              slashCommands: message.slash_commands ?? [],
              plugins: (message.plugins ?? []).map((p) => ({ name: p.name, path: p.path, version: p.version })),
              mcpServers: message.mcp_servers ?? [],
              agents: message.agents ?? [],
            };
            cb.onInit?.(inventory);
          } else if (message.subtype === 'status') {
            // CLI 状态心跳（requesting=等模型响应 / compacting=上下文压缩 / null=空闲）：刷新进度卡
            // 状态行——includePartialMessages=false 下长 API 轮次没有任何其他事件，避免「只有计时在走」的黑盒感
            await cb.onProgress({
              kind: 'status',
              content: message.status === 'requesting' ? '🌐 等待模型响应…'
                : message.status === 'compacting' ? '🗜️ 上下文压缩中…'
                : '🔄 运行中',
            });
          } else if (message.subtype === 'background_tasks_changed') {
            // 后台任务在途清单（level 信号）：整组替换语义。ambient=true 的杂务任务
            // （live-update watcher 等）不算用户可见工作，不计数避免状态行虚高
            bgTasks.clear();
            for (const t of message.tasks) {
              if (!t.ambient) bgTasks.set(t.task_id, { taskType: t.task_type, description: t.description });
            }
            if (waitingBg && bgTasks.size > 0) {
              await cb.onProgress({ kind: 'status', content: `⏳ 等待 ${bgTasks.size} 个后台任务完成…` });
            }
          } else if (message.subtype === 'session_state_changed' && message.state === 'idle') {
            // 权威 turn-over 信号：idle 在 heldBackResult flush 且后台任务续跑循环退出后触发。
            // 主 turn result 已到 + 后台任务全部结束 → 真正收尾（后台任务若再唤醒主循环，
            // 会先收到新的 assistant/result 事件并覆盖 finalText，idle 仍在最后）
            if (waitingBg && bgTasks.size === 0) {
              return await finalizeWithMcpPoll();
            }
          } else if (message.subtype === 'task_started') {
            const tag = message.subagent_type ? ` [${message.subagent_type}]` : '';
            await cb.onProgress({
              kind: 'status',
              content: `${message.is_backgrounded ? '🤖 后台子代理启动' : '🤖 子代理启动'}${tag}: ${message.description}`,
            });
            // 子代理清单：进度卡独立区块展示每个子代理的运行状态（对齐 CLI 的 agent 进度显示）
            await cb.onProgress({
              kind: 'agent-start',
              agent: { id: message.task_id, description: message.description, type: message.subagent_type ?? 'task' },
            });
          } else if (message.subtype === 'task_notification') {
            // 后台任务落定（completed/failed/stopped）：summary 为任务自述结论。
            // status 会原文渲染进进度卡正文并随每次卡片更新发送——子代理完整报告可达
            // 上万字符，截断保留结论摘要（全文另有 agent 清单与 transcript 承载）
            const label = message.status === 'completed' ? '✅ 后台任务完成' : message.status === 'failed' ? '❌ 后台任务失败' : '🛑 后台任务已停止';
            await cb.onProgress({ kind: 'status', content: `${label}: ${(message.summary ?? '').slice(0, 300)}` });
            await cb.onProgress({
              kind: 'agent-settle',
              id: message.task_id,
              status: message.status === 'completed' ? 'done' : message.status === 'failed' ? 'failed' : 'stopped',
              ...(message.summary ? { summary: message.summary } : {}),
            });
          }
          break;
        }
        case 'assistant': {
          // turns 只计主循环轮次：子代理消息（parent_tool_use_id 非空）混入会把单任务轮数
          // 放大数倍（旧超长提醒误报的帮凶），兜底口径应以主循环为准
          if (!message.parent_tool_use_id) turns++;
          for (const block of message.message.content) {
            if (block.type === 'text') {
              // 子代理文本加标识前缀（forwardSubagentText 转发），与主 Agent 输出在进度卡上区分
              const prefix = message.parent_tool_use_id ? '🤖 ' : '';
              await cb.onProgress({ kind: 'text', content: `${prefix}${block.text}` });
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
              const note = block.is_error ? firstErrorLine(block.content) : undefined;
              await cb.onProgress({ kind: 'tool-result', content: name, ok: !block.is_error, ...(note ? { note } : {}) });
            }
          }
          break;
        }
        case 'result': {
          if (message.subtype === 'success') finalText = message.result;
          // 非成功终态（error_during_execution / error_max_turns 等，错误文本在 errors 数组）：
          // 带出循环后统一抛出，消息格式与单轮模式 SDK throw 保持一致（index.ts catch 的 hint 依赖该格式）
          else if (message.subtype.startsWith('error')) resultErrorText = message.errors?.join('\n') || message.subtype;
          // usage 提取（error result 可能缺字段，全部兜 0 不抛）
          const u = (message as { usage?: Partial<Record<'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens', number>> }).usage;
          if (u) {
            usage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
            };
          }
          if ('session_id' in message && typeof message.session_id === 'string') sessionId = message.session_id;
          // 主 turn 终态。后台任务仍在跑时不收尾：return 会触发 q.return() → SDK 清理子进程，
          // 后台子代理被连带杀掉、完成通知永远收不到（旧版「主代理结束、子代理无声消失」根因）。
          // 挂起继续 for await：后台任务完成会唤醒 CLI 主循环自动续跑（新的 assistant/result
          // 事件照常流出，飞书端继续收到推送），直到 session_state_changed(idle) 或续跑 turn 的
          // result 在 bgTasks 清空后到达才真正收尾。bgTasks 为空 = 无在途任务，维持旧行为立即收尾
          //（CLI 不发 background_tasks_changed 事件时自然退化，不会比旧版更差）
          if (message.subtype === 'success' || message.subtype.startsWith('error')) {
            if (bgTasks.size > 0) {
              waitingBg = true;
              await cb.onProgress({ kind: 'status', content: `⏳ 主线回复完成，等待 ${bgTasks.size} 个后台任务…` });
              break;
            }
            return await finalizeWithMcpPoll();
          }
          break;
        }
      }
    }
  } catch (e) {
    // 流错误（/stop 的 AbortError、Stream closed 等）：把已知的 sessionId 挂到错误对象再抛——
    // wiring 侧据此把中止/出错任务的会话也归档进 /resume 历史（AbortError 自身不携带
    // sessionId；不改动原 message，index.ts catch 的 hint 匹配不受影响）
    const err = e instanceof Error ? e : new Error(String(e));
    if (sessionId && !(err as Error & { sessionId?: string }).sessionId) {
      (err as Error & { sessionId?: string }).sessionId = sessionId;
    }
    throw err;
  } finally {
    clearInterval(silenceWatch);
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
    return { sessionId, finalText, producedFiles: collector.files(), turns, ...(usage ? { usage } : {}), ...(inventory ? { inventory } : {}) };
  }
}
