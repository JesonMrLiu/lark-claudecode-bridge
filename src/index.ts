// 装配主流程：消息 → 访问控制 → 命令 → 通道队列 → 执行 → 确认卡片 → 回传
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  BridgeConfig, CardActionEvent, CardActionResponse, CardDecision, ConfirmationRequest, FeishuAppConfig, GatewayHandlers,
  IncomingMessage, PermissionDecision, ProgressEvent, SessionInventory, TriggerRule,
} from './types.js';
import { CONFIG_DIR, CONFIG_PATH, DEFAULT_CONTEXT_REMIND_TOKENS, INBOX_DIR, loadConfig, sameApps } from './config.js';
import { DEFAULT_CLAUDE_DIR, initManagedClaudeDir, resolveClaudeDir } from './claude-config.js';
import { buildTaskEnv } from './task-env.js';
import { warnIfNoClaudeAuth } from './auth-precheck.js';
import { serverUrl } from './util/server-url.js';
import { startWebServer } from './web/server.js';
import { clearPidFile, freeLcbOccupiedPort, writePidFile, stopExistingBridgeAndWait } from './web/lifecycle.js';
import { AccessControl } from './access/access-control.js';
import { FeishuGateway } from './gateway/feishu-gateway.js';
import { registerChatInfoSource } from './gateway/gateway-registry.js';
import { ProgressCard, feishuErrorBody } from './gateway/progress-card.js';
import {
  DECISION_TEXT, TOOLS_TOGGLE_REQUEST_ID,
  buildPlanConfirmCard, buildPlanSettledCard, buildPlanTailCard, buildResultTailCard, buildWorkspaceSwitchedCard,
  planChunkHeader, resultContinuationHeader,
  type PlanCardRequest,
  type QuestionCardRequest, type QuestionCardAnswers,
} from './gateway/card-builder.js';
import { chunkText } from './util/chunk-text.js';
import { runTask, killResidentSession, killAllResidentSessions } from './executor/claude-executor.js';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import {
  PermissionGate, DEFAULT_ALLOW_TOOLS_LIST, DEFAULT_DANGEROUS_COMMANDS, DEFAULT_ALLOW_ALL_TOOLS,
  type PlanAskResult, type AskQuestionResult,
} from './executor/permission-gate.js';
import { discoverPlugins, resolvePluginPaths } from './executor/plugin-discovery.js';
import { createGatewaySender, createNotifyServer, createNotifySenderSlot, NOTIFY_SERVER_NAME, type NotifySenderSlot } from './executor/notify-server.js';
import { BRIDGE_MCP_JSON, readMcpServersFromJsonFile } from './web/skills-mcp-api.js';
import { FEISHU_NOTIFY_SOP_PROMPT, TOOL_HINT_PROMPT } from './notify-sop.js';
import { ensureProfileSettingsFile, resolveAppProfile, resolveAppProfileModel } from './app-profile.js';
import {
  MEMORY_PLUGIN_NAME, createMemoryProvider, ensureMemoryUserKeys, memoryEndpoint, memoryEnvFor, resolveMemoryUid,
  type MemoryProvider,
} from './memory.js';
import { WEB_USER_ID, onUserKeyRotated, vaultStore } from './web/memory-users-api.js';
import { cleanupClientCliConf, ensureClientCliConf, ensureMemoryServiceRunning, stopManagedServer } from './memory-installer.js';
import { isImageFile } from './util/file-types.js';
import { SessionStore, migrateLegacySessions } from './session/session-store.js';
import { handleCommand, applyWorkspaceSwitch, workspaceListMarkdown, deputyWorkspacePolicy } from './session/commands.js';
import { applyRuleRewrite, isLocalCommandRewrite, matchTrigger, rewriteByTrigger } from './session/triggers.js';
import { Semaphore, channelKey } from './session/channel.js';
import { TranscriptWriter, sweepTranscripts, type TranscriptRecorder } from './transcript/transcript-writer.js';
import { nowBeijingISO } from './util/beijing-time.js';
import { getRedactor } from './security/redact.js';
import { DEFAULT_REDZONE_READ_SOURCES } from './security/paths.js';
import { CANARY_ALERT_TEXT, SecurityAudit, type SecurityAuditWriter, type SecurityEvent } from './security/audit.js';

// 版本号收敛到 version.ts 单一来源（bin/lcb.ts 与 smoke 测试均引用）
export { VERSION } from './version.js';
// 任务总超时 4 小时（防挂死；确认等待、长编译均在正常范围）
const TASK_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
// 确认等待窗：无人确认则自动拒绝。超时判定由 wiring 侧自管（ask 闭包内的定时器），
// 从而到点即清理 confirmPending 条目并把卡片 PATCH 为过期态——条目有界不泄漏，
// 迟到点击因条目已删被 handleCardAction toast 提示后忽略，永不显示与实际不符的决策态
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
// PermissionGate 的兜底超时：仅当 wiring 侧超时机制失效时才触发（正常流程 ask 必在 CONFIRM_TIMEOUT_MS 内 settle）
const GATE_FALLBACK_TIMEOUT_MS = CONFIRM_TIMEOUT_MS + 60_000;
// 卡片发送超时：飞书 WS 偶发无响应时 sendCardTo 可能永久挂起，而 ask/askQuestion 闭包的
// 超时定时器在 await 发卡之后才 arm——挂起即意味着永不超时。超时/失败快速降级为 deny，
// 模型自行决策或重试，不再整轮卡死等 gate 兜底
const CARD_SEND_TIMEOUT_MS = 30_000;

/** 发卡类 gateway 调用超时包装：到点或失败均回落 fallback（永不 reject），调用方据此降级 */
function raceFallback<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/** plan 卡片按钮文案（toast 用） */
const PLAN_DECISION_TEXT: Record<Extract<CardDecision, `plan-${string}`>, string> = {
  'plan-approve': '计划已批准，开始执行（后续写操作免确认）',
  'plan-revise': '修改意见已提交',
  'plan-reject': '计划已放弃',
  // plan-view-file 不消费挂起项，仅 toast「正在重新发送计划内容卡片…」——文案不在此出现，留口供编译期完整性
  'plan-view-file': '',
};

/**
 * 运行期文档落盘（plan 方案 / 超长回复共用）：CONFIG_DIR 下按子目录 + 时间戳 + 工作区
 * slug 命名，返回文件路径；写盘失败返回 ''（调用方回退降级行为，不影响主流程）
 */
function writeRuntimeMarkdown(subDir: string, slugBase: string, content: string, logTag: string): string {
  const dir = join(CONFIG_DIR, subDir);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = (slugBase || subDir).replace(/[^\w-]+/g, '_').slice(0, 32);
  const filePath = join(dir, `${ts}-${slug}.md`);
  try {
    writeFileSync(filePath, content, 'utf8');
    return filePath;
  } catch (e) {
    console.error(logTag, e);
    return '';
  }
}

interface ChannelRuntime {
  queue: Promise<void>;
  abort?: AbortController;
  /** 当前是否有任务在执行（executeTask 入口置位、finally 清空）——enqueue 据此判断是否提示排队 */
  busy?: boolean;
  /** 待执行任务计数（busy 时入队自增、每个任务 finally 递减）：排队提示的位次来源 */
  queuedCount?: number;
  /** 代际计数：/new 时自增；enqueue 捕获当前值传入 executeTask；不匹配则 no-op（丢弃旧代际排队消息） */
  epoch?: number;
  /** 指针代际：任何 currentSessionId 变更（/new、/resume <n>、/ws use）时自增。
   *  与 epoch 分工：epoch 会丢弃旧代际排队消息（/new 才有此语义）；pointerGen 只用于
   *  「任务收尾归档是否回写指针」——executeTask 抓指针时快照，收尾不匹配则只入历史
   *  不覆盖指针（否则 /new 后被中止任务的迟到归档会把指针写回旧会话，下个任务又续接它） */
  pointerGen?: number;
}

export interface BridgeDeps { // 全部可注入，测试用 mock；生产用真实实现
  gateway: {
    start(h: GatewayHandlers): Promise<void>;
    sendCardTo(chatId: string, card: unknown): Promise<string>;
    sendTextTo(chatId: string, markdown: string): Promise<string>;
    updateCard(id: string, card: unknown): Promise<void>;
    uploadAndSendFile(chatId: string, p: string): Promise<void>;
    /** 上传图片并发带 caption 的卡片（lcb-notify 逐张发图用）；可选——旧 gateway/测试 mock 缺省走降级 */
    sendImageTo?(chatId: string, p: string, caption?: string): Promise<string>;
    /** 撤回消息（进度卡沉底）；可选——缺省时沉底退化为仅重刷 */
    deleteCard?(id: string): Promise<void>;
    /** 卡片实体模式（cardkit）：进度卡专用，支持局部更新保 form 输入；可选——缺省降级整卡 PATCH */
    sendCardEntityTo?(chatId: string, card: unknown): Promise<{ messageId: string; cardId: string }>;
    /** 卡片实体局部更新（batch_update）；可选 */
    partialUpdateCardElements?(cardId: string, sequence: number, actions: unknown[]): Promise<void>;
    /** 卡片实体全量替换；可选 */
    replaceCardEntity?(cardId: string, sequence: number, card: unknown): Promise<void>;
    /** 按 open_id 主动私聊发文本卡（配对码私发管理员）；可选——缺省时配对通知仅留日志 */
    sendTextToUser?(openId: string, markdown: string): Promise<string>;
    /** 批量解析 open_id → 飞书姓名（配对流程展示真名）；可选——缺省时降级显示原始 id */
    resolveUserNames?(openIds: string[]): Promise<Map<string, string>>;
  };
  access: AccessControl;
  store: SessionStore;
  executor: typeof runTask;
  /** 对话落盘记录器（可选依赖：缺失即不落盘，写失败自身消化不抛出） */
  transcript?: TranscriptRecorder;
  /** 安全面审计（可选依赖：deny/脱敏/金丝雀事件落盘；缺失时仅控制台日志） */
  audit?: SecurityAuditWriter;
  /** 长期记忆（可选依赖，§6.6 B1）：探活/ns 映射/user key 缓存。与消息路径正交——env 下发与
   *  插件注入由 config.memory 每任务现读驱动，缺失此依赖不影响记忆生效，仅无健康状态可查 */
  memory?: MemoryProvider;
}

// ENABLE_TOOL_SEARCH 显式开启会加剧核心工具 defer 进 ToolSearch（开场工具清单更不完整），
// 第三方模型（GLM 等）更易误判「没有 Bash/Skill」而拒绝执行。启动预检 warn-once（每 app 一次；
// 检测合并后的任务 env，覆盖 claude.env / app.env / 系统环境变量三个来源）
const toolSearchWarned = new Set<string>();
function warnIfToolSearchEnabled(appName: string, env: Record<string, string | undefined>): void {
  if (toolSearchWarned.has(appName)) return;
  const v = env.ENABLE_TOOL_SEARCH;
  if (v !== undefined && String(v).toLowerCase() === 'true') {
    toolSearchWarned.add(appName);
    console.warn(
      `[app:${appName}] 任务环境变量 ENABLE_TOOL_SEARCH=true：核心工具（Bash/Read/Skill 等）会被延迟注册，`
      + '模型可能声称没有工具而拒绝执行；如无必要请在 claude.env / 应用环境变量 / 系统环境变量中移除该键',
    );
  }
}

