// Claude 执行器：封装 Agent SDK 的 query()，把流消息转成进度事件并收集产出。
// 注意：不覆盖/清理任何 ANTHROPIC_* 环境变量，凭证与代理配置透传 process.env
//
// 生命周期方案 A2——常驻进程池：
// - 进程按 affinityKey（appId:chatId:userId）亲和：同通道消息继续写同一 CLI 子进程的
//   stdin（streaming input 天然多轮），~30s 冷启动税从「每消息一次」摊薄为「每会话一次」；
// - 复用三前提：进程活着 + 配置指纹一致（人设/模型/plan/env/MCP/插件/档案 settings/cwd，
//   任一变化即回收重建——保住「每任务现读热生效」卖点）+ 会话指针一致（/new /resume /ws use
//   换了续接目标，旧进程上下文不再适用）；
// - 每轮软收尾：现有 finalize（发卡/归档/拉 MCP 状态）在每轮 result 后照常执行，但
//   不退出消息循环、不杀进程——「收尾」与「退出」分离是本次重构的核心动作；
// - 崩溃自愈：进程死亡（流结束/抛错）自动出池，下条消息冷启重建 = 退化为旧行为，不会更糟；
// - 空闲回收：通道空闲超阈值杀进程释放内存（会话无损——指针与 transcript 均落盘，
//   追问时冷启 + resume 无缝续上）；池上限按 app 统计，LRU 淘汰最久未用的空闲进程。
// - ephemeral（无 affinityKey 或 resident:false）= spawn 一轮即回收的常驻进程，与旧行为等价。
import { createHash } from 'node:crypto';
import { query, type McpServerConfig, type McpServerStatus, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { OutputCollector } from './output-collector.js';
import type { ProgressEvent, SessionInventory, TaskOutcome, TodoItemStatus, TaskUsage } from '../types.js';

export interface ExecutorCallbacks {
  onProgress(event: ProgressEvent): Promise<void> | void;
  /** SDK init(system/init) 消息到达时回调（每 query 仅一次）；提取本会话实际加载的模型/技能/插件/MCP 清单。
   *  常驻复用轮次没有新 init——executor 回放 spawn 时缓存的清单（指纹保证清单未变） */
  onInit?(inventory: Omit<SessionInventory, 'workspace' | 'loadedAt'>): void;
  /** MCP server 真实连接状态（任务收尾时经 Query.mcpServerStatus() 拉取一次）。init 快照必为 pending——
   *  此回调是 /mcp 命令在任务空闲期显示 connected/failed 的唯一数据源 */
  onMcpStatus?(servers: McpServerStatus[]): void;
}

/**
 * 进度播报内置约束（2026-10-23，每个任务随 --append-system-prompt 注入）：
 * Claude Code 原生事件流没有「中文步骤」概念，进度卡的步骤流水完全依赖 TodoWrite
 * （content=步骤名、activeForm=「正在…」）——不约束则多数任务（尤其小任务）不使用
 * TodoWrite，进度卡只剩工具罗列。此约束让 Claude 主动维护中文步骤流水，进度卡得以
 * 显示「真实处理步骤」；同时约束 AskUserQuestion 的提问质量（背景 + 选项说明）。
 * 与 per-app 人格补充（config apps[].append_system_prompt）合并注入，人格不受影响。
 */
const PROGRESS_SOP = [
  '【任务进度播报约束】',
  '- 接到任务后，先用 TodoWrite 制定执行计划：每个步骤用简短的中文描述（用户视角，如「拉取候选并按热度排序」「生成配图并质检」）。',
  '- 执行中每进入一个新阶段，立即更新 TodoWrite：当前步骤的 activeForm 用「正在…」句式（如「正在生成配图」）；完成的步骤及时标记 completed；一次只有一个步骤处于 in_progress。',
  '- 即使是简单任务，也拆成 2-3 个步骤维护 TodoWrite，让用户能从进度卡看到执行推进。',
  '- 使用 AskUserQuestion 提问时，题干必须写清背景与上下文；每个选项必须填写 description，说明该选项的含义、与其他选项的差异、选择的后果，让用户能据此独立决策。',
].join('\n');

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
  /** per-app 人格补充：经 extraArgs['append-system-prompt'] 以 CLI 命令行参数注入。
   *  不走 SDK options.appendSystemPrompt——实测（方案 §1.2 A/B）该字段被 CLI 2.1.x 静默丢弃
   *  （SDK 经 initialize 控制通道下发，CLI 不消费），命令行参数是唯一生效通道 */
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
  /** 额外注入的 MCP server（如 lcb-notify 进程内通知工具），直通 Options.mcpServers。
   *  常驻语义：server 集合是 spawn 时输入（配置页 MCP 改动经指纹回收生效）；lcb-notify 的
   *  每 task 发送能力经 wiring 侧的可重绑 delegate 保持按轮生效（见 notify-server.ts） */
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
  /** 计划批准后是否升级 CLI 权限模式到 acceptEdits（缺省 true，主机器人既有行为）。
   *  分身必须传 false：acceptEdits 下 CLI 自动批准写操作、canUseTool 不再被调用，
   *  宿主侧 R1 红区/R2 写边界随之失效——分身的写操作必须每笔过安全闸（gate 侧有
   *  allow-session 记忆兜住确认摩擦，安全性不因批准计划而降级） */
  planApproveEscalates?: boolean;
  /** query 创建后回调：暴露 mcpServerStatus 窄句柄（wiring 存入 activeQueries，/mcp 命令实时拉取用）。
   *  常驻复用轮次同样回调（句柄是存活的同一进程）；句柄仅在该进程存活期间有效，
   *  任务结束后调用会 reject——调用方须自行 catch */
  onQuery?(handle: { mcpServerStatus(): Promise<McpServerStatus[]> }): void;

  // ---- 生命周期方案 A2：常驻进程池参数（wiring 注入） ----
  /** 进程亲和键（appId:channelKey）：提供且 resident !== false 时启用池复用。
   *  必须带 appId 前缀——池是模块级跨 app 共享，chatId 跨 app 不保证不撞 */
  affinityKey?: string;
  /** 本轮禁用常驻复用（每消息冷启，旧行为）；缺省复用 */
  resident?: boolean;
  /** 常驻进程空闲回收阈值（ms），0 = 不自动回收；缺省 60 分钟。
   *  每轮用最新值刷新（热改配置下一条消息生效） */
  residentIdleMs?: number;
  /** 常驻进程池上限（按 residentScope 统计），LRU 淘汰空闲进程；缺省不限（依赖空闲回收） */
  residentMax?: number;
  /** 池归属域（appId）：residentMax 按此统计 */
  residentScope?: string;
}

