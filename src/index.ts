// 装配主流程：消息 → 访问控制 → 命令 → 通道队列 → 执行 → 确认卡片 → 回传
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import type {
  BridgeConfig, CardActionEvent, CardActionResponse, ConfirmationRequest, GatewayHandlers,
  IncomingMessage, PermissionDecision, ProgressEvent,
} from './types.js';
import { CONFIG_DIR, CONFIG_PATH, loadConfig } from './config.js';
import { AccessControl } from './access/access-control.js';
import { FeishuGateway } from './gateway/feishu-gateway.js';
import { ProgressCard } from './gateway/progress-card.js';
import { buildConfirmCard, buildConfirmResultCard, DECISION_TEXT } from './gateway/card-builder.js';
import { runTask } from './executor/claude-executor.js';
import { PermissionGate } from './executor/permission-gate.js';
import { SessionStore } from './session/session-store.js';
import { handleCommand } from './session/commands.js';
import { Semaphore, channelKey } from './session/channel.js';

// 版本号收敛到 version.ts 单一来源（bin/lcb.ts 与 smoke 测试均引用）
export { VERSION } from './version.js';

const execFileP = promisify(execFile);
const MAX_FILES_BEFORE_ZIP = 10;
// 任务总超时 4 小时（防挂死；确认等待、长编译均在正常范围）
const TASK_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
// 确认等待窗：无人确认则自动拒绝。超时判定由 wiring 侧自管（ask 闭包内的定时器），
// 从而到点即清理 confirmPending 条目并把卡片 PATCH 为过期态——条目有界不泄漏，
// 迟到点击因条目已删被 handleCardAction toast 提示后忽略，永不显示与实际不符的决策态
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
// PermissionGate 的兜底超时：仅当 wiring 侧超时机制失效时才触发（正常流程 ask 必在 CONFIRM_TIMEOUT_MS 内 settle）
const GATE_FALLBACK_TIMEOUT_MS = CONFIRM_TIMEOUT_MS + 60_000;

/** 确认超时后的过期态卡片（此后迟到点击不再改写此卡片） */
function expiredConfirmCard(req: ConfirmationRequest, timeoutMs: number): unknown {
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      elements: [{
        tag: 'markdown',
        content: `**🔐 Claude 请求执行操作**\n\n工具: \`${req.toolName}\`　工作区: \`${req.workspaceName}\`\n\`\`\`\n${req.summary.slice(0, 500)}\n\`\`\`\n\n⏰ 已超时自动拒绝（${Math.round(timeoutMs / 60000)} 分钟未确认）`,
      }],
    },
  };
}

interface ChannelRuntime {
  queue: Promise<void>;
  abort?: AbortController;
}

export interface BridgeDeps { // 全部可注入，测试用 mock；生产用真实实现
  gateway: {
    start(h: GatewayHandlers): Promise<void>;
    sendCardTo(chatId: string, card: unknown): Promise<string>;
    sendTextTo(chatId: string, markdown: string): Promise<string>;
    updateCard(id: string, card: unknown): Promise<void>;
    uploadAndSendFile(chatId: string, p: string): Promise<void>;
  };
  access: AccessControl;
  store: SessionStore;
  executor: typeof runTask;
}