export function createBridge(
  config: BridgeConfig,
  app: FeishuAppConfig, // 本 bridge 绑定的飞书应用：并发/默认工作区/Claude Code 环境/人格均 per-app
  deps: BridgeDeps,
  opts: { confirmTimeoutMs?: number; cardSendTimeoutMs?: number; reloadConfig?: () => string | void | null } = {}, // 测试可注入更短的确认等待窗 / 发卡超时 / 自定义配置重载（返回错误消息则聊天内显式提示）
): GatewayHandlers & {
  /** 测试/诊断入口：返回通道当前挂起的内嵌 plan / question requestId */
  _pendingAsk(channelKey: string): { planId?: string; questionId?: string };
} {
  const sem = new Semaphore(app.concurrency ?? config.concurrency);
  const tag = `[app:${app.name}]`;
  // Claude 配置目录双模式：inherit（缺省）共享本机 ~/.claude（settingSources 含 user，
  // 模型设置/登录态/user MCP/skills 自动继承）；managed 指向 bridge 自管目录（认证/模型由
  // config claude 段写入 settings.json，无需本机 claude login）。
  // 子进程 env 不再此处定稿：每任务经 buildTaskEnv 现读（apps[].env / claude.env 热生效），
  // 优先级 process.env < CLAUDE_CONFIG_DIR < claude.env(过滤领土键) < app.env，其余变量
  // （ANTHROPIC_* 凭证、代理等）原样透传
  const claudeDir = resolveClaudeDir(config);
  // 启动预检：认证来源全落空（env 无 token、配置目录无登录态）时提前 warn，
  // 免得用户配好机器人才发现每条消息都报 Not logged in（真判定仍在 CLI 侧）
  const precheckEnv = buildTaskEnv(config, app, claudeDir);
  warnIfNoClaudeAuth(app.name, precheckEnv, claudeDir, {
    managed: config.claude?.mode === 'managed',
    serverUrl: serverUrl(config),
  });
  warnIfToolSearchEnabled(app.name, precheckEnv);
  // 会话清单缓存（SDK init 消息）：按工作区键存——project 级 .mcp.json/skills 随工作区不同，
  // 任一通道跑过一次该工作区即可供 /skills /plugins /mcp /model 渲染。进程内存，重启后清空
  const inventories = new Map<string, SessionInventory>();
  const runtimes = new Map<string, ChannelRuntime>();
  // 通道级权限闸：「本次会话不再询问」的记忆跨任务生效（spec：直至 /new），
  // 故 gate 归通道持有而非每任务新建——每任务新建会把授权缩成任务级，任务 B 又要重新确认
  const gates = new Map<string, PermissionGate>();
  const confirmPending = new Map<string, {
    resolve: (d: PermissionDecision) => void;
    req: ConfirmationRequest;
    ownerId: string;
    channelKey: string;
    /** 决策落定（用户点击或超时清理前）后的收尾钩子：清除进度卡内嵌确认区并刷新状态行 */
    onSettled: (d: PermissionDecision) => void;
  }>();
  // plan 确认挂起项：requestId → 等待中的计划决策（plan-approve/revise/reject）。
  // v5 审批表单在独立确认卡上（buildPlanConfirmCard，紧跟方案正文直发），回调按 requestId 定位挂起项
  const planPending = new Map<string, {
    resolve: (r: PlanAskResult) => void;
    req: PlanCardRequest;
    ownerId: string;
    channelKey: string;
    chatId: string;
  }>();
  // 独立计划确认卡（requestId → messageId）：决策/超时后整卡收口为灰色终态卡（按钮消失防重复点击）
  const planConfirmCards = new Map<string, string>();
  /** 收口独立计划确认卡（best effort：更新失败仅落日志，不影响流程） */
  function settlePlanConfirmCard(requestId: string, text: string): void {
    const mid = planConfirmCards.get(requestId);
    if (!mid) return;
    planConfirmCards.delete(requestId);
    void deps.gateway.updateCard(mid, buildPlanSettledCard(text, config.card?.width ?? 'default'))
      .catch((e) => console.warn(tag, '[计划确认卡收口失败]（不影响流程）:', e instanceof Error ? e.message : e));
  }
  // 计划正文两段式多卡直发（与下方「结果回传两段式」完全同构）：~3000 字/块，非尾卡走文本
  // 消息、尾卡走卡片，连发间隔 300ms 防飞书限流。planAsk 与 plan-view-file 回调（存量卡片
  // 残留按钮，重发即「再看一遍」）共用
  async function sendPlanContentCards(chatId: string, req: PlanCardRequest): Promise<void> {
    const chunks = chunkText(req.plan);
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 300));
      if (i === total - 1) {
        await deps.gateway.sendCardTo(chatId,
          buildPlanTailCard(req, chunks[i], { index: total, total }, config.card?.width ?? 'default'));
      } else {
        await deps.gateway.sendTextTo(chatId, `${planChunkHeader(req, i + 1, total)}\n\n${chunks[i]}`);
      }
    }
  }
  // 提问挂起项：requestId → 等待中的问题答案（qa-pick 逐项收集，qa-submit 一次性 resolve）。
  // 嵌入主卡片后无 cardId，改带 channelKey 定位活跃进度卡
  const qaPending = new Map<string, {
    resolve: (r: AskQuestionResult) => void;
    req: QuestionCardRequest;
    ownerId: string;
    channelKey: string;
    chatId: string;
    answers: QuestionCardAnswers;
  }>();
  // 工作区切换卡挂起项（裸 /ws）：requestId → 发卡上下文。「无 Promise 挂起」的常驻条目，
  // 仅用于：发起记录、切换落盘目标通道（channelKey）、工作区快照（回调按
  // 名查找目标）。stale 失效语义：同通道后发的新卡上完成切换后，旧卡点击一律回「已过期」——
  // 否则旧卡显示的当前项是错的，用户会在旧卡上误切回旧工作区。上限 100 条删最老（防无界增长）
  const wsPending = new Map<string, {
    ownerId: string;
    channelKey: string;
    chatId: string;
    workspaces: Array<{ name: string; path: string }>;
    /** 发卡时的当前工作区（跟随默认未显式切换时 channelState 无 workspaceName，兜底判定用） */
    currentName: string;
    stale: boolean;
  }>();
  // 通道当前任务的进度卡：gate 的 ask/planAsk/askQuestion 闭包随 gate 通道级复用，
  // 不能捕获任务级 progress 实例（会是首个任务的旧卡）——经此间接引用每次任务的新卡
  const activeProgress = new Map<string, ProgressCard>();
  // 当前存活 query 的 MCP 状态拉取句柄（executor onQuery 注入、任务 finally 删除）：
  // /mcp 命令在任务运行中经此实时拉取；句柄随 query 结束失效，调用侧须 catch
  const activeQueries = new Map<string, { wsName: string; handle: { mcpServerStatus(): Promise<McpServerStatus[]> } }>();
  // 通道级 notify sender 槽（生命周期方案 A2）：常驻进程复用 spawn 时的 lcb-notify server
  // 实例，发送目标（chatId 绑定 + sentPaths）经槽每任务换绑——同通道 FIFO 串行保证换绑
  // 总在上一轮发送完成后发生
  const notifySlots = new Map<string, NotifySenderSlot>();
  // 触发词两段式（ask_detail）等待补充的挂起项：channelKey → 命中规则与原始消息。
  // 命中「需补充」规则时先追问不入队；同用户下一条非 / 消息视作补充内容，与 rewrite 合并后入队。
  // 超时（SUPPLEMENT_WAIT_MS）自动失效走原流程；任意本地命令（cmd.handled）即取消等待——
  // /stop /new 天然是逃生口，与「本地命令永远优先」原则一致；指向本地命令的触发词
  // （关键词形态如「结束会话」→/stop）在补充拦截处同样放行，不被误吞作补充
  const supplementPending = new Map<string, {
    rule: TriggerRule;
    /** 命中触发词的原始消息（合并时作为前缀，补充内容视作其参数） */
    originalText: string;
    userId: string;
    at: number;
  }>();
  /** 补充等待窗口：超时后挂起项失效，下一条消息照常走原流程（不提示、静默过期） */
  const SUPPLEMENT_WAIT_MS = 10 * 60_000;
  // 配置热重载失败提示的去重标记：失败状态只在「成功 → 失败」跳变时向当前聊天提示一次，
  // 避免配置持续损坏期间每条消息都刷屏；恢复成功后静默复位（不发恢复消息）
  let reloadFailNotified = false;
  /** 配对码私发管理员的节流表（appId:userId → 上次通知时刻）：申请码 15 分钟复用，通知 5 分钟一次 */
  const pairNotifyAt = new Map<string, number>();

  function workspacePath(name: string): string {
    return config.workspaces.find((w) => w.name === name)?.path ?? config.workspaces[0].path;
  }
  /** 配置页管理的 MCP（#12）：bridge 自管 mcp/servers.json 每任务现读注入 SDK（改配置即热生效，
   *  无须重启）。notify 名固定后展开防被用户配置同名覆盖；文件缺失/损坏返回空（配置页写坏
   *  不应拖垮任务执行） */
  function loadBridgeMcpServers(): Record<string, Record<string, unknown>> {
    return readMcpServersFromJsonFile(BRIDGE_MCP_JSON).servers;
  }

  /** 通道内串行入队（每 key 一条 Promise 链），全局并发由 Semaphore 限制。
   *  有任务在跑时新消息静默 FIFO 排队——不提示的话用户不知道消息已被接收，会反复重发或误以为丢失。
   *  queuedCount 计「等待中」消息数：enqueue 一律自增（含首位），executeTask 启动时递减（该条离开队列）。
   *  /new 通过 epoch 代际丢弃旧排队消息：enqueue 捕获当前 epoch 传入 executeTask，不匹配则 no-op */
  function enqueue(key: string, msg: IncomingMessage, prompt: string, wsName: string): void {
    const rt = runtimes.get(key) ?? { queue: Promise.resolve() };
    if (rt.epoch === undefined) rt.epoch = 0; // 旧状态无 epoch 字段的运行期兜底
    if (rt.pointerGen === undefined) rt.pointerGen = 0;
    runtimes.set(key, rt);
    rt.queuedCount = (rt.queuedCount ?? 0) + 1;
    if (rt.busy) {
      void deps.gateway.sendTextTo(msg.chatId, `当前有任务在运行，本条消息已排队（第 ${rt.queuedCount} 位），完成后自动开始`)
        .catch(() => {}); // 提示失败静默：不影响任务本身入队
    }
    const myEpoch = rt.epoch; // 闭包捕获本条消息入队时的代际；executeTask 据此判断是否被 /new 作废
    rt.queue = rt.queue.then(() => executeTask(key, msg, prompt, wsName, myEpoch)).catch((e) => {
      console.error(tag, '[任务异常]', e);
    });
  }

  async function handleIncoming(msg: IncomingMessage): Promise<void> {
    try {
      await processMessage(msg);
    } catch (e) {
      // 长驻进程兜底：单条消息处理失败不允许成为 unhandled rejection 拖垮整个桥接器
      console.error(tag, '[消息处理异常]', msg.messageId, e);
    }
  }

  async function processMessage(msg: IncomingMessage): Promise<void> {
    const key = channelKey(msg.chatId, msg.userId);
    // 0.（已移除）收尾文件清单卡与「回复纯数字查 diff」链路整体下线（用户反馈：清单卡不需要）。
    // 数字消息不再被拦截，按普通任务进模型；明确要文件本体时由模型侧 send_file 工具按意图判断
    // 1. 访问控制：白名单外首个使用者自动成为 admin（免配对），其后未知用户发配对码
    // 每条消息先重读 access.json：lcb pair / 运行终端等独立进程批准写盘后，
    // 长存的内存实例不 reload 会查到旧白名单 → 反复发配对码且整盘覆写抹掉新用户（死循环）
    deps.access.reload();
    // 配置热重载：lcb ws add/remove 独立进程写盘后，本实例下一条消息即读到新工作区。
    // 读取失败沿用旧值继续跑（reloader 容错语义），但必须在用户侧显式提示——静默失败会让
    // 「下一条消息热生效」变成「永不生效直到重启」且无从诊断。仅状态跳变时提示一次防刷屏
    const reloadErr = opts.reloadConfig?.() ?? null;
    if (reloadErr) {
      console.warn('[配置热重载] 读取失败，沿用旧配置：', reloadErr);
      if (!reloadFailNotified) {
        reloadFailNotified = true;
        await deps.gateway.sendTextTo(msg.chatId,
          `配置热重载失败，本次沿用上次配置（修复 config.yaml 后下一条消息自动恢复）：${reloadErr}`)
          .catch(() => { /* 提示发送失败不阻断消息循环，错误已留日志 */ });
      }
    } else {
      reloadFailNotified = false;
    }
    if (!deps.access.isAllowed(msg.userId)) {
      // 真名解析先行（contact 直查 + 兄弟应用桥，命中落共享磁盘缓存）：access.json 一律落
      // 真名而非 ou_ 串——接入申请列表/私聊通知/会话页才能处处显示真名（主人拍板 2026-10-18）
      const resolved = deps.gateway.resolveUserNames
        ? await deps.gateway.resolveUserNames([msg.userId]).catch(() => new Map<string, string>())
        : new Map<string, string>();
      const resolvedName = resolved.get(msg.userId) || msg.userId;
      if (app.role === 'deputy') {
        // 分身机器人艾特即用（用户决策）：不走配对——首条消息自动补录 member（access.json
        // 保留审计记录，isAllowed 后续校验天然兼容）；无 admin 权限，
        // 管理命令与工作区切换在各自入口被拒，能力范围由分身配置限定
        deps.access.addUser(msg.userId, resolvedName, 'member', app.appId);
        console.log(`${tag}[接入] 分身应用 ${app.appId} 新用户 ${msg.userId}（${resolvedName}）已自动加入（member，能力按分身配置限定）`);
        // 不 return：本条消息照常进入命令/任务处理
      } else if (!deps.access.hasUsers(app.appId)) {
        // 首个使用者免配对直接成为 admin——按应用判定：多应用部署下 open_id 按应用隔离，
        // 新应用的第一个使用者同样是「首个」，不应因别的应用已有用户而被配对码拦住
        deps.access.addUser(msg.userId, resolvedName, 'admin', app.appId);
        console.log(`${tag}[接入] 应用 ${app.appId} 首位用户 ${msg.userId}（${resolvedName}）已自动成为 admin（后续用户需配对）`);
        await deps.gateway.sendTextTo(msg.chatId,
          `🎉 欢迎！你是本机器人的首位用户，已自动成为 **admin**。\n\n后续其他同事首次使用时需由你在桥接器终端批准配对（\`lcb pair <配对码>\`）。`);
        // 不 return：欢迎语之外，本条消息照常进入命令/任务处理
      } else {
        // 配对流程（主人拍板 2026-10-17）：申请码不再发到来话群/私聊，群里只提示联系管理员；
        // 码私聊发给当前配置的管理员（该应用最早成为 admin 的用户=首个使用者），由他在配置页
        // 「权限 → 接入申请」授权（也可不授权），终端 lcb pair 双通道保留
        const admin = deps.access.primaryAdmin(app.appId);
        const adminName = admin ? (resolved.get(admin.userId) || (admin.name && !admin.name.startsWith('ou_') ? admin.name : '管理员')) : '管理员';
        const code = deps.access.beginPairing(msg.userId, resolvedName, app.appId);
        console.log(`${tag}[配对] 未知用户 ${msg.userId}（${resolvedName}）请求接入，配对码：${code}（管理员 ${admin ? admin.userId : '无'} 终端 lcb pair ${code} 或配置页授权）`);
        // 群/私聊来话只提示联系管理员，不出现配对码（防群里围观者拿码扰局）
        await deps.gateway.sendTextTo(msg.chatId,
          `🚫 你暂无权使用本机器人，需管理员「${adminName}」授权。\n请通过飞书联系他，由管理员在配置页「权限 → 接入申请」为你授权后即可使用。`)
          .catch(() => { /* 提示发送失败不阻断 */ });
        // 码私发管理员；同一申请 5 分钟内不重复骚扰（beginPairing 复用码，通知侧节流）
        if (admin) {
          const last = pairNotifyAt.get(`${app.appId}:${msg.userId}`) ?? 0;
          if (Date.now() - last > 5 * 60_000) {
            pairNotifyAt.set(`${app.appId}:${msg.userId}`, Date.now());
            if (deps.gateway.sendTextToUser) {
              await deps.gateway.sendTextToUser(admin.userId,
                `🔐 收到新的接入申请\n\n申请人：${resolvedName}\n机器人：${app.name}\n配对码：**${code}**（15 分钟内有效）\n\n请到配置页「权限 → 接入申请」点击授权（不同意可忽略，申请 15 分钟后自动过期）；也可在桥接器终端执行 \`lcb pair ${code}\` 批准。`)
                .catch((e) => console.warn(`${tag}[配对] 私聊通知管理员失败（码已留日志与配置页）：`, e));
            }
          }
        }
        return;
      }
    } else {
      // 老版本 access.json 的用户记录没有 appId：按当前来路补登，
      // 保证 hasUsers(appId) 的按应用统计对存量用户同样成立
      deps.access.ensureAppId(msg.userId, app.appId);
    }
    // 2. 命令：/help /new /resume /stop /status /ws
    const st = deps.store.getChannelState(key);
    // currentWorkspace 语义：store 中已设置的工作区优先，否则 app 默认，最后全局默认——
    // 保证 /new、/status 回复与实际一致。用 || 而非 ??：archiveSession 为新通道建档时
    // workspaceName 存 ''（归档时不知工作区），空串必须回退默认，否则 inventory 键错位。
    // 分身（deputy）白名单语义（2026-10-31 改版）：白名单 ≥2 项 = 白名单内可切换（state 中
    // workspaceName 在允许集合内则采信，越界/空回退集合首项）；1 项 = 锁定恒取首项；
    // 未配置 = 权限轴「全给」，同样按集合校验 state（防脏数据指向已删除工作区）。
    // 命令上下文、inventory 键与任务 wsName 同源，与 deputyWorkspacePolicy 判定口径一致
    const deputyPolicy = app.role === 'deputy' ? deputyWorkspacePolicy(app.allowedWorkspaces, config) : undefined;
    const currentWorkspace = deputyPolicy
      ? (deputyPolicy.allow.some((w) => w.name === st?.workspaceName) ? st!.workspaceName! : deputyPolicy.allow[0]!.name)
      : (st?.workspaceName || app.defaultWorkspace || config.defaults.workspace);
    // 2.4 触发词两段式补充（ask_detail）：上一条消息命中「需补充」规则且正在等待时，本条
    // 非 / 消息（同一用户）视作补充内容——与原始消息拼接后对该规则重新改写：补充内容即
    // {args}（无占位符时按既有规则自动追加），零新合并逻辑。其他用户消息 / 斜杠消息 /
    // 本地命令的触发词（关键词形态如「结束会话」→/stop，与 / 原文同样优先）/ 超时挂起
    // 均不在此列，照常走原流程（挂起过期在下方静默清除）。
    // matchTrigger 提前到本段调用，2.5 复用同一结果
    const pendingSup = supplementPending.get(key);
    if (pendingSup && Date.now() - pendingSup.at > SUPPLEMENT_WAIT_MS) supplementPending.delete(key);
    const trimmedText = msg.text.trim();
    const hit = matchTrigger(msg.text, app.triggers);
    if (pendingSup && !trimmedText.startsWith('/')
        && !(hit && isLocalCommandRewrite(hit.rule.rewrite))
        && msg.userId === pendingSup.userId) {
      supplementPending.delete(key);
      const combined = `${pendingSup.originalText} ${trimmedText}`;
      // 斜杠形态合并后首 token 仍命中，matchTrigger 原路返回；关键词形态已改全内容精确匹配，
      // 合并文本必然不再等于 match（重新匹配得 null 会把改写模板整个丢掉），?? 直接对规则套
      // 模板（{text}/{args}=合并全文，与命中时的替换语义一致）。
      // 关键词形态的改写不含补充内容（matchTrigger 仅斜杠形态自动追加 args）——补充是本次
      // 合并的核心增量，改写结果里没有就显式拼到末尾，绝不把用户刚给的链接/要求吞掉
      const finalPrompt = rewriteByTrigger(combined, [pendingSup.rule]) ?? applyRuleRewrite(pendingSup.rule, combined);
      const merged = finalPrompt.includes(trimmedText) ? finalPrompt : `${finalPrompt} ${trimmedText}`;
      await deps.gateway.sendTextTo(msg.chatId, '已收到补充，任务开始');
      enqueue(key, msg, merged, currentWorkspace);
      return;
    }
    // 2.5 触发词映射：改写结果统一回灌 handleCommand 走同一条优先级链——rewrite 可指向
    // bridge 本地命令（飞书菜单「新会话」→ match=新会话, rewrite=/new），此时本地执行而非
    // 当任务透传（Claude Code 侧没有该命令，headless 只会报未知命令错误）；改写成技能/插件
    // 命令或普通 prompt 时 handleCommand 不识别 → taskText 原样带出，文末照旧入队。
    // 本地命令原文（/stop 等）matchTrigger 直接放行返回 null，不会被劫持
    const triggered = hit?.rewritten ?? null;
    const effectiveText = triggered ?? msg.text;
    const cmd = await handleCommand(effectiveText, {
      channelKey: key,
      store: deps.store,
      config,
      appName: app.name,
      // 管理命令闸（ctx.isAdmin 唯一入口，/ws use、/model-profile、/plugin 变更类经此流经）：
      // 分身机器人一律 false——管理面（工作区/模型档案/插件）全局共享，分身用户不该触碰，
      // 连 admin 本人艾特分身也不放行（要用管理命令请找主机器人）
      isAdmin: app.role !== 'deputy' && deps.access.isAdmin(msg.userId),
      isDeputy: app.role === 'deputy',
      // 分身工作区白名单原样透传（deputyWorkspacePolicy 判定用）；未配置为 undefined = 全给
      allowedWorkspaces: app.allowedWorkspaces,
      currentWorkspace: () => currentWorkspace,
      getInventory: () => inventories.get(`${app.appId}:${currentWorkspace}`),
      // /mcp 实时拉取：当前工作区有存活 query 才有实时数据（5s 超时），否则回退 init/收尾快照
      getLiveMcpStatus: async () => {
        try {
          for (const { wsName: w, handle } of activeQueries.values()) {
            if (w !== currentWorkspace) continue;
            return await raceFallback<McpServerStatus[] | null>(handle.mcpServerStatus(), 5000, null);
          }
        } catch { /* 句柄随 query 结束失效等：回退快照 */ }
        return null;
      },
      // /plugin 插件管理依赖：claudeConfigDir = 双模式解析的当前生效目录；userClaudeDir = 本机
      // ~/.claude（managed 模式下作为第二来源 + install 默认目标）；结果回传 = 当前聊天
      claudeConfigDir: claudeDir,
      userClaudeDir: DEFAULT_CLAUDE_DIR,
      send: async (md) => { await deps.gateway.sendTextTo(msg.chatId, md); },
      stopCurrentTask: () => {
        const rt = runtimes.get(key);
        if (rt?.abort) { rt.abort.abort(); return true; }
        return false;
      },
    });
    if (cmd.handled) {
      // 本地命令处理即取消两段式补充等待（/stop /new 天然逃生口，见 supplementPending 定义）——
      // 不清会让等待期后的下一条普通消息被错误当成「补充」合并入队
      supplementPending.delete(key);
      if (cmd.card) {
        // 交互卡片命令（裸 /ws）：发卡并注册挂起项供回调切换。快照工作区清单——回调按
        // 名查找目标，配置热重载改清单不影响已发出卡片的自洽性
        const requestId = cmd.cardRequestId ?? randomUUID();
        wsPending.set(requestId, {
          ownerId: msg.userId,
          channelKey: key,
          chatId: msg.chatId,
          workspaces: config.workspaces.map((w) => ({ name: w.name, path: w.path })),
          currentName: currentWorkspace,
          stale: false,
        });
        // 上限 100 条删最老（Map 迭代序 = 插入序，首个即最老），防长期运行无界增长
        if (wsPending.size > 100) {
          const oldest = wsPending.keys().next().value;
          if (oldest !== undefined && oldest !== requestId) wsPending.delete(oldest);
        }
        // 发卡失败（卡片 schema 被飞书拒绝 / WS 偶发无响应挂起）降级文本清单——裸 /ws 的
        // 唯一响应形态是卡片，静默吞错在用户侧就是「命令没反应」。raceFallback 同时覆盖
        // 抛错与挂起（见 CARD_SEND_TIMEOUT_MS 注释），失败时 /ws use 文本命令兜底可用
        const cardSent = await raceFallback(
          deps.gateway.sendCardTo(msg.chatId, cmd.card).then(() => true, (e: unknown) => {
            console.error(tag, '[/ws] 工作区卡片发送失败，降级为文本列表', e,
              'code=', (e as { code?: number })?.code, 'msg=', (e as { msg?: string })?.msg);
            return false;
          }),
          CARD_SEND_TIMEOUT_MS,
          false,
        );
        if (!cardSent) {
          wsPending.delete(requestId); // 卡未发出绝无回调，清挂起防占位
          await deps.gateway.sendTextTo(
            msg.chatId,
            `**工作区列表**（当前：**${currentWorkspace}**）\n${workspaceListMarkdown(config.workspaces, currentWorkspace)}`
              + '\n\n工作区卡片发送失败（详见桥接器日志），已降级为文本。切换：`/ws use <名字>`',
          ).catch(() => { /* 文本也失败（连接断开等）：原错误已留日志，不再冒泡打断消息循环 */ });
        }
      } else if (cmd.reply) {
        await deps.gateway.sendTextTo(msg.chatId, cmd.reply);
      }
      // 指针变更代际 bump：/new、/resume <n>、/ws use 都改写了 currentSessionId——
      // 运行中/收尾窗口内任务的迟到归档据 pointerGen 放弃回写指针（archive 闭包比对）。
      // 同时作废该通道的常驻进程：换了续接目标，旧进程的会话上下文不再适用（忙进程不动，
      // 运行中任务的中止由 /new 的 abort 负责，abort 会连带杀进程）
      if (cmd.pointerTouched) {
        const rt = runtimes.get(key);
        if (rt) rt.pointerGen = (rt.pointerGen ?? 0) + 1;
        killResidentSession(`${app.appId}:${key}`);
      }
      // /new 开启新会话：
      // 1) 清空旧代际排队消息（epoch 自增，旧任务入 executeTask 即 no-op）
      // 2) abort 正在执行的任务
      // 3) 结算本用户挂起的 confirm/plan/qa 条目（按取消/拒绝处理：对话继续推进或被放弃）
      // 4) 通道级权限闸 reset（spec：「本次会话不再询问」的记忆跨任务生效，直至 /new）
      // 5) 汇总已取消的排队消息数（用户能看到新建会话的真实影响面）
      // ——handleCommand 无权访问 wiring 的 runtime/pending map，统一在 wiring 侧做
      // 以生效文本判定（触发词改写出的 /new 同样适用，如菜单「新会话」）——
      // 否则菜单触发的新会话只清指针，排队消息/运行中任务/挂起条目全不清理，与手敲 /new 分叉
      if (/^\/new(?:\s|$)/.test(effectiveText.trim())) {
        const rt = runtimes.get(key);
        const cancelled = rt?.queuedCount ?? 0;
        if (rt) {
          rt.epoch = (rt.epoch ?? 0) + 1;
          rt.queuedCount = 0; // 旧代际消息在 executeTask 入口 no-op，不会再 decrement；此处一次性清零即可
          if (rt.abort) rt.abort.abort();
        }
        for (const [id, p] of confirmPending) {
          if (p.channelKey !== key) continue;
          confirmPending.delete(id);
          p.resolve('deny');
        }
        for (const [id, p] of planPending) {
          if (p.channelKey !== key) continue;
          planPending.delete(id);
          p.resolve({ action: 'reject' });
        }
        for (const [id, p] of qaPending) {
          if (p.channelKey !== key) continue;
          qaPending.delete(id);
          p.resolve({});
        }
        gates.get(key)?.reset();
        if (cancelled > 0) {
          await deps.gateway.sendTextTo(msg.chatId, `已因新建会话取消 ${cancelled} 条排队消息`);
        }
      }
      return;
    }
    // 3. 普通文本：通道内串行入队（每 key 一条 Promise 链），全局并发由 Semaphore 限制。
    // cmd.taskText = handleCommand 未识别时原样带出的文本（触发词改写结果或原文）
    if (triggered !== null && hit) {
      // 两段式触发（ask_detail）：命中「需补充」规则先挂起追问、不入队——本通道同用户的
      // 下一条非 / 消息在 2.4 被视作补充合并入队（超时 / 本地命令取消，见 supplementPending）。
      // rewrite 指向本地命令的规则防呆跳过：/new 这类命令无参数可补，追问只会挡住命令执行
      if (hit.rule.askDetail && !isLocalCommandRewrite(hit.rule.rewrite)) {
        supplementPending.set(key, { rule: hit.rule, originalText: trimmedText, userId: msg.userId, at: Date.now() });
        await deps.gateway.sendTextTo(msg.chatId,
          `已命中触发词「${hit.rule.match}」，请直接回复补充内容（如目标链接、具体要求），我会合并后开始任务（10 分钟内有效；发 /stop 取消）`);
        return;
      }
      await deps.gateway.sendTextTo(msg.chatId, '已按触发词转入对应技能流程');
    }
    enqueue(key, msg, cmd.taskText ?? msg.text, currentWorkspace);
  }

  async function executeTask(key: string, msg: IncomingMessage, prompt: string, wsName: string, myEpoch: number): Promise<void> {
    const rt = runtimes.get(key)!;
    // /new 丢弃旧代际：静默 no-op（不入队列、不 decrement、不建进度卡；汇总条数已在 /new 时回）
    if (myEpoch !== (rt.epoch ?? 0)) return;
    rt.busy = true; // enqueue 据此给后续消息发「已排队」提示（sem 等待期同样算占用）
    rt.queuedCount = Math.max(0, (rt.queuedCount ?? 1) - 1); // 本条离开等待队列开始执行
    const release = await sem.acquire();
    const abort = new AbortController();
    rt.abort = abort;
    const progress = new ProgressCard(
      {
        sendCard: (c) => deps.gateway.sendCardTo(msg.chatId, c),
        updateCard: (id, c) => deps.gateway.updateCard(id, c),
        deleteCard: deps.gateway.deleteCard
          ? (id) => deps.gateway.deleteCard!(id)
          : undefined,
        sendCardEntity: deps.gateway.sendCardEntityTo
          ? (c) => deps.gateway.sendCardEntityTo!(msg.chatId, c)
          : undefined,
        partialUpdateCard: deps.gateway.partialUpdateCardElements
          ? (cardId, seq, actions) => deps.gateway.partialUpdateCardElements!(cardId, seq, actions)
          : undefined,
        replaceCard: deps.gateway.replaceCardEntity
          ? (cardId, seq, c) => deps.gateway.replaceCardEntity!(cardId, seq, c)
          : undefined,
      },
      `任务 · ${wsName}`,
      // card.width / card.stack_max 热生效：每任务现读 config（与同款「同对象 mutate 即生效」
      // 语义一致）；channelKey 供工作动态展开/收起按钮回调定位本卡（回调 value 携带）
      { cardWidthMode: config.card?.width ?? 'default', channelKey: key, stackMax: config.card?.stackMax },
    );
    const confirmTimeoutMs = opts.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    const cardSendTimeoutMs = opts.cardSendTimeoutMs ?? CARD_SEND_TIMEOUT_MS;
    // 通道级复用：已存在则沿用（allow-session 记忆跨任务），不存在才建。
    // 白名单/黑名单经 getter 传入：gate 虽按通道永久复用，decide 时才经 getter 现读
    // config.permissions——热重载原地 mutate 同一 config 对象后，已有通道的下一个工具
    // 调用即生效（不再需要新通道/重启；0.17.0 静态快照导致改配置后旧通道不生效）
    // 分身安全闸（R1/R2/Bash 三态）：仅 deputy 注入，主机器人行为零变化
    const securityGuard = app.role === 'deputy'
      ? {
        cwd: workspacePath(wsName),
        // 入站附件豁免根：与 gateway 下载目录共用单源常量（config.ts INBOX_DIR）——用户发给 bot 的
        // 图片/文件必须可读可处理，属产品功能正确性；R1/Bash 探测豁免，R2 写边界不豁免
        inboxRoot: INBOX_DIR,
        redzone: () => config.security?.redzone?.read ?? DEFAULT_REDZONE_READ_SOURCES,
        // 未配置工作区白名单 = 权限轴全给：写根 = 全部已配置工作区（R2 红线仍在：工作区外只读）
        writeRoots: () => (app.allowedWorkspaces?.length ? app.allowedWorkspaces : config.workspaces.map((w) => w.name))
          .map((n) => workspacePath(n)),
        bashMode: () => app.bashMode ?? 'confirm',
      }
      : undefined;
    // 安全事件分流：审计落盘（always）+ 金丝雀向当前聊天告警（固定模板，节流在 gateway 侧）
    const onSecurityEvent = (ev: SecurityEvent): void => {
      deps.audit?.write(app.appId, ev);
      if (ev.kind !== 'canary') {
        console.warn(tag, '[安全拦截]', JSON.stringify(ev));
        return;
      }
      console.error(tag, '[安全告警] 🚨 金丝雀命中（防线疑似被穿透），已脱敏并告警');
      void deps.gateway.sendTextTo(msg.chatId, CANARY_ALERT_TEXT).catch(() => { /* 告警失败仅留日志 */ });
    };
    let gate = gates.get(key);
    if (!gate) {
      gate = new PermissionGate({
        allowTools: () => new Set(config.permissions?.allowTools ?? DEFAULT_ALLOW_TOOLS_LIST),
        // ?? 而非 ||：显式 false（用户主动关闭全部免确认）不能被回落到缺省的 true
        allowAllTools: () => config.permissions?.allowAllTools ?? DEFAULT_ALLOW_ALL_TOOLS,
        dangerousCommands: () => config.permissions?.dangerousCommands ?? DEFAULT_DANGEROUS_COMMANDS,
        ...(securityGuard ? { security: securityGuard } : {}),
        onSecurityEvent,
        ask: async (req) => {
          // 工具确认嵌入当前任务的进度卡（按钮在计时行上方、正文收敛）——不再单独发确认卡：
          // 独立确认卡与进度卡正文内容大量重复，且追加在进度卡下方会把进度卡顶出会话底部。
          // 经 activeProgress 现查当前任务的进度卡：gate 通道级复用，闭包不能捕获任务级实例。
          // 超时由本闭包自管：到点删除条目 + 清除确认区 + 以 deny 继续——条目有界
          // （无人点击、/stop、4h abort 挂起中的 ask 均会被定时器清理），迟到点击因条目
          // 已删被 toast 提示后忽略
          const progress = activeProgress.get(key);
          if (!progress) return 'deny';
          progress.setConfirm(req);
          return new Promise<PermissionDecision>((resolve) => {
            const gc = setTimeout(() => {
              confirmPending.delete(req.requestId);
              progress.setConfirm(undefined);
              progress.setStatus(`确认超时（${Math.round(confirmTimeoutMs / 60000)} 分钟未确认），已自动拒绝 \`${req.toolName}\`；模型重试时会再次请求`);
              resolve('deny');
            }, confirmTimeoutMs);
            gc.unref();
            const settle = (d: PermissionDecision) => {
              progress.setConfirm(undefined);
              progress.setStatus(DECISION_TEXT[d]);
            };
            confirmPending.set(req.requestId, {
              resolve: (d) => {
                clearTimeout(gc); // 用户已及时确认：撤销超时定时器
                resolve(d);
              },
              req,
              ownerId: msg.userId,
              channelKey: key,
              onSettled: settle,
            });
          });
        },
        // plan 确认（#3+#6，v5 动线：先方案、后确认）：计划正文两段式多卡直发（sendPlanContentCards）
        // → 独立橙色确认卡（buildPlanConfirmCard：方案要点摘要在上、审批表单在下）紧跟着发送——
        // 顺序即动线，不再依赖主卡内嵌表单 + 强制沉底保证顺序；主进度卡只维持等待阶段（header 变橙）。
        // 原文另落盘 claude/plans/ 归档（slug + 时间戳，方便 review 与 SOP 要求的本地归档）。
        // 超时由本闭包自管：到点收口确认卡 + clearPlan + resolve reject
        planAsk: async (req) => {
          const planReq: PlanCardRequest = { requestId: randomUUID(), plan: req.plan, workspaceName: req.workspaceName };
          // 落盘归档：文件名加时间戳避免并发冲突；失败仅影响归档，不影响直发与审批
          const planFilePath = writeRuntimeMarkdown(
            join('claude', 'plans'),
            req.workspaceName || 'plan',
            `# 执行计划 · ${req.workspaceName} · ${new Date().toLocaleString('zh-CN', { hour12: false })}\n\n${req.plan}\n`,
            `${tag}[计划归档落盘失败]（不影响流程）：`,
          );
          if (planFilePath) console.log(tag, `[计划归档] ${planFilePath}`);
          const progress = activeProgress.get(key);
          if (!progress) return { action: 'reject' }; // 进度卡不在 = 任务已结束/被 abort，按放弃处理
          progress.setPlan({ requestId: planReq.requestId, plan: req.plan, workspaceName: req.workspaceName });
          // 发卡放挂起开始前：raceFallback 兜底 WS 偶发挂起（此刻超时定时器尚未 arm，裸 await
          // 挂起即永不超时——同 ask 发卡约束）；raceFallback 永不 reject，失败/超时仅内部落日志，
          // 确认卡缺失时审批动线退化为「回复消息表态」，任务不卡死
          await raceFallback(sendPlanContentCards(msg.chatId, planReq), CARD_SEND_TIMEOUT_MS, undefined);
          const confirmCardId = await raceFallback(
            deps.gateway.sendCardTo(msg.chatId, buildPlanConfirmCard(planReq, config.card?.width ?? 'default')),
            CARD_SEND_TIMEOUT_MS, undefined,
          );
          if (confirmCardId) planConfirmCards.set(planReq.requestId, confirmCardId);
          return new Promise<PlanAskResult>((resolve) => {
            const gc = setTimeout(() => {
              planPending.delete(planReq.requestId);
              settlePlanConfirmCard(planReq.requestId, '已超时，自动放弃');
              progress.setPlan(undefined);
              progress.setStatus(`计划确认超时（${Math.round(confirmTimeoutMs / 60000)} 分钟未确认），已自动放弃；模型重新提交计划时会再次弹出`);
              resolve({ action: 'reject' });
            }, confirmTimeoutMs);
            gc.unref();
            planPending.set(planReq.requestId, {
              resolve: (r) => {
                clearTimeout(gc);
                resolve(r);
              },
              req: planReq,
              ownerId: msg.userId,
              channelKey: key,
              chatId: msg.chatId,
            });
          });
        },
        // 提问确认（#3）：AskUserQuestion 的选项 + 提交按钮全部嵌入主进度卡（#3 决策：彻底替换独立提问卡）。
        // qa-pick 仅 PATCH 选中态（卡片不刷新整卡，仅更新 answer map），qa-submit 一次性 resolve 并 clearQuestion
        askQuestion: async (req) => {
          const qaReq: QuestionCardRequest = {
            requestId: randomUUID(),
            questions: req.questions,
            workspaceName: req.workspaceName,
          };
          const answers: QuestionCardAnswers = {};
          const progress = activeProgress.get(key);
          if (!progress) return {}; // 进度卡不在 = 任务已结束/被 abort，按未作答处理
          progress.setQuestion({ requestId: qaReq.requestId, questions: req.questions, workspaceName: req.workspaceName, answers });
          // 不再 sinkToBottom：提问区嵌入主进度卡后，flush 自然 PATCH（v5 计划审批亦已改为独立确认卡，无需沉底配合）
          return new Promise<AskQuestionResult>((resolve) => {
            const gc = setTimeout(() => {
              qaPending.delete(qaReq.requestId);
              progress.setQuestion(undefined);
              progress.setStatus(`提问超时（${Math.round(confirmTimeoutMs / 60000)} 分钟未作答），已按未作答处理；模型自行决策或停下等待你的回复`);
              resolve({});
            }, confirmTimeoutMs);
            gc.unref();
            qaPending.set(qaReq.requestId, {
              resolve: (r) => {
                clearTimeout(gc);
                resolve(r);
              },
              req: qaReq,
              ownerId: msg.userId,
              channelKey: key,
              chatId: msg.chatId,
              answers,
            });
          });
        },
        timeoutMs: GATE_FALLBACK_TIMEOUT_MS,
      });
      gates.set(key, gate);
    }
    // 硬超时 abort 带 reason 标记：catch 侧据此与 /stop 区分停止文案
    const hardTimeout = setTimeout(() => abort.abort(new Error('hard-timeout')), TASK_HARD_TIMEOUT_MS);
    hardTimeout.unref();
    // lcb-notify 发送能力：chatId 硬绑定当前任务（权限闸直通的安全前提）；
    // sentPaths 记录中途已推送的文件，任务收尾的产出回传据此去重（用户已收过的不重发）。
    // 每次中途推送后进度卡沉底一次（删旧卡重发），保持「任务是否还在跑」始终可见于会话底部
    // SOP 开关：本任务级现读 config.session.notifySop（缺省 true），决定是否注入推送规范
    // 提示词（v2 为纯内容分类软约束；旧「>50 行转文件」硬兜底已移除，send_text 恒多卡）
    const sopEnabled = config.session?.notifySop !== false;
    // 工具可用性说明开关（缺省 true）：对抗 dynamic tool loading 下的「核心工具不存在」自查误判
    const toolHintEnabled = config.session?.toolHint !== false;
    const sentPaths = new Set<string>();
    const sink = async (): Promise<void> => { await activeProgress.get(key)?.sinkToBottom(); };
    // 槽式换绑（A2）：本任务的 sender（chatId 硬绑定 + sentPaths 去重集）挂进通道级槽——
    // 常驻进程复用 spawn 时的 lcb-notify server 实例，经 delegate 路由到槽内当前 sender
    let notifySlot = notifySlots.get(key);
    if (!notifySlot) {
      notifySlot = createNotifySenderSlot();
      notifySlots.set(key, notifySlot);
    }
    notifySlot.setSender(createGatewaySender({
      chatId: msg.chatId,
      sentPaths,
      sendText: async (c, md) => {
        await deps.gateway.sendTextTo(c, md);
        await sink();
      },
      ...(deps.gateway.sendImageTo
        ? {
          sendImageWithCaption: async (c: string, p: string, caption?: string) => {
            await deps.gateway.sendImageTo!(c, p, caption);
            await sink();
          },
        }
        : {}),
      sendFileTo: async (c, p) => {
        await deps.gateway.uploadAndSendFile(c, p);
        await sink();
      },
    }));
    activeProgress.set(key, progress);
    // 指针代际快照：任务运行期间 /new、/resume <n>、/ws use 都会 bump pointerGen，本任务
    // 收尾归档据此放弃回写指针（只入历史不覆盖用户选择）。定义在 try 外：catch 路径同样调用
    const myPointerGen = rt.pointerGen ?? 0;
    const archive = (sid: string | undefined | null): void => {
      if (!sid) return;
      deps.store.archiveSession(key, sid, prompt, {
        updatePointer: myPointerGen === (runtimes.get(key)?.pointerGen ?? myPointerGen),
      });
    };
    try {
      await progress.start();
      const state = deps.store.getChannelState(key);
      // A3 群聊会话自动滚动（双阈值，先到先滚，业务无感）：空闲超阈值（话题切换天然伴随
      // 时间间隔）或轮次满阈值（兜底单话题超长）→ 指针置 null——即 /new 的现成一行语义，
      // 本条消息就是新话题的首条。私聊不滚（手动 /new 管理最优）。滚动同样 bump epoch
      // 对齐 /new 语义：旧代际排队消息按「新建会话」丢弃（指针写保护已有 pointerGen 兜底）。
      // 有排队消息被丢弃时显式告知（静默吞用户消息不可接受）；滚动本身不发独立提示，
      // 仅在本条回复尾部带一次轻注记（见下方成功路径，可配置关闭）
      let rolled = false;
      if (msg.chatType === 'group') {
        const idleHours = config.session?.groupIdleResetHours ?? 4;
        const maxTurns = config.session?.groupMaxTurns ?? 30;
        const lastActiveMs = state?.lastActiveAt ? Date.parse(state.lastActiveAt) : NaN;
        const idleHit = idleHours > 0 && Number.isFinite(lastActiveMs) && Date.now() - lastActiveMs > idleHours * 3_600_000;
        const turnsHit = maxTurns > 0 && (state?.turnCount ?? 0) >= maxTurns;
        if (idleHit || turnsHit) {
          deps.store.setCurrentSession(key, null, state?.workspaceName || wsName); // turnCount 随之清零
          const rtRoll = runtimes.get(key);
          const dropped = rtRoll?.queuedCount ?? 0;
          if (rtRoll) {
            rtRoll.epoch = (rtRoll.epoch ?? 0) + 1; // 本条已过代际检查，继续执行；后续旧代际排队消息入口 no-op
            rtRoll.queuedCount = 0;
          }
          rolled = true;
          console.log(tag, `[滚动] ${idleHit ? `空闲超 ${idleHours}h` : `轮次满 ${maxTurns}`}，群聊自动开启新话题：${key}`);
          if (dropped > 0) {
            await deps.gateway.sendTextTo(msg.chatId, `已开启新话题，${dropped} 条排队消息按旧话题取消（/resume 可找回此前讨论）`)
              .catch(() => { /* 提示失败不阻断任务 */ });
          }
        }
      }

      // 续接指针三态：undefined=旧版存量数据 → 回退 sessions[0]（旧语义 sessions[0] 即当前）；
      // null=/new 或 /ws use 已清指针 → 新开会话；字符串 → resume 该会话。
      // 不能用 ??：null 会被 ?? 当成空值回退 sessions[0]，/new 的意图就被吞掉了。
      // 滚动刚把指针置 null：本条直接开新会话（rolled 分支不用再读盘）
      const pointer = rolled ? null : state?.currentSessionId;
      const resumeId = pointer === undefined ? state?.sessions?.[0]?.sessionId : pointer || undefined;
      const now = () => nowBeijingISO();
      // 落盘 · user：任务起点（prompt 全文 + resume 链上一轮 sessionId）
      deps.transcript?.user({
        v: 1, ts: now(), kind: 'user', app: app.appId,
        chatId: msg.chatId, userId: msg.userId, workspace: wsName, sessionId: resumeId, text: prompt,
      });
      // 任务级 env 现读构造（热生效）：apps[].env / claude.env 改动后下一条消息即用新值
      const taskEnv = buildTaskEnv(config, app, claudeDir);
      // 长期记忆 ns env（§6.4/§6.6）：memory.enabled 时每条消息拼装下发——OPENVIKING_USER 按
      // 消息级 userId 隔离（群聊同事话语不混入主人记忆；deputy 的 appId 天然不同即分身永不读
      // 主人记忆）。?? 保留既有值：apps[].env 手配 OPENVIKING_* = 专家覆盖口。关段 = 零注入，
      // 行为与无此段完全一致（可插拔验收）；常驻进程经配置指纹回收（env 变 → 指纹变 → 重建）。
      // 构 env 前先做身份新鲜度保障：identityMap 换绑/密钥重置后的第一条消息，必须等签发刷新
      // 落定、拿到与新映射一致的 key——否则 api_key 模式身份由 key 决定，会拿旧用户 key 把
      // 记忆静默写回旧 ns（快照一致时此调用零开销直返）
      if (config.memory?.enabled) {
        await deps.memory?.ensureFreshKeys();
        for (const [k, v] of Object.entries(memoryEnvFor(config.memory, app.appId, msg.userId, deps.memory?.userKeys()))) {
          taskEnv[k] ??= v;
        }
      }
      // 打点只列键名不列值（env 常含凭证，防日志泄漏）；值含 ${ 提示误配——env 值不做变量
      // 展开，${VAR} 会原样传给 CLI（变量展开只在 MCP 配置一侧，展开源正是这里注入的环境）
      const envKeys = [...new Set([...Object.keys(app.env ?? {}), ...Object.keys(config.claude?.env ?? {})])];
      if (envKeys.length > 0) {
        console.log(tag, `[env] 本任务注入自定义环境变量 ${envKeys.length} 键：${envKeys.join(', ')}（claude.env 领土键已过滤）`);
        for (const [k, v] of [...Object.entries(app.env ?? {}), ...Object.entries(config.claude?.env ?? {})]) {
          if (v.includes('${')) console.warn(tag, `[env] ${k} 的值含未展开的 \${...} 引用（env 值不做变量展开），请确认是否误配`);
        }
      }
      // 机器人级厂商档案（每任务现读解析，热生效）：认证经惰性生成的 per-bot settings 文件以
      // CLI --settings 参数注入（命令行层优先级最高，不被生效目录 settings.json 的 env 块压制）；
      // 模型并入 /model 优先级链走 opts.model。档案名不存在仅 warn 回退全局（档案可能后建）
      const appProfile = resolveAppProfile(config, app);
      if (app.profile && !appProfile) {
        console.warn(tag, `[app-profile] 机器人 ${app.name || app.appId} 配置的厂商档案 "${app.profile}" 不存在，本任务跟随全局`);
      }
      const profileModel = resolveAppProfileModel(config, app);
      let profileSettingsPath: string | undefined;
      if (appProfile) {
        try {
          profileSettingsPath = ensureProfileSettingsFile(appProfile);
        } catch (e) {
          console.warn(tag, `[app-profile] 档案 "${appProfile.name}" 的 settings 文件生成失败，本任务认证跟随全局：`, e instanceof Error ? e.message : e);
        }
      }
      const outcome = await deps.executor(prompt, {
        cwd: workspacePath(wsName),
        resumeSessionId: resumeId,
        signal: abort.signal,
        env: taskEnv,
        // 人设 + SOP + 工具说明三段软约束（各自独立，按开关参与）：人设裸文本追加在 Claude Code
        // 长系统提示末尾，对模型的约束力天然偏弱（resume 旧会话时历史风格会带偏）——包一层
        // 显式遵循框架语显著改善称谓/口吻/能力定位的遵循度（提示工程手段，非硬约束）
        appendSystemPrompt: (() => {
          const raw = app.appendSystemPrompt?.trim() ?? '';
          const persona = raw
            ? `【机器人人设（用户为该机器人配置，须在每一轮回复中严格遵循，优先级高于默认回复风格）】\n${raw}\n【人设结束】以上人设适用于本会话每一轮回复——包括称呼、口吻、能力定位的自我介绍；即使历史回复风格不同，也从本轮起遵循。`
            : '';
          return [
            persona || undefined,
            sopEnabled ? FEISHU_NOTIFY_SOP_PROMPT : undefined,
            toolHintEnabled ? TOOL_HINT_PROMPT : undefined,
          ].filter(Boolean).join('\n\n') || undefined;
        })(),
        // 计划模式（#6）：通道级 /plan 开关——模型先出计划（ExitPlanMode → planAsk 飞书卡片），
        // 用户批准后 SDK 自动切回可编辑模式继续执行（替代旧工作区 code-dev 类型）
        ...(state?.planMode ? { permissionMode: 'plan' as const } : {}),
        // 模型优先级（每任务现读，改完下一条消息即生效）：通道 /model 覆盖 > 机器人档案
        // （profile_model > 档案默认 model，经 --model 参数路由，不受 settings.json 遮蔽）>
        // 不传（跟随生效目录 settings.json 全局配置）
        ...(state?.model ? { model: state.model } : profileModel ? { model: profileModel } : {}),
        // 机器人档案认证 settings 文件（--settings）：仅含认证键，命令行层压制生效目录 env
        ...(profileSettingsPath ? { extraArgs: { settings: profileSettingsPath } } : {}),
        // 进程内通知工具（send_text/send_image/send_file）：中间产物实时推给当前聊天。
        // server 实例按任务构造（挂通道槽 delegate，见上方槽式换绑），chatId 在 sender
        // 闭包内硬绑定——模型无法选择接收者。
        // 配置页 MCP（#12）一并注入：bridge 自管 servers.json 每任务现读（热生效），notify 后展开保名
        mcpServers: { ...loadBridgeMcpServers(), [NOTIFY_SERVER_NAME]: createNotifyServer(notifySlot.delegate) },
        // A2 常驻进程池：同通道亲和复用 CLI 子进程（冷启动税摊薄为每会话一次）。
        // 指纹 = 本任务现读的全部 spawn 输入（人设/模型/plan/env/MCP/插件/档案 settings/
        // cwd/续接指针），任一变化 → executor 回收重建，保「每任务现读热生效」语义；
        // 空闲回收与池上限策略同样每任务现读（热改配置下一条消息生效）
        affinityKey: `${app.appId}:${key}`,
        resident: config.session?.residentProcess !== false,
        residentIdleMs: (config.session?.residentIdleMinutes ?? 60) * 60_000,
        residentMax: config.session?.residentMaxProcesses ?? (app.concurrency ?? config.concurrency),
        residentScope: app.appId,
        // 插件：config.yaml 显式配置（开发期指源码目录）+ Claude 配置目录已启用的 marketplace
        // 插件自动发现，同名显式优先；SDK 对无效路径静默跳过，实际加载以 init 清单（/plugins 命令）为准。
        // managed 模式合并发现两处目录（自管 + 本机 ~/.claude）：按绝对 installPath 传 SDK，
        // 用户本机已装插件无须重装；resolvePluginPaths 按 name 去重，当前生效目录优先。
        // 分身角色按 allowed_plugins 白名单过滤（显式 app.plugins 始终保留——写在分身配置里
        // 的就是要给的）；未配 allowed_plugins = 权限轴「全给」，自动发现插件全部加载。
        // 记忆插件自动注入（§6.9）：memory.enabled 时 openviking-memory 以宿主基础设施身份
        // 加入加载集，不受 deputy 白名单过滤——记忆是宿主给每个 bot 的恒定能力（同 notify
        // server），不是主人分配给分身的业务插件。B0 实测教训：不注入则白名单分身静默金鱼记忆。
        ...(() => {
          const discovered = claudeDir === DEFAULT_CLAUDE_DIR
            ? discoverPlugins(claudeDir)
            : [...discoverPlugins(claudeDir), ...discoverPlugins(DEFAULT_CLAUDE_DIR)];
          let merged = resolvePluginPaths(app.plugins, discovered);
          if (app.role === 'deputy' && app.allowedPlugins !== undefined) {
            merged = merged.filter((p) =>
              app.plugins?.some((e) => e.name === p.name) || app.allowedPlugins!.includes(p.name));
          }
          // 装配校验告警 ①（§6.9 L2）：deputy 白名单零命中——配了白名单但与发现集零交集，
          // 「以为在收权，实际连一个插件都没给」几乎必为配置错误（B0 实测：二号 bot 配
          // [library] 而该插件未启用 → 实际加载 0 插件，全程零提示）。在记忆注入前判定，
          // 避免注入的记忆插件掩盖零命中事实
          if (app.role === 'deputy' && app.allowedPlugins?.length && merged.length === 0) {
            console.warn(
              tag,
              `[memory] 分身 "${app.name}" 配置了 allowed_plugins（${app.allowedPlugins.join('、')}）`
              + ' 但与已发现插件零命中：自动发现插件实际加载 0 个。请检查插件名拼写，或确认插件已安装且在 '
              + 'settings.json enabledPlugins 中启用（/plugins 可查实际加载清单；方案 §6.9）',
            );
          }
          // 记忆插件注入（§6.9 L1）：幂等合流——已显式配置或已过白名单时同名去重不重复加载；
          // 未发现（未安装/未启用）则注入无从谈起，落告警 ② 提示安装，不静默
          if (config.memory?.enabled && !merged.some((p) => p.name === MEMORY_PLUGIN_NAME)) {
            const found = discovered.find((p) => p.name === MEMORY_PLUGIN_NAME);
            if (found) merged.push({ name: found.name, path: found.path, source: 'discovered' });
            else {
              console.warn(
                tag,
                `[memory] memory.enabled=true 但插件 ${MEMORY_PLUGIN_NAME} 未被发现（未安装或 enabledPlugins 未启用）：`
                + '记忆召回/沉淀 hooks 不会生效。安装：claude plugin install openviking-memory@openviking'
                + '（或经配置页插件安装；详见 docs 方案 §6.9）',
              );
            }
          }
          return merged.length ? { plugins: merged.map((p) => ({ path: p.path })) } : {};
        })(),
        // 分身技能白名单：透传 SDK Options.skills（官方上下文过滤器——未列出技能对模型不可见
        // 且被 Skill 工具拒绝；非沙箱：技能文件仍在磁盘可被 Read/Bash 读到，用户已知悉此边界）
        ...(app.role === 'deputy' && app.allowedSkills?.length ? { allowedSkills: app.allowedSkills } : {}),
        // 分身计划批准不升级 acceptEdits：该模式会绕过 canUseTool，宿主安全闸（R1/R2）随之失效
        ...(app.role === 'deputy' ? { planApproveEscalates: false } : {}),
        canUseTool: (toolName, input, ctx) => gate.decide(toolName, input, wsName, ctx),
        onQuery: (handle) => { activeQueries.set(key, { wsName, handle }); },
      }, {
        onInit: (inv) => {
          // CLI 进程已起、会话已建：状态从「已接收，启动中」切「会话已建立」（冷启动大头在
          // init 之前，先让用户看到进程已建立而非黑盒等待）
          progress.markSessionReady();
          // inventory 键带 appId 前缀：分身机器人技能/插件集与主机器人不同，两个 app 共用
          // 工作区时 /skills /plugins /mcp 清单不能互相污染
          inventories.set(`${app.appId}:${wsName}`, { ...inv, workspace: wsName, loadedAt: new Date().toISOString() });
        },
        onMcpStatus: (servers) => {
          // 任务收尾时 executor 拉取的真实 MCP 状态回写 inventory——init 快照必为 pending，
          // 这是 /mcp 空闲期显示 connected/failed 的数据源（prev 不存在说明 init 未到，等 init 全量落盘）
          const invKey = `${app.appId}:${wsName}`;
          const prev = inventories.get(invKey);
          if (prev) inventories.set(invKey, { ...prev, mcpServers: servers, loadedAt: new Date().toISOString() });
        },
        onProgress: (e: ProgressEvent) => {
          if (e.kind === 'status') {
            // CLI 状态心跳（上下文压缩/等待后台任务等）：降级为执行栈下方灰色小字行，避免静默期黑盒感
            progress.setStatus(e.content);
          } else if (e.kind === 'thinking') {
            // 模型思考期（status=requesting）：执行栈顶「💭 处理中…」，首个执行事件即焚
            progress.markThinking();
          } else if (e.kind === 'first-delta') {
            // 首个流式增量（模型开始吐字）：提前点亮「正在执行」，不等首个完整块
            progress.markStarted();
          } else if (e.kind === 'text') {
            progress.markStarted();
            // R3：流式正文块脱敏后再渲染/落盘（进度卡展示 + transcript 双消费点；
            // gateway 深度脱敏仍在其后兜底，双保险覆盖 transcript 这一本地落盘面）
            const streamRedaction = getRedactor(config.security).text(e.content);
            if (streamRedaction.hits.length) {
              deps.audit?.write(app.appId, { kind: 'redact', ruleIds: [...new Set(streamRedaction.hits)], source: 'stream' });
            }
            if (streamRedaction.canary) onSecurityEvent({ kind: 'canary', source: 'stream' });
            progress.appendText(streamRedaction.text, e.sub ?? false);
            // 落盘 · assistant：流式文本块全文（每块一行，天然增量）
            deps.transcript?.assistant({
              v: 1, ts: now(), kind: 'assistant', app: app.appId,
              chatId: msg.chatId, userId: msg.userId, text: streamRedaction.text,
            });
          } else if (e.kind === 'tool-start') {
            progress.markStarted();
            // 摘要（命令串/路径）同样过脱敏再落盘——命令回显可能带出先前输出中的秘密
            const summaryRedaction = getRedactor(config.security).text(e.summary);
            progress.toolStart(e.tool, summaryRedaction.text, e.sub ?? false);
            deps.transcript?.tool({
              v: 1, ts: now(), kind: 'tool', app: app.appId,
              chatId: msg.chatId, userId: msg.userId, phase: 'start', tool: e.tool, summary: summaryRedaction.text, ok: true,
            });
          } else if (e.kind === 'tool-result') {
            progress.toolResult(e.tool, e.ok ?? true, e.note, e.sub ?? false);
            deps.transcript?.tool({
              v: 1, ts: now(), kind: 'tool', app: app.appId,
              chatId: msg.chatId, userId: msg.userId, phase: 'result', tool: e.tool, summary: '', ok: e.ok ?? true,
            });
          } else if (e.kind === 'todos') {
            // TodoWrite 步骤清单：文案由模型生成，与工具摘要同级暴露面——同样过脱敏再上卡
            const redactTodo = (text: string): string => {
              const r = getRedactor(config.security).text(text);
              if (r.hits.length) deps.audit?.write(app.appId, { kind: 'redact', ruleIds: [...new Set(r.hits)], source: 'stream' });
              return r.text;
            };
            progress.setTodos(e.todos.map((t) => ({
              content: redactTodo(t.content),
              ...(t.activeForm ? { activeForm: redactTodo(t.activeForm) } : {}),
              status: t.status,
            })));
          } else if (e.kind === 'agent-start') {
            // 子代理/后台任务启动：进度卡子代理清单（独立区块，对齐 CLI 的 agent 进度显示）
            progress.agentStart(e.agent);
          } else if (e.kind === 'agent-settle') {
            progress.agentSettle(e.id, e.status, e.summary);
          }
        },
      });
      if (abort.signal.aborted) {
        // /stop（或硬超时）中止后 SDK 流仍会正常收尾走成功分支——按停止处理，不误报「完成」。
        // 会话归档保留（中断任务的会话上下文仍有价值），但跳过结果与产出文件回传
        await progress.finish('已停止', undefined, 'stopped');
        archive(outcome.sessionId);
        deps.transcript?.result({
          v: 1, ts: now(), kind: 'result', app: app.appId,
          chatId: msg.chatId, userId: msg.userId, sessionId: outcome.sessionId, subtype: 'stopped', text: '',
        });
        return;
      }
      // finalText 提前算好：finish 按动态承载额度切分进主卡结论条目，并返回实际承载字数
      // （续卡只发装不下的剩余后缀）。
      // R3：先脱敏再落盘/发送——transcript 写入（下方 result 事件）与结果卡都消费脱敏后文本，
      // bridge 自己的落盘不再残留明文（方案 v3 §八.4：脱敏点在 transcript 之前，非发送点）
      const finalRedaction = getRedactor(config.security).text(outcome.finalText?.trim() ?? '');
      if (finalRedaction.hits.length) {
        deps.audit?.write(app.appId, { kind: 'redact', ruleIds: [...new Set(finalRedaction.hits)], source: 'final' });
      }
      if (finalRedaction.canary) onSecurityEvent({ kind: 'canary', source: 'final' });
      const finalText = finalRedaction.text;
      // A3 滚动轻注记：新话题首条回复带一次（仅此一条，可配置关闭）——并入终态状态行
      // （不单独占一条消息，群聊里机器人自言自语就是噪音），失忆困惑由注记 + /resume 兜底。
      // 注记只进回传文本，不进 transcript（传输层装饰，非模型产出）
      const rollNote = rolled && config.session?.groupRollNotify !== false
        ? '已开启新话题（此前讨论 /resume 可找回）'
        : '';
      const doneSummary = rollNote ? `已完成 · ${rollNote}` : '已完成';
      const { inlineChars } = await progress.finish(doneSummary, finalText ? { fullText: finalText } : undefined);
      archive(outcome.sessionId);
      deps.transcript?.result({
        v: 1, ts: now(), kind: 'result', app: app.appId,
        chatId: msg.chatId, userId: msg.userId, workspace: wsName,
        sessionId: outcome.sessionId, subtype: 'success',
        text: outcome.finalText, producedFiles: outcome.producedFiles, turns: outcome.turns,
      });
      // 会话超长提醒（token 基准）：最后一次 result 的 input+cache 三项之和 ≈ 当前上下文规模，
      // 跨任务（resume 续接）持续累积，比轮次口径真实得多（一个多轮工具调用任务就可能轮次很高
      // 而上下文尚小，旧 turns>40 口径频繁误报）。0 = 关闭；usage 缺失（旧 mock/异常环境）回退轮次兜底
      const remindThreshold = config.session?.contextRemindTokens ?? DEFAULT_CONTEXT_REMIND_TOKENS;
      const ctxTokens = outcome.usage
        ? outcome.usage.inputTokens + outcome.usage.cacheCreationInputTokens + outcome.usage.cacheReadInputTokens
        : 0;
      if (remindThreshold > 0 && (ctxTokens >= remindThreshold || (!outcome.usage && outcome.turns > 40))) {
        const scale = outcome.usage ? `（当前约 ${(ctxTokens / 10000).toFixed(1)} 万 tokens）` : '';
        await deps.gateway.sendTextTo(
          msg.chatId,
          `本会话上下文已较大${scale}，建议发送 /new 开启新会话（/resume 可随时切回）。阈值可在 config.yaml 的 session.context_remind_tokens 调整，设为 0 关闭`,
        );
      }
      // 结果回传（2026-10-25 主卡承载改版）：完整回复优先承载进主卡终态结论条目（finish 内
      // 按动态额度 = 发言区预算 − 过程发言已占切分，重叠发言条目已隐藏）——额度装下即全文
      // 在主卡，不再单独发卡（落实「信息不重复推送：主卡能完整显示就不单独发卡」既定原则）；
      // 装不下的剩余后缀补发续卡（首部「（续 · 共 N 字）」，仍超 ~3000 字/块按 chunkText
      // 分张，连发间隔 300ms 防飞书限流）。尾卡纯展示，想继续对话/提意见直接回复消息即可
      if (finalText) {
        const remaining = finalText.length - inlineChars;
        if (remaining > 0) {
          const chunks = chunkText(finalText.slice(inlineChars));
          const total = chunks.length;
          for (let i = 0; i < total; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 300));
            const head = resultContinuationHeader(remaining, i + 1, total);
            if (i === total - 1) {
              await deps.gateway.sendCardTo(msg.chatId,
                buildResultTailCard(head, chunks[i], config.card?.width ?? 'default'));
            } else {
              await deps.gateway.sendTextTo(msg.chatId, `${head}\n\n${chunks[i]}`);
            }
          }
        }
      }
      // 图片自动发（im.image.create 通道），非图片文件不自动回传——
      // 收尾文件清单卡与数字查 diff 已移除（用户反馈）：改动了哪些文件由最终回复正文说明，
      // 明确要文件本体时由模型侧 send_file 工具处理（notify-sop 提示词约束）
      const uploadProducedImages = async (): Promise<void> => {
        const imageFiles = outcome.producedFiles
          .filter((f) => !sentPaths.has(resolve(f)))
          .filter(isImageFile);
        for (const f of imageFiles) {
          await deps.gateway.uploadAndSendFile(msg.chatId, f);
        }
      };
      await uploadProducedImages();
      // （已移除）收尾文件清单卡（「本次修改/新增的文件」+ 回复数字查 diff）与「改动汇总」卡
      // 均不再发送（用户反馈）：producedFiles 仅保留图片自动发与 transcript 记录用途
    } catch (e) {
      // 主动中止（/stop 或 4h 硬超时）：SDK 多数场景把 AbortError("Operation aborted") 抛进消息循环
      // 而非正常收尾——按停止处理不误报「出错」，与上方 executor 正常 return 后的 aborted 判断二选一命中
      if (abort.signal.aborted) {
        const hardTimedOut = abort.signal.reason instanceof Error && abort.signal.reason.message === 'hard-timeout';
        await progress.finish(hardTimedOut ? '已停止（超过 4 小时上限自动停止）' : '已停止', undefined, 'stopped');
        const stoppedSessionId = (e as { sessionId?: string })?.sessionId;
        archive(stoppedSessionId);
        deps.transcript?.result({
          v: 1, ts: nowBeijingISO(), kind: 'result', app: app.appId,
          chatId: msg.chatId, userId: msg.userId, sessionId: stoppedSessionId ?? '', subtype: 'stopped', text: '',
        });
        return;
      }
      // 常见错误附配置指引（认证 hint 按模式分流：managed 指向配置页，inherit 指向 claude login）；
      // No conversation found 多因旧版独立目录里的会话（本版起统一 Claude 配置目录，旧会话无法跨目录 resume）。
      // 飞书 API 4xx 时 axios 的 message 只有裸 "status code 400"，业务错误码（230099/200621 等）
      // 藏在 e.response.data——拼上响应体摘要，错误卡与日志可直接定位拒绝原因
      const errText = `${String(e)}${feishuErrorBody(e) ? `\n（飞书：${feishuErrorBody(e)}）` : ''}`;
      const uiUrl = serverUrl(config);
      const hint = errText.includes('Not logged in')
        ? config.claude?.mode === 'managed'
          ? `\n\n没有可用的 Claude Code 认证：当前为 managed 模式${uiUrl ? `，打开 ${uiUrl} 在「Claude 认证」区填写 auth_token / api_key` : ''}（中转站另配 base_url），保存后重启 bridge。`
          : '\n\n没有可用的 Claude Code 认证：在本机终端跑一次 claude login 登录（登录态存于 ~/.claude，所有机器人共享）；或在本机 ~/.claude/settings.json 的 env 配 ANTHROPIC_AUTH_TOKEN（第三方端点另配 ANTHROPIC_BASE_URL），改完重启 bridge。'
        : /No conversation found|session not found/i.test(errText)
          ? '\n\n该会话可能已失效（或属于旧版独立配置目录）：发 /new 开启新会话即可。'
          : /429|rate.?limit|usage.?limit|已达到.*上限|quota/i.test(errText)
            // 限额/限流：CLI 内部带指数退避自动重试数分钟，期间计时持续走属正常——
            // 错误到达飞书时已是重试耗尽后的终态，并非桥接器卡死（提示重置时间以 CLI 返回为准）
            ? '\n\n模型额度受限（Claude Code 已自动重试数分钟仍失败，等待期间计时持续属正常）。等额度恢复后重发任务即可；频繁出现请检查套餐限额或改用 /model 切换模型。'
            : '';
      await progress.finish(`出错：${errText.slice(0, 300)}${hint}`, undefined, 'error');
      // 出错任务的会话同样归档：错误轮的上下文对追问「刚才为什么错」有价值，
      // 也让 /resume 历史随真实使用持续积累（executor 抛错时携带 sessionId）
      const errSessionId = (e as { sessionId?: string })?.sessionId;
      archive(errSessionId);
      deps.transcript?.result({
        v: 1, ts: nowBeijingISO(), kind: 'result', app: app.appId,
        chatId: msg.chatId, userId: msg.userId, sessionId: '',
        subtype: 'error', text: errText.slice(0, 500), // 实录同带响应体摘要（排查飞书 4xx 不再依赖翻日志）
      });
    } finally {
      clearTimeout(hardTimeout);
      activeProgress.delete(key);
      activeQueries.delete(key);
      rt.abort = undefined;
      rt.busy = false;
      // A3 滚动计数：任务收尾即一轮活跃（成功/出错/停止都消耗了上下文，均向阈值累积）；
      // 指针与历史归档已在上文完成，markActivity 只记时间戳与轮次
      deps.store.markActivity(key);
      release();
    }
  }

  /**
   * 卡片回调：所有路径必须给用户可感知反馈（点击无响应会导致反复点击）。
   * 发起人有效点击走回调响应内联结果卡（飞书收到响应瞬间同步换卡，按钮即刻消失），
   * toast 仅作即时提示；!pending 等分支严禁携带 card（卡片可能已是结果态，带卡会把
   * 结果卡换回带按钮状态，等同剥夺发起人操作权——参照 I2 教训）。
   */
  async function handleCardAction(action: CardActionEvent): Promise<CardActionResponse | undefined> {
    try {
      // 工作动态展开/收起（存量旧卡按钮回调）：新版卡片已改原生折叠面板（客户端本地展开，
      // 无回调），此分支仅为升级前发出的旧卡兜底——点击不再报「操作异常」，也不改服务端状态
      if (action.value.requestId === TOOLS_TOGGLE_REQUEST_ID) {
        return { toast: { type: 'info', content: '工具明细已内嵌在各步骤的折叠面板里，点 ⌄ 即可展开' } };
      }
      // plan 确认回调分流（requestId 唯一，planPending 与 confirmPending 不会同时命中）
      const plan = planPending.get(action.value.requestId);
      if (plan) {
        if (action.operatorId !== plan.ownerId) {
          console.log(tag, `[卡片回调] 非发起人 ${action.operatorId} 点击计划区 ${action.value.requestId}，已忽略`);
          return { toast: { type: 'info', content: '仅任务发起人可操作计划' } };
        }
        const decision = action.value.decision;
        // plan-view-file（存量卡片残留按钮）：计划正文已改为卡片直发（planAsk），此处等价重发
        // 一遍内容卡片组——不消耗挂起项，可反复点击
        if (decision === 'plan-view-file') {
          void sendPlanContentCards(plan.chatId, plan.req)
            .catch((e) => console.error('[计划内容重发失败]', action.value.requestId, e));
          return { toast: { type: 'info', content: '正在重新发送计划内容卡片…' } };
        }
        if (decision !== 'plan-approve' && decision !== 'plan-revise' && decision !== 'plan-reject') {
          return { toast: { type: 'info', content: '该计划确认已被处理或已过期' } };
        }
        // revise 意见为空：不消耗本次决策（条目保留，卡片按钮仍可用），提示先填意见
        const feedback = (action.value.feedback ?? '').trim();
        if (decision === 'plan-revise' && !feedback) {
          return { toast: { type: 'warning', content: '请先在输入框填写修改意见（或点「放弃计划」）' } };
        }
        planPending.delete(action.value.requestId);
        plan.resolve(decision === 'plan-approve' ? { action: 'approve' }
          : decision === 'plan-revise' ? { action: 'revise', feedback }
          : { action: 'reject' });
        // 独立确认卡整卡收口为灰色终态（按钮消失防重复点击）
        settlePlanConfirmCard(action.value.requestId, PLAN_DECISION_TEXT[decision]);
        // 清除主进度卡的等待阶段（header 随 setPlan(undefined) 恢复蓝色继续执行）
        const prog = activeProgress.get(plan.channelKey);
        if (prog) {
          prog.setPlan(undefined);
          prog.setStatus(PLAN_DECISION_TEXT[decision]);
        }
        return { toast: { type: 'success', content: PLAN_DECISION_TEXT[decision] } };
      }
      // 提问回调分流（#3）：qa-pick 仅 PATCH 选中态（不消耗挂起项，等所有题答完才 submit）；
      // qa-submit 全部作答后一次性 resolve 并 clearQuestion。主进度卡的 PATCH 由 ProgressCard 内部 flush 串行化
      const qa = qaPending.get(action.value.requestId);
      if (qa) {
        if (action.operatorId !== qa.ownerId) {
          console.log(tag, `[卡片回调] 非发起人 ${action.operatorId} 点击提问区 ${action.value.requestId}，已忽略`);
          return { toast: { type: 'info', content: '仅任务发起人可作答' } };
        }
        const { decision } = action.value;
        if (decision === 'qa-pick') {
          const q = qa.req.questions[action.value.qIndex ?? -1];
          const label = action.value.option;
          if (!q || !label || !q.options.some((o) => o.label === label)) {
            return { toast: { type: 'info', content: '该选项无效' } };
          }
          // 切换选中态由 ProgressCard.updateQuestionAnswer 唯一维护（toggle / 至少保留一项）；本处只调 PATCH
          const prog = activeProgress.get(qa.channelKey);
          const before = prog?.getQuestionAnswer(action.value.qIndex!);
          const willUnpick = !!q.multiSelect && Array.isArray(before) && before.includes(label) && before.length > 1;
          prog?.updateQuestionAnswer(action.value.qIndex!, label, !!q.multiSelect);
          // 把 progress 的最新答案同步回 qa.answers 供 submit 校验，避免双 mutate（toggle 重复计数）
          if (prog) qa.answers[action.value.qIndex!] = prog.getQuestionAnswer(action.value.qIndex!)
            ?? (q.multiSelect ? [] : label);
          return { toast: { type: 'success', content: willUnpick ? `已取消：${label}` : `已选：${label}` } };
        }
        if (decision === 'qa-submit') {
          // 0.20.0：每题答案 = 选项点选 + 表单自定义输入（formValue.custom_N）合并——
          // 单选：custom 非空优先覆盖选中项；多选：custom 追加进选中数组。
          // 已答判定放宽为「选中项或自定义输入至少一项」
          const fv = action.value.formValue ?? {};
          const result: AskQuestionResult = {};
          const missing: number[] = [];
          qa.req.questions.forEach((q, i) => {
            const raw = fv[`custom_${i}`];
            const custom = typeof raw === 'string' ? raw.trim() : '';
            const picked = qa.answers[i];
            if (q.multiSelect) {
              const arr = Array.isArray(picked) ? [...picked] : picked !== undefined ? [picked as string] : [];
              if (custom) arr.push(custom);
              if (arr.length === 0) { missing.push(i); return; }
              result[q.question] = arr;
            } else {
              const ans = custom || (picked !== undefined ? (picked as string) : '');
              if (!ans) { missing.push(i); return; }
              result[q.question] = ans;
            }
          });
          if (missing.length > 0) {
            return { toast: { type: 'warning', content: `第 ${missing.map((i) => i + 1).join('、')} 题未作答（点选项或在输入框填写均可）` } };
          }
          qaPending.delete(action.value.requestId);
          qa.resolve(result);
          // 清除主进度卡的内嵌提问区（按钮随 setQuestion(undefined) 的 flush 消失）；
          // 提交即收敛提问前的铺垫发言（方案正文等，题干已随提问区显示过，不再占过程流；
          // 超时未答路径不收敛，内容保留可读）
          const prog = activeProgress.get(qa.channelKey);
          if (prog) {
            prog.setQuestion(undefined);
            prog.collapseQuestionSpeech();
            prog.setStatus('答案已提交，继续执行…');
          }
          return { toast: { type: 'success', content: '答案已提交' } };
        }
        return { toast: { type: 'info', content: '该提问已被处理或已过期' } };
      }
      // 工作区切换卡（裸 /ws）：无 Promise 挂起——wsPending 提供 admin 校验、stale 失效
      // 与工作区快照。权限语义与 /ws use 一致而非「仅发起人」：主机器人 admin 可切（member
      // 能拿卡看列表，点按钮被拒，卡片保持原样，admin 仍可点）；分身白名单内人人可切、
      // 白名单外一律拒绝——回调时点现调 deputyWorkspacePolicy 实时重校验（防发卡后配置
      // 热重载白名单缩小/锁定、旧卡仍可点的时序漏洞），与其它卡的 ownerId 校验刻意不同
      const wsc = wsPending.get(action.value.requestId);
      if (wsc) {
        const deputyPolicy = app.role === 'deputy' ? deputyWorkspacePolicy(app.allowedWorkspaces, config) : undefined;
        if (deputyPolicy?.locked) {
          return { toast: { type: 'info', content: '分身机器人工作区已锁定（allowed_workspaces 仅 1 项），不可切换' } };
        }
        if (wsc.stale) {
          return { toast: { type: 'info', content: '该列表已过期，请以最新 /ws 卡片为准' } };
        }
        if (!deputyPolicy && !deps.access.isAdmin(action.operatorId)) {
          console.log(tag, `[卡片回调] 非 admin ${action.operatorId} 点击工作区卡 ${action.value.requestId}，已忽略`);
          return { toast: { type: 'info', content: '切换工作区仅管理员可用' } };
        }
        const target = wsc.workspaces.find((w) => w.name === action.value.ws);
        if (!target) {
          return { toast: { type: 'info', content: '该工作区不存在，请重新发送 /ws' } };
        }
        // 白名单外实时拒绝（发卡快照已过滤，此处防热重载后白名单收窄的窗口期）
        if (deputyPolicy && !deputyPolicy.switchable.some((w) => w.name === target.name)) {
          console.log(tag, `[卡片回调] 分身白名单外工作区 ${target.name}（${action.operatorId}），已拒绝`);
          return { toast: { type: 'info', content: '该工作区不在 allowed_workspaces 白名单内，不可切换' } };
        }
        // 当前项判定（disabled 按钮不回调；不支持 disabled 的客户端点当前项时兜底，防冗余
        // 切换清掉续接指针）：实时 workspaceName 优先，跟随默认未显式切换则回退发卡时快照
        const wsSt = deps.store.getChannelState(wsc.channelKey);
        const wsCurrent = wsSt?.workspaceName || wsc.currentName;
        if (target.name === wsCurrent) {
          return { toast: { type: 'info', content: '该工作区已是当前工作区' } };
        }
        applyWorkspaceSwitch(deps.store, wsc.channelKey, target);
        // 等价 cmd.pointerTouched：切换清了续接指针，运行中/收尾窗口内任务的迟到归档不得回写；
        // 常驻进程同步作废（cwd 已随工作区变化，旧进程上下文不再适用）
        const wsRt = runtimes.get(wsc.channelKey);
        if (wsRt) wsRt.pointerGen = (wsRt.pointerGen ?? 0) + 1;
        killResidentSession(`${app.appId}:${wsc.channelKey}`);
        // 同通道其余工作区卡置 stale：旧卡显示的当前项已过时，继续可点会诱导误切回旧工作区
        for (const [id, e] of wsPending) {
          if (e.channelKey === wsc.channelKey && id !== action.value.requestId) e.stale = true;
        }
        console.log(tag, `[工作区] 卡片切换 ${wsCurrent} → ${target.name}（${action.operatorId}）`);
        // 一次性选择语义：本卡随即终态化（移除挂起项，迟到点击按孤儿卡 toast 提示），再切重发 /ws
        wsPending.delete(action.value.requestId);
        return {
          toast: { type: 'success', content: `已切换工作区：${target.name}（已开启新会话，/resume 可切回历史）` },
          // 回调响应内联换卡：整卡替换为终态提示（纯 markdown 无按钮），不能再点
          card: { type: 'raw', data: buildWorkspaceSwitchedCard(target.name, target.path, config.card?.width ?? 'default') },
        };
      }
      const pending = confirmPending.get(action.value.requestId);
      if (!pending) {
        // 已处理/超时清理/桥接器重启后的孤儿卡：toast 提示后忽略，不重复决策
        return { toast: { type: 'info', content: '该确认已被处理或已过期，无需重复操作' } };
      }
      if (action.operatorId !== pending.ownerId) {
        // 非发起人点击：卡片保持原样（按钮保留，发起人仍可确认）——PATCH 成无按钮的结果卡
        // 会让发起人从此无法操作，群聊可被任意成员 DoS。仅回 toast 提示 + resolve 落空
        console.log(tag, `[卡片回调] 非发起人 ${action.operatorId} 点击确认卡 ${action.value.requestId}，已忽略`);
        return { toast: { type: 'info', content: '仅任务发起人可确认' } };
      }
      const decision = action.value.decision;
      if (decision !== 'allow' && decision !== 'deny' && decision !== 'allow-session') {
        return { toast: { type: 'info', content: '该确认已被处理或已过期，无需重复操作' } };
      }
      confirmPending.delete(action.value.requestId);
      pending.resolve(decision);
      // 决策落定：清除进度卡内嵌确认区并刷新状态行（按钮随 setConfirm 的 flush 消失）
      pending.onSettled(decision);
      return { toast: { type: 'success', content: DECISION_TEXT[decision] } };
    } catch (e) {
      console.error(tag, '[卡片回调异常]', action.value.requestId, e);
      // resolve 之后的代码理论不可抛；若未来插入可抛代码，按条目是否仍在区分决策是否已生效
      const retryable = confirmPending.has(action.value.requestId) || planPending.has(action.value.requestId) || qaPending.has(action.value.requestId)
        || (wsPending.get(action.value.requestId)?.stale === false);
      return { toast: { type: 'error', content: retryable ? '处理失败，请重试' : '处理出现异常，决策可能已生效，请勿盲目重试' } };
    }
  }

  return {
    onMessage: handleIncoming,
    onCardAction: handleCardAction,
    /**
     * 测试/诊断入口：返回通道当前挂起的内嵌 plan / question requestId。
     * 仅用于测试断言与生产期诊断，不影响业务流。channelKey 取 chatId + userId。
     * 内嵌挂起项被 settle/超时清空时对应字段变 undefined
     */
    _pendingAsk(channelKey: string): { planId?: string; questionId?: string } {
      const prog = activeProgress.get(channelKey);
      if (!prog) return {};
      return prog.pendingAsk();
    },
  };
}