/** 常驻进程默认空闲回收阈值：1 小时（方案 §3.2 建议 1h 起步做成配置） */
const DEFAULT_RESIDENT_IDLE_MS = 60 * 60 * 1000;

/** 等待后台任务期间的静默超时：超时仍无任何事件（CLI 异常/卡死）按已有信息收尾，防任务永久挂起。
 *  正常路径无须走到——后台任务完成会唤醒主循环产生新事件，最终由 result/idle 信号收尾 */
const BG_WAIT_SILENCE_TIMEOUT_MS = 15 * 60 * 1000;

/** 工具摘要的主字段优先级：命中即直接展示人类可读值，不再贴原始 JSON */
const SUMMARY_INPUT_KEYS = ['command', 'file_path', 'url', 'query', 'pattern', 'path', 'skill'] as const;

/** 交互类工具的摘要白名单（2026-10-25）：入参是面向渲染的结构（题干/计划正文），JSON 原文
 *  截断上卡纯技术噪音——按工具改写为人类化短语；题干本身已在提问区完整显示，不回显 */
const INTERACTIVE_TOOL_SUMMARY: Record<string, (input: Record<string, unknown>) => string> = {
  AskUserQuestion: (input) => {
    const qs = input.questions;
    const n = Array.isArray(qs) ? qs.length : 0;
    return `向用户提问（${n} 题）`;
  },
  ExitPlanMode: (input) => {
    const plan = input.plan;
    const n = typeof plan === 'string' ? plan.length : 0;
    return n > 0 ? `提交执行计划（共 ${n.toLocaleString()} 字）` : '提交执行计划';
  },
};

/** 导出供单元测试（交互类工具摘要白名单） */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const special = INTERACTIVE_TOOL_SUMMARY[toolName];
  if (special) return special(input);
  for (const k of SUMMARY_INPUT_KEYS) {
    if (typeof input[k] === 'string' && (input[k] as string).trim()) return input[k] as string;
  }
  // 结构化入参通常有一个主字符串字段：取第一个非空字符串值兜底，仍未命中才落 JSON
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  const json = JSON.stringify(input);
  return json === '{}' ? '' : json.slice(0, 80);
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

/** TodoWrite 入参 → 步骤清单：宽松校验（非法项过滤），空/畸形清单返回 undefined 不发布 */
function extractTodos(input: Record<string, unknown>): Array<{ content: string; activeForm?: string; status: TodoItemStatus }> | undefined {
  const raw = input.todos;
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set<string>(['pending', 'in_progress', 'completed']);
  const todos: Array<{ content: string; activeForm?: string; status: TodoItemStatus }> = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.content !== 'string' || !t.content.trim()) continue;
    if (typeof t.status !== 'string' || !allowed.has(t.status)) continue;
    todos.push({
      content: t.content,
      ...(typeof t.activeForm === 'string' && t.activeForm.trim() ? { activeForm: t.activeForm } : {}),
      status: t.status as TodoItemStatus,
    });
  }
  return todos.length > 0 ? todos : undefined;
}

/** MCP server 配置的可序列化投影（指纹用）：只取影响子进程行为的配置字段。
 *  sdk 实例型 server（进程内 lcb-notify）不可序列化，按名字记 marker——wiring 侧
 *  每任务新建实例但 delegate 同槽（见 notify-server.ts createNotifySenderSlot），
 *  名字稳定即语义稳定。env/headers 只参与哈希不落日志，无泄漏面 */
function serializeMcpServers(servers: Record<string, McpServerConfig> | undefined): unknown {
  if (!servers) return null;
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const c = raw as Record<string, unknown>;
    out[name] = c.type === 'sdk'
      ? { type: 'sdk', name: typeof c.name === 'string' ? c.name : name }
      : {
        type: c.type,
        command: c.command,
        args: c.args,
        url: c.url,
        env: c.env,
        headers: c.headers ? Object.keys(c.headers as Record<string, unknown>) : undefined,
      };
  }
  return out;
}

/** 配置指纹（方案 §3.4）：全部 spawn 时输入的稳定哈希。这些输入在 executeTask 里逐项
 *  现读（人设/模型/plan/env/配置页 MCP/插件/档案 settings/cwd），常驻进程记录
 *  spawn 时指纹，下条消息指纹不符 → 回收重建——与「每任务现读热生效」语义完全一致，
 *  代价只是一次冷启动（退化一次现状体验）。
 *  不入指纹的两类：resumeSessionId——续接目标由复用条件的「指针一致性」单独校验
 *  （进程首轮 spawn 必然无 resume、次轮指针即自身会话 id，若入指纹则永远无法复用）；
 *  canUseTool——gate 为通道级对象，decide 时经 getter 现读配置（热），闭包捕获的
 *  wsName 与 cwd 同源（已入指纹） */
/** 稳定序列化：对象键深度排序（undefined 值剔除）——同内容不同插入序的对象
 *  （buildTaskEnv 展开整个 process.env、热重载重建的 env 对象等）不再产生指纹漂移。
 *  漂移 = 无谓的冷启动重建（用户体感「第二条消息还是慢」），实测踩过：仅键序不同
 *  的 env 曾触发一次性「配置指纹变化」重建 */