export function createBridge(
  config: BridgeConfig,
  deps: BridgeDeps,
  opts: { confirmTimeoutMs?: number; reloadConfig?: () => void } = {}, // 测试可注入更短的确认等待窗 / 自定义配置重载
): GatewayHandlers {
  const sem = new Semaphore(config.concurrency);
  const runtimes = new Map<string, ChannelRuntime>();
  // 通道级权限闸：「本次会话不再询问」的记忆跨任务生效（spec：直至 /new），
  // 故 gate 归通道持有而非每任务新建——每任务新建会把授权缩成任务级，任务 B 又要重新确认
  const gates = new Map<string, PermissionGate>();
  const confirmPending = new Map<string, {
    resolve: (d: PermissionDecision) => void;
    req: ConfirmationRequest;
    ownerId: string;
    cardId: string;
  }>();

  function workspacePath(name: string): string {
    return config.workspaces.find((w) => w.name === name)?.path ?? config.workspaces[0].path;
  }

  async function handleIncoming(msg: IncomingMessage): Promise<void> {
    try {
      await processMessage(msg);
    } catch (e) {
      // 长驻进程兜底：单条消息处理失败不允许成为 unhandled rejection 拖垮整个桥接器
      console.error('[消息处理异常]', msg.messageId, e);
    }
  }

  async function processMessage(msg: IncomingMessage): Promise<void> {
    const key = channelKey(msg.chatId, msg.userId);
    // 1. 访问控制：白名单外发配对码（首个配对成功者自动成为 admin，见 AccessControl）
    // 每条消息先重读 access.json：lcb pair / 运行终端等独立进程批准写盘后，
    // 长存的内存实例不 reload 会查到旧白名单 → 反复发配对码且整盘覆写抹掉新用户（死循环）
    deps.access.reload();
    // 配置热重载：lcb ws add/remove 独立进程写盘后，本实例下一条消息即读到新工作区
    opts.reloadConfig?.();
    if (!deps.access.isAllowed(msg.userId)) {
      const code = deps.access.beginPairing(msg.userId, msg.userId);
      console.log(`[配对] 未知用户 ${msg.userId} 请求接入，配对码：${code}（在终端输入 lcb pair ${code} 批准）`);
      await deps.gateway.sendTextTo(msg.chatId, `🔐 首次使用需配对。\n\n请管理员在桥接器终端确认配对码：**${code}**（15 分钟内有效）`);
      return;
    }
    // 2. 命令：/help /new /resume /stop /status /ws
    const st = deps.store.getChannelState(key);
    // currentWorkspace 语义：store 中已设置的工作区优先，否则用配置默认——保证 /new、/status 回复与实际一致
    const currentWorkspace = st?.workspaceName ?? config.defaults.workspace;
    const cmd = await handleCommand(msg.text, {
      channelKey: key,
      store: deps.store,
      config,
      isAdmin: deps.access.isAdmin(msg.userId),
      currentWorkspace: () => currentWorkspace,
      stopCurrentTask: () => {
        const rt = runtimes.get(key);
        if (rt?.abort) { rt.abort.abort(); return true; }
        return false;
      },
    });
    if (cmd.handled) {
      if (cmd.reply) await deps.gateway.sendTextTo(msg.chatId, cmd.reply);
      // /new 开启新会话：「本次会话不再询问」的授权随之失效（handleCommand 无权访问 wiring
      // 持有的 gate，故在命令处理分支后于 wiring 侧检测并 reset）
      if (/^\/new(?:\s|$)/.test(msg.text.trim())) gates.get(key)?.reset();
      return;
    }
    // 3. 普通文本：通道内串行入队（每 key 一条 Promise 链），全局并发由 Semaphore 限制
    const rt = runtimes.get(key) ?? { queue: Promise.resolve() };
    runtimes.set(key, rt);
    rt.queue = rt.queue.then(() => executeTask(key, msg, cmd.taskText ?? msg.text, currentWorkspace)).catch((e) => {
      console.error('[任务异常]', e);
    });
  }

  async function executeTask(key: string, msg: IncomingMessage, prompt: string, wsName: string): Promise<void> {
    const release = await sem.acquire();
    const abort = new AbortController();
    const rt = runtimes.get(key)!;
    rt.abort = abort;
    const progress = new ProgressCard(
      {
        sendCard: (c) => deps.gateway.sendCardTo(msg.chatId, c),
        updateCard: (id, c) => deps.gateway.updateCard(id, c),
      },
      `任务 · ${wsName}`,
    );
    const confirmTimeoutMs = opts.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    // 通道级复用：已存在则沿用（allow-session 记忆跨任务），不存在才建
    let gate = gates.get(key);
    if (!gate) {
      gate = new PermissionGate({
        ask: async (req) => {
          // 发确认卡片并挂起，等待 onCardAction 按 requestId 唤醒；
          // 超时由本闭包自管：到点删除条目 + 卡片置为过期态 + 以 deny 继续——
          // 条目有界（无人点击、/stop、4h abort 挂起中的 ask 均会被定时器清理），
          // 此后的迟到点击因条目已删被 toast 提示后忽略，卡片不再被改写为与实际不符的决策态
          const cardId = await deps.gateway.sendCardTo(msg.chatId, buildConfirmCard(req));
          return new Promise<PermissionDecision>((resolve) => {
            const gc = setTimeout(() => {
              confirmPending.delete(req.requestId);
              void deps.gateway.updateCard(cardId, expiredConfirmCard(req, confirmTimeoutMs)).catch(() => {});
              resolve('deny');
            }, confirmTimeoutMs);
            gc.unref();
            confirmPending.set(req.requestId, {
              resolve: (d) => {
                clearTimeout(gc); // 用户已及时确认：撤销过期态 PATCH，防止已决策的卡片被改写为超时
                resolve(d);
              },
              req,
              ownerId: msg.userId,
              cardId,
            });
          });
        },
        timeoutMs: GATE_FALLBACK_TIMEOUT_MS,
      });
      gates.set(key, gate);
    }
    const hardTimeout = setTimeout(() => abort.abort(), TASK_HARD_TIMEOUT_MS);
    hardTimeout.unref();
    try {
      await progress.start();
      const state = deps.store.getChannelState(key);
      const resumeId = state?.sessions?.[0]?.sessionId;
      const outcome = await deps.executor(prompt, {
        cwd: workspacePath(wsName),
        resumeSessionId: resumeId,
        signal: abort.signal,
        canUseTool: (toolName, input) => gate.decide(toolName, input, wsName),
      }, {
        onProgress: (e: ProgressEvent) => {
          if (e.kind === 'text') progress.appendText(e.content);
          else if (e.kind === 'tool-start') {
            const [n, ...rest] = e.content.split(': ');
            progress.toolStart(n, rest.join(': '));
          } else if (e.kind === 'tool-result') progress.toolResult(e.content, e.ok ?? true);
        },
      });
      if (abort.signal.aborted) {
        // /stop（或硬超时）中止后 SDK 流仍会正常收尾走成功分支——按停止处理，不误报「完成」。
        // 会话归档保留（中断任务的会话上下文仍有价值），但跳过结果与产出文件回传
        await progress.finish('🛑 已停止');
        deps.store.archiveSession(key, outcome.sessionId, prompt);
        return;
      }
      await progress.finish(`✅ 完成`);
      deps.store.archiveSession(key, outcome.sessionId, prompt);
      // 会话超长提醒（累计轮次粗略估计，防上下文爆炸）
      if (outcome.turns > 40) {
        await deps.gateway.sendTextTo(msg.chatId, '💡 本会话已较长，建议发送 /new 开启新会话（/resume 可随时切回）');
      }
      // 结果回传（超长截断，防飞书消息体超限）
      if (outcome.finalText) await deps.gateway.sendTextTo(msg.chatId, outcome.finalText.slice(0, 4000));
      // 产出文件回传：>10 个打 zip（Windows 10+ / macOS / Linux 均自带 tar），失败退化为逐个上传
      const files = outcome.producedFiles;
      if (files.length > MAX_FILES_BEFORE_ZIP) {
        const zipPath = join(tmpdir(), `lcb-${randomUUID()}.zip`);
        try {
          await execFileP('tar', ['-a', '-cf', zipPath, ...files.map((f) => basename(f))], { cwd: workspacePath(wsName) });
          await deps.gateway.uploadAndSendFile(msg.chatId, zipPath);
        } catch {
          for (const f of files) await deps.gateway.uploadAndSendFile(msg.chatId, f);
        }
      } else {
        for (const f of files) await deps.gateway.uploadAndSendFile(msg.chatId, f);
      }
    } catch (e) {
      await progress.finish(`❌ 出错：${String(e).slice(0, 300)}`);
    } finally {
      clearTimeout(hardTimeout);
      rt.abort = undefined;
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
      const pending = confirmPending.get(action.value.requestId);
      if (!pending) {
        // 已处理/超时清理/桥接器重启后的孤儿卡：toast 提示后忽略，不重复决策
        return { toast: { type: 'info', content: '该确认已被处理或已过期，无需重复操作' } };
      }
      if (action.operatorId !== pending.ownerId) {
        // 非发起人点击：卡片保持原样（按钮保留，发起人仍可确认）——PATCH 成无按钮的结果卡
        // 会让发起人从此无法操作，群聊可被任意成员 DoS。仅回 toast 提示 + resolve 落空
        console.log(`[卡片回调] 非发起人 ${action.operatorId} 点击确认卡 ${action.value.requestId}，已忽略`);
        return { toast: { type: 'info', content: '仅任务发起人可确认' } };
      }
      confirmPending.delete(action.value.requestId);
      pending.resolve(action.value.decision);
      const resultCard = buildConfirmResultCard(pending.req, action.value.decision, '任务发起人');
      // 兜底 PATCH 不再 await：回调须在 3 秒内响应（协议 200341），且响应体已内联结果卡同步换卡，
      // PATCH 仅在 WS 回传响应丢失时保证最终一致（同时消掉 await PATCH 慢网络下拖垮响应窗口的隐患）
      void deps.gateway.updateCard(pending.cardId, resultCard)
        .catch((e) => console.error('[卡片兜底更新失败]', action.value.requestId, e));
      return {
        toast: { type: 'success', content: DECISION_TEXT[action.value.decision] },
        card: { type: 'raw', data: resultCard },
      };
    } catch (e) {
      console.error('[卡片回调异常]', action.value.requestId, e);
      // resolve 之后的代码理论不可抛；若未来插入可抛代码，按条目是否仍在区分决策是否已生效
      const retryable = confirmPending.has(action.value.requestId);
      return { toast: { type: 'error', content: retryable ? '处理失败，请重试' : '处理出现异常，决策可能已生效，请勿盲目重试' } };
    }
  }

  return { onMessage: handleIncoming, onCardAction: handleCardAction };
}

