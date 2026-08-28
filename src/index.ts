// 装配主流程：消息 → 访问控制 → 命令 → 通道队列 → 执行 → 确认卡片 → 回传
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import type {
  BridgeConfig, CardActionEvent, ConfirmationRequest, GatewayHandlers,
  IncomingMessage, PermissionDecision, ProgressEvent,
} from './types.js';
import { CONFIG_DIR, CONFIG_PATH, loadConfig } from './config.js';
import { AccessControl } from './access/access-control.js';
import { FeishuGateway } from './gateway/feishu-gateway.js';
import { ProgressCard } from './gateway/progress-card.js';
import { buildConfirmCard, buildConfirmResultCard } from './gateway/card-builder.js';
import { runTask } from './executor/claude-executor.js';
import { PermissionGate } from './executor/permission-gate.js';
import { SessionStore } from './session/session-store.js';
import { handleCommand } from './session/commands.js';
import { Semaphore, channelKey } from './session/channel.js';

export const VERSION = '0.1.0';

const execFileP = promisify(execFile);
const MAX_FILES_BEFORE_ZIP = 10;
// 任务总超时 4 小时（防挂死；确认等待、长编译均在正常范围）
const TASK_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
// 确认等待窗：无人确认则自动拒绝。超时判定由 wiring 侧自管（ask 闭包内的定时器），
// 从而到点即清理 confirmPending 条目并把卡片 PATCH 为过期态——条目有界不泄漏，
// 迟到点击因条目已删被 handleCardAction 静默忽略，永不显示与实际不符的决策态
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
  opts: { confirmTimeoutMs?: number } = {}, // 测试可注入更短的确认等待窗
): GatewayHandlers {
  const sem = new Semaphore(config.concurrency);
  const runtimes = new Map<string, ChannelRuntime>();
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
    const gate = new PermissionGate({
      ask: async (req) => {
        // 发确认卡片并挂起，等待 onCardAction 按 requestId 唤醒；
        // 超时由本闭包自管：到点删除条目 + 卡片置为过期态 + 以 deny 继续——
        // 条目有界（无人点击、/stop、4h abort 挂起中的 ask 均会被定时器清理），
        // 此后的迟到点击因条目已删被静默忽略，卡片不再被改写为与实际不符的决策态
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

  async function handleCardAction(action: CardActionEvent): Promise<void> {
    try {
      const pending = confirmPending.get(action.value.requestId);
      if (!pending) return; // 已过期/不存在的 requestId：静默忽略
      if (action.operatorId !== pending.ownerId) {
        // 非发起人点击：不 resolve（等待真正发起人），卡片置为无权限提示态
        await deps.gateway.updateCard(pending.cardId, buildConfirmResultCard(pending.req, action.value.decision, '无权限操作者（仅任务发起人可确认）'));
        return;
      }
      confirmPending.delete(action.value.requestId);
      pending.resolve(action.value.decision);
      await deps.gateway.updateCard(pending.cardId, buildConfirmResultCard(pending.req, action.value.decision, '任务发起人'));
    } catch (e) {
      console.error('[卡片回调异常]', action.value.requestId, e);
    }
  }

  return { onMessage: handleIncoming, onCardAction: handleCardAction };
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
  const bridge = createBridge(config, deps);
  await gateway.start(bridge);
  console.log('🚀 lark-claudecode-bridge 已启动（长连接模式，无需公网 IP）');
}