function stableStringify(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stableStringify);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) o[k] = stableStringify(val);
    }
    return o;
  }
  return v;
}

/** 指纹分量（名称 → 序列化输入）：整体哈希用于复用判定；分量哈希存 spawn 快照，
 *  漂移时逐项比对定位「是哪个输入变了」（env 只报键名不报值——env 常含凭证） */
function fingerprintParts(opts: RunTaskOptions): Array<[string, unknown]> {
  return [
    ['cwd', opts.cwd],
    ['env', opts.env ?? null],
    ['appendSystemPrompt', opts.appendSystemPrompt ?? null],
    ['model', opts.model ?? null],
    ['permissionMode', opts.permissionMode ?? null],
    ['extraArgs', opts.extraArgs ?? null],
    ['allowedSkills', opts.allowedSkills ?? null],
    ['planApproveEscalates', opts.planApproveEscalates ?? null],
    ['plugins', opts.plugins?.map((p) => p.path) ?? null],
    ['mcpServers', serializeMcpServers(opts.mcpServers)],
  ];
}

function hashPart(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableStringify(v))).digest('hex');
}

function fingerprintOf(opts: RunTaskOptions): string {
  return hashPart(fingerprintParts(opts).map(([, v]) => v));
}

/** 分量级漂移归因：返回人类可读的变化清单（env 按键名差集，其余按分量名）。
 *  只在已判定指纹不符后调用（诊断输出，不参与判定路径） */
function describePartDrift(spawn: Array<[string, unknown]>, now: Array<[string, unknown]>): string[] {
  const out: string[] = [];
  const nowMap = new Map(now);
  for (const [name, spawnV] of spawn) {
    const nowV = nowMap.get(name);
    if (JSON.stringify(stableStringify(spawnV)) === JSON.stringify(stableStringify(nowV))) continue;
    if (name === 'env' && spawnV && nowV && typeof spawnV === 'object' && typeof nowV === 'object') {
      const s = spawnV as Record<string, unknown>;
      const n = nowV as Record<string, unknown>;
      const added = Object.keys(n).filter((k) => !(k in s));
      const removed = Object.keys(s).filter((k) => !(k in n));
      const changed = Object.keys(s).filter((k) => k in n && stableStringify(s[k]) !== stableStringify(n[k]));
      const bits = [
        added.length ? `新增键 ${added.join(',')}` : '',
        removed.length ? `消失键 ${removed.join(',')}` : '',
        changed.length ? `值变化 ${changed.join(',')}` : '',
      ].filter(Boolean);
      out.push(`env（${bits.join('；') || '结构变化'}）`);
    } else {
      out.push(name);
    }
  }
  return out;
}

/** 推送式异步队列：多轮 prompt 的 streaming input 背板。
 *  SDK 按需拉取（generator 挂起等待 push），push 侧无须关心 CLI 是否就绪 */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T) => void> = [];
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }
  async *stream(): AsyncGenerator<T> {
    while (true) {
      if (this.items.length > 0) yield this.items.shift()!;
      else yield await new Promise<T>((r) => this.waiters.push(r));
    }
  }
}

/** 单轮任务上下文：常驻进程内每条消息一份（事件循环按此重绑回调与重置状态） */
interface TurnContext {
  prompt: string;
  cb: ExecutorCallbacks;
  collector: OutputCollector;
  resolve: (o: TaskOutcome) => void;
  reject: (e: Error) => void;
  settled: boolean;
  /** 本轮起点（push 时刻）：常驻复用轮的 0s「启动」从这里计 */
  t0: number;
  /** init 到达时刻（P2 修正：仅记录 init 之后的输出信号，resume 回放块不再污染统计）。
   *  复用轮在 sendTurn 直接置位（进程早已就绪 = 0s） */
  initAt: number;
  firstOutAt: number;
  sawFirstDelta: boolean;
  finalText: string;
  resultErrorText: string;
  usage: TaskUsage | undefined;
  /** 主循环轮次（子代理不计）：常驻语义与旧版一致——按轮重置 */
  turns: number;
  /** 种子 = resumeSessionId；init/result 到达即刷新（全新会话首轮被中止时也能归档续接） */
  sessionId: string;
  /** 复用轮标记（计时日志口径：spawn→init 记 0s） */
  reused: boolean;
  /** 后台任务在途集合（level 信号整组替换；主 turn result 到达时非空 → 挂起等待） */
  bgTasks: Map<string, { taskType: string; description: string }>;
  waitingBg: boolean;
  lastEventAt: number;
  toolNames: Map<string, string>;
  /** tool_use_id → 是否发生在子代理内（parent_tool_use_id 快照）：tool_result 归组用 */
  toolParents: Map<string, boolean>;
  silenceWatch: NodeJS.Timeout;
}

/**
 * 不进工具明细行的工具：TodoWrite 驱动步骤列表本身、Task 的调用行与子代理步骤重复——
 * 两者的 tool_use/tool_result 都不再产生「已使用工具」行，避免步骤区出现自指噪音
 */
const HEADERLESS_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'Task']);

/**
 * 会话进程：一个 CLI 子进程（query）+ 常驻消息循环。
 * 生命周期：spawn → N 轮 sendTurn → kill/die。ephemeral 用法 = spawn 后跑一轮即 kill，
 * 与旧版「每消息一个进程」等价（统一一条循环逻辑，不分叉）。
 */