/**
 * 配置热重载器：lcb ws add/remove 写盘后，运行实例下一条消息即见新工作区
 * （与 access.reload 同款模式——长驻进程不重读会持旧配置直至重启）。
 * 只热应用 workspaces + defaults：FeishuGateway 与 Semaphore 均为启动时构造，
 * feishu 凭证 / concurrency 变更无法热生效，打警告提示重启，避免「以为已生效」的坑。
 * 读失败（文件被写坏的中间态等）沿用旧值不崩。
 */
export function createConfigReloader(config: BridgeConfig, configPath: string): () => void {
  return () => {
    let fresh: BridgeConfig;
    try {
      fresh = loadConfig(configPath);
    } catch (e) {
      console.warn('[配置热重载] 读取失败，沿用旧配置：', e instanceof Error ? e.message : e);
      return;
    }
    const feishuChanged = fresh.feishu.appId !== config.feishu.appId
      || fresh.feishu.appSecret !== config.feishu.appSecret
      || fresh.feishu.domain !== config.feishu.domain;
    if (feishuChanged || fresh.concurrency !== config.concurrency) {
      console.warn('[配置热重载] 检测到 feishu 凭证或 concurrency 变更，需重启后生效');
    }
    config.workspaces = fresh.workspaces;
    config.defaults = fresh.defaults;
  };
}

export async function startBridge(configPath: string = CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath);
  const gateway = new FeishuGateway(config.feishu);
  const deps: BridgeDeps = {
    gateway: {
      start: (h) => gateway.start(h),
      sendCardTo: (chatId, card) => gateway.sendCard(chatId, card),
      sendTextTo: (chatId, md) => gateway.sendText(chatId, md),
      updateCard: (id, card) => gateway.updateCard(id, card),
      uploadAndSendFile: (chatId, p) => gateway.uploadAndSendFile(chatId, p),
    },
    access: AccessControl.load(join(CONFIG_DIR, 'access.json')),
    store: SessionStore.load(join(CONFIG_DIR, 'sessions.json')),
    executor: runTask,
  };
  const bridge = createBridge(config, deps, { reloadConfig: createConfigReloader(config, configPath) });
  await gateway.start(bridge);
  console.log('🚀 lark-claudecode-bridge 已启动（长连接模式，无需公网 IP）');
}