/**
 * 配置热重载器：lcb ws add/remove 写盘后，运行实例下一条消息即见新工作区
 * （与 access.reload 同款模式——长驻进程不重读会持旧配置直至重启）。
 * 热应用 workspaces + defaults + 各 app 的 triggers/plugins/env + claude.env：
 * createBridge 闭包持有同一 app 对象引用、executeTask 每任务经 buildTaskEnv 现读，
 * 原地 mutate 下一条消息即生效（env 变更不再要求重启）。
 * 不热应用（且不纳入 sameApps 比较）：FeishuGateway 与 Semaphore 均为启动时构造，
 * apps 凭证 / concurrency 变更无法热生效，打警告提示重启，避免「以为已生效」的坑。
 * 读失败（文件被写坏的中间态等）沿用旧值不崩，并返回用户可读的错误消息（成功返回 null）——
 * 调用方（processMessage）据此在聊天里显式提示「本次沿用旧配置」，不再静默。
 */
export function createConfigReloader(
  config: BridgeConfig,
  configPath: string,
  opts: { onMemoryChanged?: (memory: BridgeConfig['memory']) => void } = {},
): () => string | null {
  return () => {
    let fresh: BridgeConfig;
    try {
      fresh = loadConfig(configPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn('[配置热重载] 读取失败，沿用旧配置：', message);
      return message;
    }
    if (!sameApps(fresh.apps, config.apps) || fresh.concurrency !== config.concurrency) {
      console.warn('[配置热重载] 检测到应用列表/凭证或 concurrency 变更，需重启后生效');
    }
    // claude 段仅 mode 变更才需重启（CLAUDE_CONFIG_DIR 在 createBridge 构造时定妆）；
    // env 变更热生效（每任务 buildTaskEnv 现读）不在此 warn；顶层四字段（auth_token/api_key/
    // base_url/model）变化无需重启——写入侧（配置页 PUT / use-profile / 飞书 /model-profile）
    // managed 模式下已即时 syncManagedClaude 重写托管 settings.json，下一条任务消息即生效，
    // 此处再 warn 会误导「以为没生效」。profiles 变更同样热生效——bot 级档案每任务现读解析
    // （app-profile.ts），全局顶层四字段亦经各写入侧即时落托管盘，此处不比较 profiles。
    // server 段为启动时定妆照（startBridge 时监听），运行中变更只能提示重启
    const claudeRestartShape = (c: BridgeConfig['claude']) =>
      JSON.stringify(c ? { mode: c.mode } : {});
    if (claudeRestartShape(fresh.claude) !== claudeRestartShape(config.claude)) {
      console.warn('[配置热重载] 检测到 claude 认证模式变更，需重启后生效');
    }
    // claude.env 变更探测：托管盘重写要在 mutate config.claude 之前取旧值比较
    const claudeEnvChanged = JSON.stringify(fresh.claude?.env ?? {}) !== JSON.stringify(config.claude?.env ?? {});
    if (JSON.stringify(fresh.server ?? {}) !== JSON.stringify(config.server ?? {})) {
      console.warn('[配置热重载] 检测到 server 段变更，需重启后生效');
    }
    config.workspaces = fresh.workspaces;
    config.defaults = fresh.defaults;
    // 权限白名单/黑名单热应用：通道级 gate 复用，但经 getter 在 decide 时现读 config.permissions，
    // 此处原地替换后已有通道的下一个工具调用即用新名单。安保段（红区/脱敏/金丝雀）同款 getter
    // 现读 → 热生效；脱敏器按配置键 memo，键变化自动重编译
    config.permissions = fresh.permissions;
    config.security = fresh.security;
    config.claude = fresh.claude;
    config.server = fresh.server;
    config.slashCommands = fresh.slashCommands;
    // 会话行为热应用：超长提醒阈值每任务收尾现读，改盘后下一条消息即用新值
    config.session = fresh.session;
    // 卡片宽度热应用：gateway 的 cardWidth getter 与各处发卡传参都现读 config.card，
    // 原地替换后下一条消息的所有卡片即用新宽度（0.x 遗漏导致改宽度须重启的修复）
    config.card = fresh.card;
    // 长期记忆段热应用（§6.6）：OPENVIKING_* env 下发与记忆插件注入均每任务现读 config.memory，
    // 原地替换后下一条消息即生效；常驻进程经配置指纹回收（env/plugins 变化 → 指纹变 → 重建）。
    // 段变化时通知调用方（startBridge 据此后台重签 user key——account/root key 改动会使旧 key 失配）
    const memoryChanged = JSON.stringify(fresh.memory ?? null) !== JSON.stringify(config.memory ?? null);
    config.memory = fresh.memory;
    if (memoryChanged) opts.onMemoryChanged?.(fresh.memory);
    // managed 模式 claude.env 热生效：inherit 由每任务 buildTaskEnv 并入子进程 env 即可；
    // managed 走托管 settings.json 通道（CLI 侧 settings.json env 优先于进程 env），
    // 此处即时重写盘保证两通道同值——不写盘则手改 env 会被盘上旧值覆盖而静默失效
    if (claudeEnvChanged && config.claude?.mode === 'managed') {
      try {
        initManagedClaudeDir(config);
      } catch (e) {
        console.warn('[配置热重载] claude.env 变更但托管 settings.json 重写失败，重启 bridge 后生效：', e instanceof Error ? e.message : e);
      }
    }
    // app 数量变化属需重启的变更（上面 sameApps 长度比较已警告），仅等长时逐位 mutate。
    // env 依赖 createBridge 的 app 参数与 config.apps[i] 为同一对象引用（startBridge 传数组
    // 元素本体）——改为拷贝传入会让 env 热生效静默失效，勿动
    if (fresh.apps.length === config.apps.length) {
      fresh.apps.forEach((fa, i) => {
        config.apps[i].triggers = fa.triggers;
        config.apps[i].plugins = fa.plugins;
        config.apps[i].env = fa.env;
        // 机器人级厂商档案热生效：executeTask 每任务经 app-profile.ts 现读解析
        config.apps[i].profile = fa.profile;
        config.apps[i].profileModel = fa.profileModel;
        // 分身 Bash 三态热生效：gate 在 decide 时经 getter 现读 app.bashMode
        config.apps[i].bashMode = fa.bashMode;
      });
    }
    return null;
  };
}

export async function startBridge(configPath: string = CONFIG_PATH): Promise<void> {
  // 启动分步进度（主人可见的启动过程）：[1/4] 长连接 → [2/4] 记忆服务 → [3/4] 记忆身份 → [4/4] 配置页。
  // 记忆两步全程非阻断——失败只提示 + 给出「去哪手动起」的指引，桥接器本体照常服务
  const TOTAL_STEPS = 4;
  let stepNo = 0;
  const step = (title: string): string => `[${++stepNo}/${TOTAL_STEPS}] ${title}`;
  const config = loadConfig(configPath);
  // 双实例治理：旧实例占着 Web 配置页端口会让本进程配置页静默失联（浏览器仍打到旧进程），启动先接管
  const oldBridge = await stopExistingBridgeAndWait();
  if (oldBridge.pid) console.log(oldBridge.stopped
    ? `🔁 检测到旧桥接器实例（PID ${oldBridge.pid}），已停止，继续启动…`
    : `⚠️ 旧桥接器实例（PID ${oldBridge.pid}）停止超时/失败，继续启动（配置页端口可能仍被其占用）`);
  // 双实例治理第二道：端口实占清场。PID 文件是「登记制」——旧进程异常退出留陈旧记录、外部
  // 旧版本进程不登记，只认 PID 文件杀不到真正的端口占用者（2026-10-17 升级期事故根因）。
  // 这里直接探测配置页端口：占用者是 LCB 自己人（/api/status 带 version）→ 强制结束并等端口
  // 释放；非 LCB 占用者不动，交给配置页 EADDRINUSE 的友好提示换端口。探测失败/端口空闲均零开销
  if (config.server?.enabled !== false) {
    const freed = await freeLcbOccupiedPort(config.server?.port ?? 17317);
    if (freed.pid !== null) {
      if (freed.freed) console.log(`🔁 ${freed.detail}，继续启动…`);
      else console.warn(`⚠️ 配置页端口清场未完成：${freed.detail}；本进程配置页可能无法启动（桥接器不受影响）`);
    }
  }
  let webHandle: { close(): void } | null = null;
  // access 全局共享：个人场景同一人对所有机器人，N 个 bridge 注入同一实例（单进程无竞态）
  const access = AccessControl.load(join(CONFIG_DIR, 'access.json'));
  // 旧单应用 sessions.json 一次性迁移到 apps[0] 的分片（键格式未变，纯改名）
  migrateLegacySessions(CONFIG_DIR, config.apps[0].appId);
  if (config.transcripts?.retentionDays) {
    const removed = sweepTranscripts(join(CONFIG_DIR, 'transcripts'), config.transcripts.retentionDays);
    if (removed > 0) console.log(`[transcripts] 已清理 ${removed} 个过期落盘文件`);
  }
  // 长期记忆（§6.6 B1）：启动时 Admin API 签发 per-bot user key——api_key 模式才实际签发，
  // dev 模式服务端禁用 Admin API（身份经 OPENVIKING_USER → X-OpenViking-User header 隔离，
  // 跳过即正解）；memory 段热重载变化时后台重签（account/root key 改动会使旧 key 失配）。
  // key 只进内存缓存与子进程 env，永不落日志/配置页
  const memoryUserKeys = new Map<string, string>();
  /** 服务不可达时的签发重试预算（15s × 6 ≈ 90s）：旧实现探活失败即跳过且永不重试，导致
   *  「记忆服务稍后才起 → 整个会话生命周期都没有记忆」。重试只在「服务不可达」时进行，
   *  且有 flag 防并发叠加（热重载与启动重试可能同时触发） */
  const MEMORY_KEY_RETRY = { intervalMs: 15_000, rounds: 6 };
  let memoryKeyRetrying = false;
  const refreshMemoryKeysInner = async (): Promise<void> => {
    if (!config.memory?.enabled) {
      memoryUserKeys.clear();
      return;
    }
    // 签发集合 = web（网页端身份；配置页移除「一键初始化」后由此自愈）+ 各 bot 关联身份
    //（ensureMemoryUserKeys 内部按 distinct uid 去重签发，共享身份只签一次、结果按 appId 展开）
    const desired = [WEB_USER_ID, ...config.apps.map((a) => a.appId)];
    const outcomes = await ensureMemoryUserKeys(config.memory, desired);
    memoryUserKeys.clear();
    let unreachable = outcomes.size > 0;
    for (const o of outcomes.values()) {
      if (o.userKey) {
        memoryUserKeys.set(o.appId, o.userKey);
        unreachable = false;
        const label = o.appId === WEB_USER_ID ? 'web 用户（网页端）'
          : o.uid && o.uid !== o.appId ? `bot ${o.appId} → ${o.uid}（共享/映射身份）`
            : `bot ${o.appId}`;
        console.log(`[memory] ${label}：user key 已签发（api_key 模式）`);
      } else if (o.error) {
        unreachable = false;
        console.warn(`[memory] ${o.appId === WEB_USER_ID ? 'web 用户' : `bot ${o.appId}`}：user key ${o.error}`);
      } else {
        if (o.skipped && !o.skipped.startsWith('服务不可达')) unreachable = false;
        console.log(`[memory] ${o.appId === WEB_USER_ID ? 'web 用户' : `bot ${o.appId}`}：${o.skipped}`);
      }
    }
    // 保险库同步（2026-10-22 事故修复）：签发链路拿到的最新 key 立即入保险库，配置页
    // 「查看密钥」/OpenViking Studio 复制的始终是可用 key——否则留旧 key 等列表自愈，
    // 期间复制出去的必 401。按 uid 去重后**顺序 await**（vaultStore 内部已串行化 + 写前
    // 重读，这里不再 fire-and-forget：DPAPI 每次 1-2s、4 用户约 5s，运行在启动/热重载
    // 后台链路不阻塞消息；写失败落日志，不影响会话 env 下发）
    const vaultedUids = new Set<string>();
    for (const o of outcomes.values()) {
      if (!o.userKey || !o.uid || vaultedUids.has(o.uid)) continue;
      vaultedUids.add(o.uid);
      await vaultStore(o.uid, o.userKey).catch((e) => {
        console.warn(`[memory] ${o.uid} 保险库同步失败（不影响会话 env）：`, e instanceof Error ? e.message : e);
      });
    }
    // 全员因服务不可达被跳过 → 退避重试；服务起来后自动补签，无需重启 LCB
    if (unreachable && !memoryKeyRetrying) {
      memoryKeyRetrying = true;
      void (async () => {
        for (let i = 1; i <= MEMORY_KEY_RETRY.rounds; i++) {
          await new Promise((r) => setTimeout(r, MEMORY_KEY_RETRY.intervalMs));
          await refreshMemoryKeys();
          if (memoryUserKeys.size > 0 || !config.memory?.enabled) {
            memoryKeyRetrying = false;
            if (memoryUserKeys.size > 0) console.log(`[memory] 记忆身份已补签（服务就绪后自动恢复，无需重启）`);
            return;
          }
        }
        memoryKeyRetrying = false;
        console.warn(`[memory] 记忆服务在 ${MEMORY_KEY_RETRY.rounds} 次重试后仍不可达，本会话无记忆注入；`
          + '可在配置页「记忆增强」点「启动服务」后重启 LCB，或等下一条消息触发重试');
      })();
    }
  };
  // 单飞包装 + 快照门槛：所有签发触发源（启动自举 / 热重载 onMemoryChanged / 不可达重试 /
  // 消息路径 ensureFreshKeys）共用同一条在途 Promise，不并发重签；完成时记录「已签发配置
  // 快照」（memory 段 JSON）——identityMap 换绑、密钥重置等任何段变化都会使其失配
  let lastSignedSnapshot: string | undefined;
  let refreshInFlight: Promise<void> | undefined;
  const memorySnapshot = (): string => JSON.stringify(config.memory ?? null);
  const refreshMemoryKeys = (): Promise<void> => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        await refreshMemoryKeysInner();
        lastSignedSnapshot = memorySnapshot();
      } finally {
        refreshInFlight = undefined;
      }
    })();
    return refreshInFlight;
  };
  const memoryProvider = createMemoryProvider(config, memoryUserKeys);
  // 消息路径的新鲜度保障（机器人换绑用户场景的关键一环）：identityMap 从用户一切到 R 后，
  // 热重载 onMemoryChanged 是后台异步，第一条消息可能抢在重签完成前构建 taskEnv——拿着
  // 旧用户的 key + OPENVIKING_USER=R（api_key 模式服务端剥声明头、身份由 key 决定），记忆
  // 会静默写回旧 ns。executeTask 构建 env 前调 ensureFreshKeys：快照一致零开销直返，不一致
  // 则单飞等待刷新完成，保证首条消息的 key 与当前映射严格一致
  memoryProvider.bindEnsureFreshKeys(async () => {
    if (!config.memory?.enabled) return;
    if (memorySnapshot() === lastSignedSnapshot) return;
    await refreshMemoryKeys();
  });
  // 配置页「重置密钥」→ 同步刷新进程内缓存：按 uid 反查全部映射机器人 + web 身份逐一更新，
  // 下一条消息的 taskEnv 即用新 key（否则 LCB 继续下发已作废旧 key 直到重启——2026-10-22
  // 真机事故：用户重置自救反而加重 401 的根因）
  onUserKeyRotated((uid, newKey) => {
    if (!config.memory?.enabled) return;
    for (const a of config.apps) {
      if (resolveMemoryUid(config.memory, a.appId) === uid) memoryUserKeys.set(a.appId, newKey);
    }
    if (uid === WEB_USER_ID) memoryUserKeys.set(WEB_USER_ID, newKey);
  });
  // reloader 共享：所有 bridge 持有同一 config 对象引用，mutate 一处全员可见
  const reloadConfig = createConfigReloader(config, configPath, {
    onMemoryChanged: (memory) => {
      if (memory?.enabled) {
        void refreshMemoryKeys();
        try { ensureClientCliConf(memory); } catch { /* 同启动口径，容错不阻断 */ } // 'updated' 自愈端点漂移
      } else {
        memoryUserKeys.clear();
        try { cleanupClientCliConf(); } catch { /* 清理失败不影响停用：只删 LCB 骨架形状，手配/外部文件保留 */ }
      }
    },
  });
  // 旧版（≤0.3.x）缺省独立目录的一次性迁移提示：目录还在则其中历史会话不再可 /resume
  //（本版起所有机器人统一 ~/.claude，会话无法跨数据目录 resume）。不做自动迁移（双目录合并无安全做法）
  for (const app of config.apps) {
    const legacyDir = join(CONFIG_DIR, 'claude', app.appId);
    if (existsSync(legacyDir)) {
      console.warn(
        `[app:${app.name}] 检测到旧版独立数据目录 ${legacyDir}：本版起统一使用 ~/.claude，`
        + `该目录中的历史会话不再出现在 /resume（本机配置/登录态/插件已自动继承）。目录保留未动，确认无用后可手动删除`,
      );
    }
  }
  // 每 app 一对 gateway+bridge：长连接/会话池/并发闸/Claude Code 环境/落盘目录全部 per-app 隔离
  // 安全面审计：单实例按 appId 分文件落盘（CONFIG_DIR/security/audit-<appId>.jsonl）
  const securityAudit = new SecurityAudit(join(CONFIG_DIR, 'security'));
  const runners = config.apps.map((app) => {
    const tag = `[app:${app.name}]`;
    const gateway = new FeishuGateway(app, {
      log: { warn: (...a: unknown[]) => console.warn(tag, ...a), error: (...a: unknown[]) => console.error(tag, ...a) },
      // 多机器人部署：botOpenId 拉取失败时宁丢群消息不猜（防同群双触发）
      strictGroupMention: config.apps.length > 1,
      // 卡片宽度热生效：getter 现读 config.card（reloader 原地 mutate 同一对象）
      cardWidth: () => config.card?.width ?? 'default',
      // R3 出站脱敏（恒开，全部机器人）：getter 现读 config.security → 热重载即生效
      redactor: () => getRedactor(config.security),
      onSecurityEvent: (ev) => {
        securityAudit.write(app.appId, ev);
        if (ev.kind !== 'redact') console.warn(tag, '[安全事件]', ev.kind);
      },
    });
    // web 配置页「会话记录」拉真群名/会话类型用（进程内注册表；lcb ui 独立进程查无来源 → 自动降级）
    registerChatInfoSource(app.appId, { request: (p) => gateway.feishuRequest(p) });
    const deps: BridgeDeps = {
      gateway: {
        start: (h) => gateway.start(h),
        sendCardTo: (chatId, card) => gateway.sendCard(chatId, card),
        sendTextTo: (chatId, md) => gateway.sendText(chatId, md),
        updateCard: (id, card) => gateway.updateCard(id, card),
        uploadAndSendFile: (chatId, p) => gateway.uploadAndSendFile(chatId, p),
        sendImageTo: (chatId, p, caption) => gateway.sendImage(chatId, p, caption),
        deleteCard: (id) => gateway.deleteCard(id),
        // 卡片实体模式（cardkit）：进度卡局部更新保 plan 表单输入；FeishuGateway 恒定实现，
        // 权限/接口异常时 ProgressCard.start 捕获降级为普通卡片 + 整卡 PATCH
        sendCardEntityTo: (chatId, card) => gateway.sendCardEntity(chatId, card),
        partialUpdateCardElements: (cardId, seq, actions) => gateway.partialUpdateCardElements(cardId, seq, actions),
        replaceCardEntity: (cardId, seq, card) => gateway.replaceCardEntity(cardId, seq, card),
        sendTextToUser: (openId, md) => gateway.sendTextToUser(openId, md),
        resolveUserNames: (ids) => gateway.resolveUserNames(ids),
      },
      access,
      store: SessionStore.load(join(CONFIG_DIR, `sessions.${app.appId}.json`)),
      executor: runTask,
      transcript: new TranscriptWriter(join(CONFIG_DIR, 'transcripts', app.appId)),
      audit: securityAudit,
      memory: memoryProvider,
    };
    return { app, gateway, bridge: createBridge(config, app, deps, { reloadConfig }) };
  });
  // 部分失败不拖垮其它 app：一个凭证写错时其余机器人照常服务。
  // 注意：SDK 对非法 appId 的 start() 是静默 return 不抛错——Promise resolve 不等于连接成功，
  // 逐 app 状态行是运维观测的主要手段
  console.log(`${step('飞书长连接启动 …')}`);
  const results = await Promise.allSettled(runners.map((r) => r.gateway.start(r.bridge)));
  runners.forEach((r, i) => {
    if (results[i].status === 'fulfilled') console.log(`✅ ${r.app.name}（${r.app.appId}）长连接已启动`);
  });
  for (const f of results) if (f.status === 'rejected') console.error('❌ 应用启动失败：', f.reason);
  if (results.every((r) => r.status === 'rejected')) throw new Error('所有应用均启动失败，请检查 config.yaml 中的 apps 配置');
  console.log(`🚀 lark-claudecode-bridge 已启动（${results.length - results.filter((r) => r.status === 'rejected').length}/${results.length} 个应用，长连接模式，无需公网 IP）`);
  // 页面托管启停的探活依据：进程存活期间持有 PID 文件（崩溃/被硬杀时由读取方清理陈旧文件）
  writePidFile();
  // 优雅关闭：SIGINT/SIGTERM（或页面 stop/restart 经 selfStop 注入）时逐个关闭全部长连接
  const shutdown = (sig: string) => {
    console.log(`\n收到 ${sig}，正在关闭 ${runners.length} 条长连接…`);
    webHandle?.close();
    for (const r of runners) r.gateway.close();
    // 常驻 CLI 子进程一并回收（优雅退出，不赖 stdio 断连兜底）
    killAllResidentSessions();
    // B3 受管 OpenViking 服务一并关停（embedded 模式随 LCB 生命周期；独立手动服务不受影响）。
    // 自举已后台化：尚未拉起（managed 未定义）时本调用空安全直接返回
    stopManagedServer();
    clearPidFile();
    process.exit(0);
  };
  // Web 配置页（server.enabled 缺省 true）：随 bridge 常驻，浏览器可随时查看/修改配置；
  // 启动失败只 warn 不阻断机器人服务（端口冲突等场景桥接器本体仍可用）。
  // P0 重启超时根治：配置页启动**前移**到记忆自举之前——OpenViking 冷启动动辄 30-60s，
  // 串行在它后面会让页面重启探活（/api/status）轻易撞上前端 45s 超时，误报「重启失败」；
  // 现在配置页可用时间只取决于 LCB 本体，与记忆服务快慢彻底解耦
  if (config.server?.enabled !== false) {
    try {
      console.log(`${step('配置页启动 …')}`);
      webHandle = await startWebServer({
        server: config.server,
        configPath,
        embedded: true,
        appsStarted: runners.map((r, i) => ({ name: r.app.name, started: results[i].status === 'fulfilled' })),
        selfStop: () => shutdown('web-stop'),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        // server.ts 已把 EADDRINUSE 转成友好文案（含占用者探测与平台排查命令），此处只补语境
        console.warn(`[配置页] ${msg}（桥接器继续运行，配置页暂不可用）`);
      } else {
        console.warn(`[配置页] 启动失败（桥接器继续运行）：${msg}；可通过 config.yaml 的 server.port 换端口`);
      }
    }
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 长驻进程兜底：任何遗漏的未处理 rejection 只记日志不退出——飞书发送偶发失败若崩掉整个
  // bridge（Node 默认行为），systemd 重启会掩盖崩溃，但当时所有在跑回合横死、会话尾部残缺，
  // 下一轮 resume 便是「上一轮被中断」的连环错乱
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]（已忽略，进程继续运行）', reason);
  });
  // 第二步：记忆增强自举（**后台执行**，不阻塞配置页可用与机器人服务）。
  // 服务没起就自动拉起（embedded 受管），起不来只提示 + 指引手动开启，绝不影响 LCB 本体——
  // 启动原则「记忆增强失败绝不阻断 LCB」从「不阻断」升级为「不拖慢」
  const memoryConf = config.memory;
  if (memoryConf?.enabled) {
    void (async () => {
      console.log(`${step('记忆增强 · 启动 OpenViking 服务 …')}`);
      let report;
      try {
        report = await ensureMemoryServiceRunning({
          endpoint: memoryEndpoint(memoryConf),
          mode: memoryConf.mode,
        });
      } catch (e) {
        // 自举自身抛错（理论上 ensureMemoryServiceRunning 全程收敛为 report，这里是最后一道兜底）
        report = {
          at: new Date().toISOString(), trigger: 'lcb-start', phase: 'failed',
          ready: false, started: false,
          detail: `自举异常：${e instanceof Error ? e.message : String(e)}`,
          hint: '请到配置页「记忆增强」点「检查修复」',
        };
      }
      console.log(`      ${report.ready ? '✅' : '⚠️'} ${report.detail}`);
      if (!report.ready && report.hint) console.log(`      手动开启指引：${report.hint}`);
      // 第三步：签发各 bot 记忆身份（服务不可达时内部自动退避重试，服务后就绪即补签）
      console.log(`${step('记忆增强 · 签发各 bot 记忆身份 …')}`);
      await refreshMemoryKeys();
      // 客户端接入配置兜底（§6.7 第 4 步）：外部自管域自动 skipped-external；LCB 骨架已存在
      // kept 零写。失败只 warn——本机直连 claude 的插件启用受影响，LCB 会话有 env 通道不受影响
      try {
        const w = ensureClientCliConf(memoryConf);
        if (w === 'written' || w === 'updated') console.log(`      客户端配置 ovcli.conf 已${w === 'written' ? '写入' : '刷新'}（${w}）`);
      } catch (e) { console.warn('[memory] ovcli.conf 写入失败：', e instanceof Error ? e.message : e); }
      console.log(`${step('记忆增强 · 自举流程结束（后续状态见配置页「记忆增强」）')}`);
    })();
  } else {
    console.log(`${step('记忆增强 · 未启用（config.yaml 的 memory.enabled=false），跳过')}`);
  }
}