class SessionProcess {
  readonly q: Query;
  readonly key: string;
  readonly scope?: string;
  readonly resident: boolean;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly abortController = new AbortController();
  private readonly spawnT0 = Date.now();
  /** spawn 时的全部输入指纹（复用校验用） */
  readonly fingerprint: string;
  /** spawn 时的指纹分量快照（漂移归因日志用；env 值不出现在任何日志） */
  readonly spawnParts: Array<[string, unknown]>;
  /** 进程的会话 id（init/result 刷新）：复用校验的「指针一致性」基准 */
  sessionId = '';
  /** spawn 时 init 提取的清单（复用轮回放给 onInit；指纹保证清单未变） */
  inventory: Omit<SessionInventory, 'workspace' | 'loadedAt'> | undefined;
  /** 进程当前权限模式：spawn 初值 + ExitPlanMode 批准升级跟踪；复用轮开始前复位到本轮期望
   *  （否则上一轮 plan 批准后进程停留 acceptEdits，本轮 /plan 语义被吃掉） */
  private currentMode: string;
  private procInitAt = 0;
  private initDone = false;
  currentTurn: TurnContext | undefined;
  private busy = false;
  dead = false;
  /** 空闲回收判定的活跃基准（每轮收尾刷新） */
  lastUsedAt = Date.now();
  idleMs = DEFAULT_RESIDENT_IDLE_MS;
  private turnSignalCleanup: (() => void) | undefined;
  /** kill 已执行标记（与 dead 分离：ephemeral 轮内收尾先置 dead，kill 仍须真正 q.return()
   *  结束流迭代——否则真实 SDK 的子进程在无后续消息时永远挂着等 stdin） */
  private killed = false;

  private constructor(key: string, opts: RunTaskOptions, resident: boolean) {
    this.key = key;
    this.scope = opts.residentScope;
    this.resident = resident;
    this.fingerprint = fingerprintOf(opts);
    this.spawnParts = fingerprintParts(opts);
    this.currentMode = opts.permissionMode ?? 'default';
    const proc = this;
    this.q = query({
      // Streaming Input（官方推荐姿势）：prompt 经 AsyncGenerator 送入，push 一条用户消息后
      // 挂起不结束——stdin 在整个进程存活期间保持打开（多轮 = 继续push）。
      // 字符串 prompt 的单轮模式在收到第一条 result 后即关 stdin（SDK isSingleUserTurn
      // 行为，agent-sdk#384），plan mode 下 ExitPlanMode/AskUserQuestion 这类轮次边界的
      // 权限请求落在 result 之后，CLI 侧 inputClosed 后全部报 "Stream closed" 中断审批流
      prompt: this.input.stream(),
      options: {
        cwd: opts.cwd,
        settingSources: ['user', 'project'],
        permissionMode: opts.permissionMode ?? 'default',
        // 流式增量事件（stream_event）：仅消费首个 text delta 提前点亮「正在执行」（首个完整块
        // 生成前 otherwise 状态行停留在启动阶段，视觉上拉长「启动中」）；不渲染不落盘，
        // 完整块仍走 assistant 分支（渲染/落盘口径不变）
        includePartialMessages: true,
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
              // 后续 Write/Edit 不再逐次弹确认卡（SDK Query.setPermissionMode，官方 permissions 文档姿势）。
              // 分身（planApproveEscalates=false）不升级：acceptEdits 会绕过 canUseTool，
              // 宿主安全闸（R1 红区/R2 写边界）随之失效——安全优先于确认摩擦。
              // 模式跟踪：常驻进程跨轮存续，复用轮开始前据此复位（sendTurn）
              if (decision.behavior === 'allow' && toolName === 'ExitPlanMode'
                && opts.planApproveEscalates !== false) {
                await proc.q.setPermissionMode('acceptEdits').then(() => { proc.currentMode = 'acceptEdits'; }).catch((e) => {
                  console.warn('[executor] setPermissionMode(acceptEdits) 失败（继续按批准前模式执行）:', e instanceof Error ? e.message : e);
                });
              }
              return decision;
            },
          }
          : {}),
        abortController: this.abortController,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
        ...(opts.plugins ? { plugins: opts.plugins.map((p) => ({ type: 'local' as const, path: p.path })) } : {}),
        // extraArgs 合并口：调用方传入（--settings 档案认证）+ 内置进度播报约束 + 人格补充
        // （--append-system-prompt，CLI 2.1.x 只认命令行参数，SDK 同名 option 被静默丢弃
        // ——见 RunTaskOptions.appendSystemPrompt 注释）
        ...((opts.extraArgs && Object.keys(opts.extraArgs).length) || opts.appendSystemPrompt || PROGRESS_SOP
          ? {
            extraArgs: {
              ...(opts.extraArgs ?? {}),
              ...([PROGRESS_SOP, opts.appendSystemPrompt].filter(Boolean).join('\n\n')
                ? { 'append-system-prompt': [PROGRESS_SOP, opts.appendSystemPrompt].filter(Boolean).join('\n\n') }
                : {}),
            },
          }
          : {}),
      },
    });
  }

  static spawn(key: string, opts: RunTaskOptions, resident: boolean): SessionProcess {
    const proc = new SessionProcess(key, opts, resident);
    void proc.runLoop();
    return proc;
  }

  get isBusy(): boolean { return this.busy; }

  /** 常驻消息循环：进程存活期间常驻，事件按 currentTurn 分发；轮结束只 settle 轮次，
   *  不退出循环（ephemeral 进程在首轮收尾后 break，对齐旧版「result 即结束」） */
  private async runLoop(): Promise<void> {
    try {
      for await (const message of this.q) {
        if (this.dead) break; // kill 已发起：不再消费
        const turn = this.currentTurn;
        if (!turn) continue; // 轮外杂事件（上轮尾巴的 idle 心跳等）：静默丢弃
        turn.lastEventAt = Date.now();
        switch (message.type) {
          case 'system': {
            if (message.subtype === 'init') {
              this.procInitAt = Date.now();
              this.initDone = true;
              turn.initAt = Date.now();
              // init 即携带 session_id：全新会话在首轮 turn 结束前被 /stop 中止时不会有 result 消息，
              // 不在此捕获则 sessionId 恒为空串 → catch 挂不上 err.sessionId → 归档 no-op，
              // 会话指针停留 null，用户随后「继续」会开全新会话丢失上下文（resume 场景两值等价）
              if (typeof message.session_id === 'string' && message.session_id) {
                this.sessionId = message.session_id;
                turn.sessionId = message.session_id;
              }
              this.inventory = {
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
              turn.cb.onInit?.(this.inventory);
            } else if (message.subtype === 'status') {
              // CLI 状态心跳（requesting=等模型响应 / compacting=上下文压缩 / null=空闲）。
              // v5：requesting 不再渲染「等待模型响应…」笼罩性状态行，改发 thinking 事件——
              // 进度卡在执行栈顶显示「💭 处理中…」，首个步骤/工具/文本事件到达即焚；
              // compacting 与后台任务等待等有信息量的心跳降级为计时行上方的灰色小字（heartbeat），
              // null（空闲/开始吐字）清空心跳——避免长 API 轮次「只有计时在走」的黑盒感
              if (message.status === 'requesting') {
                await turn.cb.onProgress({ kind: 'thinking' });
              } else {
                await turn.cb.onProgress({
                  kind: 'status',
                  content: message.status === 'compacting' ? '上下文压缩中…' : '',
                });
              }
            } else if (message.subtype === 'background_tasks_changed') {
              // 后台任务在途清单（level 信号）：整组替换语义。ambient=true 的杂务任务
              //（live-update watcher 等）不算用户可见工作，不计数避免状态行虚高
              turn.bgTasks.clear();
              for (const t of message.tasks) {
                if (!t.ambient) turn.bgTasks.set(t.task_id, { taskType: t.task_type, description: t.description });
              }
              if (turn.waitingBg && turn.bgTasks.size > 0) {
                await turn.cb.onProgress({ kind: 'status', content: `等待 ${turn.bgTasks.size} 个后台任务完成…` });
              }
            } else if (message.subtype === 'session_state_changed' && message.state === 'idle') {
              // 权威 turn-over 信号：idle 在 heldBackResult flush 且后台任务续跑循环退出后触发。
              // 主 turn result 已到 + 后台任务全部结束 → 真正收尾（后台任务若再唤醒主循环，
              // 会先收到新的 assistant/result 事件并覆盖 finalText，idle 仍在最后）
              if (turn.waitingBg && turn.bgTasks.size === 0) {
                await this.finalizeTurn(turn);
              }
            } else if (message.subtype === 'task_started') {
              const tag = message.subagent_type ? ` [${message.subagent_type}]` : '';
              await turn.cb.onProgress({
                kind: 'status',
                content: `${message.is_backgrounded ? '后台子代理启动' : '子代理启动'}${tag}: ${message.description}`,
              });
              // 子代理清单：进度卡独立区块展示每个子代理的运行状态（对齐 CLI 的 agent 进度显示）
              await turn.cb.onProgress({
                kind: 'agent-start',
                agent: { id: message.task_id, description: message.description, type: message.subagent_type ?? 'task' },
              });
            } else if (message.subtype === 'task_notification') {
              // 后台任务落定（completed/failed/stopped）：summary 为任务自述结论。
              // status 会原文渲染进进度卡正文并随每次卡片更新发送——子代理完整报告可达
              // 上万字符，截断保留结论摘要（全文另有 agent 清单与 transcript 承载）
              const label = message.status === 'completed' ? '后台任务完成' : message.status === 'failed' ? '后台任务失败' : '后台任务已停止';
              await turn.cb.onProgress({ kind: 'status', content: `${label}: ${(message.summary ?? '').slice(0, 300)}` });
              await turn.cb.onProgress({
                kind: 'agent-settle',
                id: message.task_id,
                status: message.status === 'completed' ? 'done' : message.status === 'failed' ? 'failed' : 'stopped',
                ...(message.summary ? { summary: message.summary } : {}),
              });
            }
            break;
          }
          case 'stream_event': {
            // 流式增量（includePartialMessages）：仅用首个 text delta 提前点亮「正在执行」——
            // 完整块生成前状态行 otherwise 停留在启动阶段。按 Anthropic Messages stream 事件
            // 结构窄化访问，字段缺失/其他事件类型静默忽略
            const ev = (message as { event?: { type?: string; delta?: { type?: string } } }).event;
            if (!turn.sawFirstDelta && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              turn.sawFirstDelta = true;
              if (turn.initAt && !turn.firstOutAt) turn.firstOutAt = Date.now();
              await turn.cb.onProgress({ kind: 'first-delta' });
            }
            break;
          }
          case 'assistant': {
            // P2 修正：输出信号只认 init 之后的（resume 回放的 assistant 块/时钟漂移不再产生
            // 负数 init→首输出——统计被离群污染的根因）。渲染/轮次计数不受影响
            if (turn.initAt && !turn.firstOutAt) turn.firstOutAt = Date.now();
            // turns 只计主循环轮次：子代理消息（parent_tool_use_id 非空）混入会把单任务轮数
            // 放大数倍（旧超长提醒误报的帮凶），兜底口径应以主循环为准
            if (!message.parent_tool_use_id) turn.turns++;
            for (const block of message.message.content) {
              if (block.type === 'text') {
                // 子代理文本加标识前缀（forwardSubagentText 转发），与主 Agent 输出在进度卡上区分；
                // sub 字段供进度卡把文本块归组到对应子代理条目（transcript 消费前缀形态不变）
                const isSubText = !!message.parent_tool_use_id;
                const prefix = isSubText ? '【子代理】' : '';
                await turn.cb.onProgress({ kind: 'text', content: `${prefix}${block.text}`, ...(isSubText ? { sub: true } : {}) });
              } else if (block.type === 'tool_use') {
                const input = (block.input ?? {}) as Record<string, unknown>;
                turn.toolNames.set(block.id, block.name);
                turn.collector.track(block.name, input);
                const isSub = !!message.parent_tool_use_id;
                turn.toolParents.set(block.id, isSub);
                // TodoWrite 驱动步骤列表本身、Task 调用行与子代理步骤重复：两类不进工具明细，
                // 只发语义事件（todos 事件在此发布；子代理启动已由 task_started 覆盖）
                if (HEADERLESS_TOOLS.has(block.name)) {
                  if (block.name === 'TodoWrite') {
                    const todos = extractTodos(input);
                    if (todos) await turn.cb.onProgress({ kind: 'todos', todos });
                  }
                  continue;
                }
                await turn.cb.onProgress({
                  kind: 'tool-start',
                  tool: block.name,
                  summary: summarizeToolInput(block.name, input),
                  ...(isSub ? { sub: true } : {}),
                });
              }
            }
            break;
          }
          case 'user': {
            const content = message.message.content;
            if (!Array.isArray(content)) break;
            for (const block of content) {
              if (block.type === 'tool_result') {
                const name = turn.toolNames.get(block.tool_use_id) ?? '';
                if (HEADERLESS_TOOLS.has(name)) continue;
                const note = block.is_error ? firstErrorLine(block.content) : undefined;
                const sub = turn.toolParents.get(block.tool_use_id) ?? false;
                await turn.cb.onProgress({
                  kind: 'tool-result',
                  tool: name,
                  ok: !block.is_error,
                  ...(note ? { note } : {}),
                  ...(sub ? { sub: true } : {}),
                });
              }
            }
            break;
          }
          case 'result': {
            if (message.subtype === 'success') turn.finalText = message.result;
            // 非成功终态（error_during_execution / error_max_turns 等，错误文本在 errors 数组）：
            // 带出循环后统一抛出，消息格式与单轮模式 SDK throw 保持一致（index.ts catch 的 hint 依赖该格式）
            else if (message.subtype.startsWith('error')) turn.resultErrorText = message.errors?.join('\n') || message.subtype;
            // usage 提取（error result 可能缺字段，全部兜 0 不抛）
            const u = (message as { usage?: Partial<Record<'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens', number>> }).usage;
            if (u) {
              turn.usage = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
                cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
              };
            }
            if ('session_id' in message && typeof message.session_id === 'string') {
              this.sessionId = message.session_id;
              turn.sessionId = message.session_id;
            }
            // 主 turn 终态。后台任务仍在跑时不收尾：return 会触发 q.return() → SDK 清理子进程，
            // 后台子代理被连带杀掉、完成通知永远收不到（旧版「主代理结束、子代理无声消失」根因）。
            // 挂起继续 for await：后台任务完成会唤醒 CLI 主循环自动续跑（新的 assistant/result
            // 事件照常流出，飞书端继续收到推送），直到 session_state_changed(idle) 或续跑 turn 的
            // result 在 bgTasks 清空后到达才真正收尾。bgTasks 为空 = 无在途任务，维持旧行为立即收尾
            //（CLI 不发 background_tasks_changed 事件时自然退化，不会比旧版更差）
            if (message.subtype === 'success' || message.subtype.startsWith('error')) {
              if (turn.bgTasks.size > 0) {
                turn.waitingBg = true;
                await turn.cb.onProgress({ kind: 'status', content: `主线回复完成，等待 ${turn.bgTasks.size} 个后台任务…` });
                break;
              }
              await this.finalizeTurn(turn);
            }
            break;
          }
        }
      }
      // 流自然结束（CLI 进程退出/被 kill）：轮内未收尾的按进程退出错误结算。
      // kill 路径（/stop、回收）按中止语义（wiring 的 abort 分支命中）；非 kill 的自然
      // EOF 在 result 之前到达属进程崩溃——明确报因，不再像旧版那样静默返回空成功
      if (this.currentTurn && !this.currentTurn.settled) {
        const err = new Error(this.killed ? 'Operation aborted' : 'Claude Code 进程在回复完成前退出（可重发任务；历史上下文经 /resume 可找回）');
        this.settleTurnError(this.currentTurn, err);
      }
      this.die();
    } catch (e) {
      // 流错误（/stop 的 AbortError、Stream closed、进程崩溃等）：把已知的 sessionId 挂到
      // 错误对象再抛——wiring 侧据此把中止/出错任务的会话也归档进 /resume 历史
      //（AbortError 自身不携带 sessionId；不改动原 message，index.ts catch 的 hint 匹配不受影响）
      const err = e instanceof Error ? e : new Error(String(e));
      if (this.currentTurn && !this.currentTurn.settled) this.settleTurnError(this.currentTurn, err);
      this.die();
    }
  }

  /** 收尾前拉一次 MCP 真实连接状态（init 快照必为 pending，这是空闲期 /mcp 的数据源）；
   *  try/catch 同时兜住同步异常（旧 mock/异常环境下方法缺失）与异步拒绝，绝不阻断收尾 */
  private async finalizeTurn(turn: TurnContext): Promise<void> {
    try {
      const statuses = await this.q.mcpServerStatus();
      turn.cb.onMcpStatus?.(statuses);
    } catch { /* 拉取失败：保留 init 快照 */ }
    if (turn.resultErrorText) {
      // 携带 sessionId 抛出：wiring 侧据此把出错任务的会话也归档进 /resume 历史
      //（错误任务的会话上下文同样有价值；早期不归档导致历史列表难积累）
      const err = new Error(`Claude Code returned an error result: ${turn.resultErrorText}`) as Error & { sessionId?: string };
      err.sessionId = turn.sessionId || undefined;
      this.settleTurn(turn, err);
      return;
    }
    this.settleTurn(turn, {
      sessionId: turn.sessionId,
      finalText: turn.finalText,
      producedFiles: turn.collector.files(),
      turns: turn.turns,
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(this.inventory ? { inventory: this.inventory } : {}),
    });
  }

  /** 轮次落定（成功/出错共用）：清看门狗与信号监听、复位 busy、（ephemeral）停止循环 */
  private settleTurn(turn: TurnContext, result: TaskOutcome | Error): void {
    if (turn.settled) return;
    turn.settled = true;
    clearInterval(turn.silenceWatch);
    this.turnSignalCleanup?.();
    this.turnSignalCleanup = undefined;
    if (this.currentTurn === turn) this.currentTurn = undefined;
    this.busy = false;
    this.lastUsedAt = Date.now();
    // 启动耗时分解（先诊断承诺）：spawn→init 是 CLI 冷启动（配置/插件/MCP server 拉起 +
    // resume 回放）；复用轮为 0s（进程早已就绪）。init→首输出是模型首响（P2 修正后仅计
    // init 之后的信号，不再被 resume 回放块污染成负数）。总耗时按本轮 push 时刻起算
    const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const initLag = turn.reused ? '0s（常驻复用）'
      : this.procInitAt ? sec(this.procInitAt - this.spawnT0) : '?';
    const firstOut = turn.initAt && turn.firstOutAt && turn.firstOutAt >= turn.initAt ? sec(turn.firstOutAt - turn.initAt) : '?';
    console.log(`[executor] 启动耗时：spawn→init ${initLag}，init→首输出 ${firstOut}，总 ${sec(Date.now() - turn.t0)}${turn.reused ? '（常驻复用）' : this.resident ? '（新进程）' : '（每消息进程）'}`);
    if (result instanceof Error) turn.reject(result);
    else turn.resolve(result);
    // ephemeral：首轮收尾即停（对齐旧版「result 即 return 结束循环」）
    if (!this.resident) this.dead = true;
  }

  /** settleTurn 的错误入口：附 sessionId 后 reject（复用 catch 路径的挂载语义） */
  private settleTurnError(turn: TurnContext, err: Error): void {
    if (turn.sessionId && !(err as Error & { sessionId?: string }).sessionId) {
      (err as Error & { sessionId?: string }).sessionId = turn.sessionId;
    }
    this.settleTurn(turn, err);
  }

  /**
   * 送入一轮任务（prompt 经 stdin 流写入同一进程），返回本轮结果。
   * 复用轮开始前做三件事：回放 init 清单（无新 init 消息）、重曝光 query 句柄、
   * 复位权限模式（上一轮 plan 批准可能已把进程切到 acceptEdits）。
   */
  async sendTurn(prompt: string, opts: RunTaskOptions, cb: ExecutorCallbacks): Promise<TaskOutcome> {
    if (this.dead) {
      const err = new Error('Operation aborted') as Error & { sessionId?: string };
      if (this.sessionId) err.sessionId = this.sessionId;
      throw err;
    }
    this.busy = true;
    this.lastUsedAt = Date.now();
    this.idleMs = opts.residentIdleMs ?? DEFAULT_RESIDENT_IDLE_MS;
    const reused = this.initDone;
    // 本轮 abort 信号接线：外部 signal（/stop、4h 硬超时）中止 = 杀整个进程
    //（与旧行为等价：abortController.abort 终止整个 query），下条消息冷启重建。
    // 直接桥接（signal → abortController）与旧 bridgeSignal 一致、不随轮清理——
    // 「任务结束后 signal 仍传导到进程控制器」是既有可观测行为（wiring 侧不会再触发）
    if (opts.signal) {
      if (opts.signal.aborted) {
        const err = new Error('Operation aborted') as Error & { sessionId?: string };
        if (this.sessionId) err.sessionId = this.sessionId;
        this.busy = false;
        void this.kill();
        throw err;
      }
      const signal = opts.signal;
      signal.addEventListener('abort', () => this.abortController.abort(new Error('task-aborted')), { once: true });
      const onAbort = () => { void this.kill(); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.turnSignalCleanup = () => signal.removeEventListener('abort', onAbort);
    }
    const proc = this;
    const turn: TurnContext = {
      prompt,
      cb,
      collector: new OutputCollector(opts.cwd),
      resolve: () => {},
      reject: () => {},
      settled: false,
      t0: Date.now(),
      initAt: 0,
      firstOutAt: 0,
      sawFirstDelta: false,
      finalText: '',
      resultErrorText: '',
      usage: undefined,
      turns: 0,
      sessionId: opts.resumeSessionId ?? '',
      reused,
      bgTasks: new Map(),
      waitingBg: false,
      lastEventAt: Date.now(),
      toolNames: new Map(),
      toolParents: new Map(),
      // 等待后台任务期间的静默看门狗：pending 期间长时间无任何事件则按已有信息收尾
      //（并把进程一并回收——15 分钟静默属异常态，进程可信度存疑，冷启重建更稳）
      silenceWatch: setInterval(() => {
        const t = proc.currentTurn;
        if (t === turn && t.waitingBg && Date.now() - t.lastEventAt > BG_WAIT_SILENCE_TIMEOUT_MS) {
          console.warn(`[executor] 等待后台任务静默超 ${Math.round(BG_WAIT_SILENCE_TIMEOUT_MS / 60000)} 分钟无事件，按已有结果收尾（后台任务: ${[...t.bgTasks.values()].map((x) => x.description).join(' / ')}）`);
          proc.settleTurn(t, {
            sessionId: t.sessionId,
            finalText: t.finalText,
            producedFiles: t.collector.files(),
            turns: t.turns,
            ...(t.usage ? { usage: t.usage } : {}),
            ...(proc.inventory ? { inventory: proc.inventory } : {}),
          });
          void proc.kill();
        }
      }, 30_000),
    };
    turn.silenceWatch.unref?.();
    if (reused) {
      // 复用轮：进程早已 init —— 本轮「启动」为 0s；init 清单回放（指纹保证未变）+
      // 句柄重曝光 + 权限模式复位到本轮期望
      turn.initAt = Date.now();
      if (this.inventory) cb.onInit?.(this.inventory);
      opts.onQuery?.(this.q);
      const want = opts.permissionMode ?? 'default';
      if (want !== this.currentMode) {
        await this.q.setPermissionMode(want).then(() => { this.currentMode = want; }).catch((e) => {
          console.warn('[executor] 复用轮 setPermissionMode 复位失败（继续按进程当前模式执行）:', e instanceof Error ? e.message : e);
        });
      }
    } else {
      opts.onQuery?.(this.q);
    }
    const promise = new Promise<TaskOutcome>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    this.currentTurn = turn;
    this.input.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
    return promise;
  }

  /** 主动回收：结束流迭代 + 中止在途控制请求，进程出池。
   *  忙碌进程不应被回收（会杀掉运行中任务）——调用方自查 isBusy */
  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    this.dead = true;
    if (pool.get(this.key) === this) pool.delete(this.key);
    // 本轮仍在途时同步 abort（唤醒在途等待；外部 signal 路径的直达桥接已先行触发）；
    // 空闲回收不 abort——结束迭代本身即触发 SDK 子进程清理，且保持「任务完成后
    // 控制器不被污染」的既有可观测语义
    if (this.currentTurn) this.abortController.abort(new Error('process-recycled'));
    try { await this.q.return(undefined as never); } catch { /* 进程已退等场景：忽略 */ }
  }

  /** 非主动的死亡（流结束/崩溃）：出池即可，迭代已自然结束 */
  private die(): void {
    if (this.dead) return;
    this.dead = true;
    if (pool.get(this.key) === this) pool.delete(this.key);
  }
}

// ---- 常驻进程池（模块级，跨 app 共享；key 带 appId 前缀防撞） ----
const pool = new Map<string, SessionProcess>();
let sweeper: NodeJS.Timeout | null = null;

/** 空闲回收巡检：每分钟扫一遍池，空闲超阈值的空闲进程回收。
 *  复用路径还有内联检查（消息到达时判定），巡检负责「之后再无消息」的内存释放 */
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const proc of [...pool.values()]) {
      if (!proc.isBusy && proc.idleMs > 0 && now - proc.lastUsedAt > proc.idleMs) {
        console.log(`[executor] 常驻进程空闲回收：${proc.key}（空闲 ${Math.round((now - proc.lastUsedAt) / 60000)} 分钟）`);
        void proc.kill();
      }
    }
    if (pool.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 60_000);
  sweeper.unref?.();
}

/** 进程注册入池 + 上限约束（按 scope 统计，LRU 淘汰最久未用的空闲进程；忙进程不动） */
function register(proc: SessionProcess, max?: number): void {
  pool.set(proc.key, proc);
  if (max && max > 0) {
    const others = [...pool.values()].filter((p) => p !== proc && p.scope === proc.scope);
    let over = others.length + 1 - max;
    if (over > 0) {
      const idleOldestFirst = others.filter((p) => !p.isBusy).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const victim of idleOldestFirst) {
        if (over-- <= 0) break;
        console.log(`[executor] 常驻进程池达上限（${max}），LRU 回收：${victim.key}`);
        void victim.kill();
      }
    }
  }
  ensureSweeper();
}

/** 指针切换时作废该通道的常驻进程（/new、/resume <n>、/ws use）：旧进程的会话上下文
 *  不再适用。忙进程不动——运行中任务的中止由 /new 的 abort 负责（abort 会连带杀进程） */
export function killResidentSession(affinityKey: string): void {
  const proc = pool.get(affinityKey);
  if (proc && !proc.isBusy) void proc.kill();
}

/** 桥接器关闭时回收全部常驻进程（优雅退出，不赖 stdio 断连兜底） */
export function killAllResidentSessions(): void {
  for (const proc of [...pool.values()]) void proc.kill();
}

/** 测试隔离：清空进程池（生产代码不得调用） */
export function __resetResidentPoolForTests(): void {
  for (const proc of [...pool.values()]) void proc.kill();
  pool.clear();
}

export async function runTask(prompt: string, opts: RunTaskOptions, cb: ExecutorCallbacks): Promise<TaskOutcome> {
  const key = opts.affinityKey;
  if (!key || opts.resident === false) {
    // ephemeral：每消息一个进程（旧行为）——spawn 一轮即回收的常驻进程，循环逻辑与常驻同一条
    const proc = SessionProcess.spawn(key ?? `ephemeral:${Math.random().toString(36).slice(2)}`, opts, false);
    try {
      return await proc.sendTurn(prompt, opts, cb);
    } finally {
      await proc.kill();
    }
  }
  // 常驻路径：复用三校验（活着 / 指纹一致 / 指针一致），任一不符回收重建。
  // 内联空闲检查与 sweeper 双保险：消息到达时先行判定，不等巡检周期
  const fp = fingerprintOf(opts);
  const wantSession = opts.resumeSessionId ?? '';
  let proc = pool.get(key);
  if (proc && (!proc.dead) && !proc.isBusy && proc.fingerprint === fp && proc.sessionId === wantSession
    && !(proc.idleMs > 0 && Date.now() - proc.lastUsedAt > proc.idleMs)) {
    console.log(`[executor] 常驻进程复用：${key}（会话 ${proc.sessionId || '待 init'}）`);
    return await proc.sendTurn(prompt, opts, cb);
  }
  if (proc) {
    // 归因日志：指纹漂移（配置热改）/ 指针漂移（/new /resume /ws use / 群聊滚动）/ 空闲超阈值 / 忙碌兜底
    if (proc.isBusy) {
      console.warn(`[executor] 通道 ${key} 的常驻进程仍在忙碌（异常：FIFO 串行下不应发生），本轮独立冷启`);
      const standalone = SessionProcess.spawn(`${key}:overlapping-${Date.now()}`, { ...opts, affinityKey: undefined, resident: false }, false);
      try {
        return await standalone.sendTurn(prompt, opts, cb);
      } finally {
        await standalone.kill();
      }
    }
    const reason = proc.fingerprint !== fp
      ? `配置指纹变化：${describePartDrift(proc.spawnParts, fingerprintParts(opts)).join('、')}`
      : proc.sessionId !== wantSession ? '会话指针变化'
      : proc.idleMs > 0 && Date.now() - proc.lastUsedAt > proc.idleMs ? '空闲超阈值'
      : '进程已退出';
    console.log(`[executor] 常驻进程回收重建（${reason}）：${key}`);
    await proc.kill();
    proc = undefined;
  }
  const created = SessionProcess.spawn(key, opts, true);
  register(created, opts.residentMax);
  return await created.sendTurn(prompt, opts, cb);
}
