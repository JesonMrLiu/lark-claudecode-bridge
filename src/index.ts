// 装配主流程：消息 → 访问控制 → 命令 → 通道队列 → 执行 → 确认卡片 → 回传
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  BridgeConfig, CardActionEvent, CardActionResponse, ConfirmationRequest, FeishuAppConfig, GatewayHandlers,
  IncomingMessage, PermissionDecision, ProgressEvent, SessionInventory,
} from './types.js';
import { CONFIG_DIR, CONFIG_PATH, loadConfig, sameApps } from './config.js';
import { warnIfNoClaudeAuth } from './auth-precheck.js';
import { AccessControl } from './access/access-control.js';
import { FeishuGateway } from './gateway/feishu-gateway.js';
import { ProgressCard } from './gateway/progress-card.js';
import { buildConfirmCard, buildConfirmResultCard, DECISION_TEXT } from './gateway/card-builder.js';
import { runTask } from './executor/claude-executor.js';
import { PermissionGate } from './executor/permission-gate.js';
import { discoverPlugins, resolvePluginPaths } from './executor/plugin-discovery.js';
import { createGatewaySender, createNotifyServer, NOTIFY_SERVER_NAME } from './executor/notify-server.js';
import { SessionStore, migrateLegacySessions } from './session/session-store.js';
import { handleCommand } from './session/commands.js';
import { rewriteByTrigger } from './session/triggers.js';
import { Semaphore, channelKey } from './session/channel.js';
import { TranscriptWriter, sweepTranscripts, type TranscriptRecorder } from './transcript/transcript-writer.js';

// 版本号收敛到 version.ts 单一来源（bin/lcb.ts 与 smoke 测试均引用）
export { VERSION } from './version.js';

const execFileP = promisify(execFile);
const MAX_FILES_BEFORE_ZIP = 10;
// 全部机器人共享本机 ~/.claude（模型设置/登录态/user MCP/skills/插件；会话池仍 per-app 隔离）。
// 显式注入 CLAUDE_CONFIG_DIR 而非依赖 CLI 缺省，防外部环境变量把数据目录带偏
const SHARED_CLAUDE_DIR = join(homedir(), '.claude');
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
    /** 上传图片并发带 caption 的卡片（lcb-notify 逐张发图用）；可选——旧 gateway/测试 mock 缺省走降级 */
    sendImageTo?(chatId: string, p: string, caption?: string): Promise<string>;
  };
  access: AccessControl;
  store: SessionStore;
  executor: typeof runTask;
  /** 对话落盘记录器（可选依赖：缺失即不落盘，写失败自身消化不抛出） */
  transcript?: TranscriptRecorder;
}

export function createBridge(
  config: BridgeConfig,
  app: FeishuAppConfig, // 本 bridge 绑定的飞书应用：并发/默认工作区/Claude Code 环境/人格均 per-app
  deps: BridgeDeps,
  opts: { confirmTimeoutMs?: number; reloadConfig?: () => void } = {}, // 测试可注入更短的确认等待窗 / 自定义配置重载
): GatewayHandlers {
  const sem = new Semaphore(app.concurrency ?? config.concurrency);
  const tag = `[app:${app.name}]`;
  // Claude Code 子进程环境：CLAUDE_CONFIG_DIR 固定指向共享的 ~/.claude（settingSources 含 user，
  // 模型设置/登录态/user MCP/skills 自动继承），app.env 追加 settings.json 里没有的键；
  // process.env 先展开保证其余变量（ANTHROPIC_* 凭证、代理等）原样透传
  const appEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: SHARED_CLAUDE_DIR,
    ...app.env,
  };
  // 启动预检：认证来源全落空（env 无 token、~/.claude 无登录态）时提前 warn，
  // 免得用户配好机器人才发现每条消息都报 Not logged in（真判定仍在 CLI 侧）
  warnIfNoClaudeAuth(app.name, appEnv, SHARED_CLAUDE_DIR);
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
    cardId: string;
  }>();

  function workspacePath(name: string): string {
    return config.workspaces.find((w) => w.name === name)?.path ?? config.workspaces[0].path;
  }

  /** 通道内串行入队（每 key 一条 Promise 链），全局并发由 Semaphore 限制 */
  function enqueue(key: string, msg: IncomingMessage, prompt: string, wsName: string): void {
    const rt = runtimes.get(key) ?? { queue: Promise.resolve() };
    runtimes.set(key, rt);
    rt.queue = rt.queue.then(() => executeTask(key, msg, prompt, wsName)).catch((e) => {
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
    // 1. 访问控制：白名单外发配对码（首个配对成功者自动成为 admin，见 AccessControl）
    // 每条消息先重读 access.json：lcb pair / 运行终端等独立进程批准写盘后，
    // 长存的内存实例不 reload 会查到旧白名单 → 反复发配对码且整盘覆写抹掉新用户（死循环）
    deps.access.reload();
    // 配置热重载：lcb ws add/remove 独立进程写盘后，本实例下一条消息即读到新工作区
    opts.reloadConfig?.();
    if (!deps.access.isAllowed(msg.userId)) {
      const code = deps.access.beginPairing(msg.userId, msg.userId);
      console.log(`${tag}[配对] 未知用户 ${msg.userId} 请求接入，配对码：${code}（在终端输入 lcb pair ${code} 批准）`);
      await deps.gateway.sendTextTo(msg.chatId, `🔐 首次使用需配对。\n\n请管理员在桥接器终端确认配对码：**${code}**（15 分钟内有效）`);
      return;
    }
    // 2. 命令：/help /new /resume /stop /status /ws
    const st = deps.store.getChannelState(key);
    // currentWorkspace 语义：store 中已设置的工作区优先，否则 app 默认，最后全局默认——
    // 保证 /new、/status 回复与实际一致
    const currentWorkspace = st?.workspaceName ?? app.defaultWorkspace ?? config.defaults.workspace;
    // 2.5 触发词映射：必须放在本地命令之前——斜杠触发词（如 /produce）会被 handleCommand
    // 的未知命令分支吞掉；rewriteByTrigger 对本地命令（/stop 等）直接放行，不会被劫持
    const triggered = rewriteByTrigger(msg.text, app.triggers);
    if (triggered !== null) {
      await deps.gateway.sendTextTo(msg.chatId, '⚡ 已按触发词转入对应技能流程');
      enqueue(key, msg, triggered, currentWorkspace);
      return;
    }
    const cmd = await handleCommand(msg.text, {
      channelKey: key,
      store: deps.store,
      config,
      appName: app.name,
      isAdmin: deps.access.isAdmin(msg.userId),
      currentWorkspace: () => currentWorkspace,
      getInventory: () => inventories.get(currentWorkspace),
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
    enqueue(key, msg, cmd.taskText ?? msg.text, currentWorkspace);
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
    // lcb-notify 发送能力：chatId 硬绑定当前任务（权限闸直通的安全前提）；
    // sentPaths 记录中途已推送的文件，任务收尾的产出回传据此去重（用户已收过的不重发）
    const sentPaths = new Set<string>();
    const notifySender = createGatewaySender({
      chatId: msg.chatId,
      sentPaths,
      sendText: (c, md) => deps.gateway.sendTextTo(c, md),
      sendImageWithCaption: deps.gateway.sendImageTo,
      sendFileTo: (c, p) => deps.gateway.uploadAndSendFile(c, p),
    });
    try {
      await progress.start();
      const state = deps.store.getChannelState(key);
      const resumeId = state?.sessions?.[0]?.sessionId;
      const now = () => new Date().toISOString();
      // 落盘 · user：任务起点（prompt 全文 + resume 链上一轮 sessionId）
      deps.transcript?.user({
        v: 1, ts: now(), kind: 'user', app: app.appId,
        chatId: msg.chatId, userId: msg.userId, workspace: wsName, sessionId: resumeId, text: prompt,
      });
      const outcome = await deps.executor(prompt, {
        cwd: workspacePath(wsName),
        resumeSessionId: resumeId,
        signal: abort.signal,
        env: appEnv,
        appendSystemPrompt: app.appendSystemPrompt,
        // 通道级模型覆盖（/model 设置，每任务现读——改完下一条消息即生效）；未设 = 跟随 ~/.claude 全局
        ...(state?.model ? { model: state.model } : {}),
        // 进程内通知工具（send_text/send_image/send_file）：中间产物实时推给当前聊天。
        // server 实例按任务构造，chatId 在 sender 闭包内硬绑定——模型无法选择接收者
        mcpServers: { [NOTIFY_SERVER_NAME]: createNotifyServer(notifySender) },
        // 插件：config.yaml 显式配置（开发期指源码目录）+ ~/.claude 已启用 marketplace 插件自动发现，
        // 同名显式优先；SDK 对无效路径静默跳过，实际加载以 init 清单（/plugins 命令）为准
        ...(() => {
          const merged = resolvePluginPaths(app.plugins, discoverPlugins(SHARED_CLAUDE_DIR));
          return merged.length ? { plugins: merged.map((p) => ({ path: p.path })) } : {};
        })(),
        canUseTool: (toolName, input) => gate.decide(toolName, input, wsName),
      }, {
        onInit: (inv) => {
          inventories.set(wsName, { ...inv, workspace: wsName, loadedAt: new Date().toISOString() });
        },
        onProgress: (e: ProgressEvent) => {
          if (e.kind === 'text') {
            progress.appendText(e.content);
            // 落盘 · assistant：流式文本块全文（每块一行，天然增量）
            deps.transcript?.assistant({
              v: 1, ts: now(), kind: 'assistant', app: app.appId,
              chatId: msg.chatId, userId: msg.userId, text: e.content,
            });
          } else if (e.kind === 'tool-start') {
            const [n, ...rest] = e.content.split(': ');
            progress.toolStart(n, rest.join(': '));
            deps.transcript?.tool({
              v: 1, ts: now(), kind: 'tool', app: app.appId,
              chatId: msg.chatId, userId: msg.userId, phase: 'start', tool: n, summary: rest.join(': '), ok: true,
            });
          } else if (e.kind === 'tool-result') {
            progress.toolResult(e.content, e.ok ?? true);
            deps.transcript?.tool({
              v: 1, ts: now(), kind: 'tool', app: app.appId,
              chatId: msg.chatId, userId: msg.userId, phase: 'result', tool: e.content, summary: '', ok: e.ok ?? true,
            });
          }
        },
      });
      if (abort.signal.aborted) {
        // /stop（或硬超时）中止后 SDK 流仍会正常收尾走成功分支——按停止处理，不误报「完成」。
        // 会话归档保留（中断任务的会话上下文仍有价值），但跳过结果与产出文件回传
        await progress.finish('🛑 已停止');
        deps.store.archiveSession(key, outcome.sessionId, prompt);
        deps.transcript?.result({
          v: 1, ts: now(), kind: 'result', app: app.appId,
          chatId: msg.chatId, userId: msg.userId, sessionId: outcome.sessionId, subtype: 'stopped', text: '',
        });
        return;
      }
      await progress.finish(`✅ 完成`);
      deps.store.archiveSession(key, outcome.sessionId, prompt);
      deps.transcript?.result({
        v: 1, ts: now(), kind: 'result', app: app.appId,
        chatId: msg.chatId, userId: msg.userId, workspace: wsName,
        sessionId: outcome.sessionId, subtype: 'success',
        text: outcome.finalText, producedFiles: outcome.producedFiles, turns: outcome.turns,
      });
      // 会话超长提醒（累计轮次粗略估计，防上下文爆炸）
      if (outcome.turns > 40) {
        await deps.gateway.sendTextTo(msg.chatId, '💡 本会话已较长，建议发送 /new 开启新会话（/resume 可随时切回）');
      }
      // 结果回传（超长截断，防飞书消息体超限）
      if (outcome.finalText) await deps.gateway.sendTextTo(msg.chatId, outcome.finalText.slice(0, 4000));
      // 产出文件回传：>10 个打 zip（Windows 10+ / macOS / Linux 均自带 tar），失败退化为逐个上传；
      // 中途经 lcb-notify 已推送过的文件跳过（用户已收到，防重复轰炸）
      const files = outcome.producedFiles.filter((f) => !sentPaths.has(resolve(f)));
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
      // 常见错误附配置指引：Not logged in 多因 ~/.claude 无登录态（本机跑一次 claude login 即可）；
      // No conversation found 多因旧版独立目录里的会话（本版起统一 ~/.claude，旧会话无法跨目录 resume）
      const errText = String(e);
      const hint = errText.includes('Not logged in')
        ? '\n\n💡 没有可用的 Claude Code 认证：在本机终端跑一次 claude login 登录（登录态存于 ~/.claude，所有机器人共享）；或在本机 ~/.claude/settings.json 的 env 配 ANTHROPIC_AUTH_TOKEN（第三方端点另配 ANTHROPIC_BASE_URL），改完重启 bridge。'
        : /No conversation found|session not found/i.test(errText)
          ? '\n\n💡 该会话可能已失效（或属于旧版独立配置目录）：发 /new 开启新会话即可。'
          : '';
      await progress.finish(`❌ 出错：${errText.slice(0, 300)}${hint}`);
      deps.transcript?.result({
        v: 1, ts: new Date().toISOString(), kind: 'result', app: app.appId,
        chatId: msg.chatId, userId: msg.userId, sessionId: '',
        subtype: 'error', text: String(e).slice(0, 300),
      });
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
        console.log(tag, `[卡片回调] 非发起人 ${action.operatorId} 点击确认卡 ${action.value.requestId}，已忽略`);
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
      console.error(tag, '[卡片回调异常]', action.value.requestId, e);
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
 * 热应用 workspaces + defaults + 各 app 的 triggers/plugins：createBridge 闭包持有
 * 同一 app 对象引用、executeTask 每任务现读，原地 mutate 下一条消息即生效。
 * 不热应用（且不纳入 sameApps 比较）：FeishuGateway 与 Semaphore 均为启动时构造，
 * apps 凭证 / concurrency 变更无法热生效，打警告提示重启，避免「以为已生效」的坑。
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
    if (!sameApps(fresh.apps, config.apps) || fresh.concurrency !== config.concurrency) {
      console.warn('[配置热重载] 检测到应用列表/凭证或 concurrency 变更，需重启后生效');
    }
    config.workspaces = fresh.workspaces;
    config.defaults = fresh.defaults;
    // app 数量变化属需重启的变更（上面 sameApps 长度比较已警告），仅等长时逐位 mutate
    if (fresh.apps.length === config.apps.length) {
      fresh.apps.forEach((fa, i) => {
        config.apps[i].triggers = fa.triggers;
        config.apps[i].plugins = fa.plugins;
      });
    }
  };
}

export async function startBridge(configPath: string = CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath);
  // access 全局共享：个人场景同一人对所有机器人，N 个 bridge 注入同一实例（单进程无竞态）
  const access = AccessControl.load(join(CONFIG_DIR, 'access.json'));
  // 旧单应用 sessions.json 一次性迁移到 apps[0] 的分片（键格式未变，纯改名）
  migrateLegacySessions(CONFIG_DIR, config.apps[0].appId);
  if (config.transcripts?.retentionDays) {
    const removed = sweepTranscripts(join(CONFIG_DIR, 'transcripts'), config.transcripts.retentionDays);
    if (removed > 0) console.log(`[transcripts] 已清理 ${removed} 个过期落盘文件`);
  }
  // reloader 共享：所有 bridge 持有同一 config 对象引用，mutate 一处全员可见
  const reloadConfig = createConfigReloader(config, configPath);
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
  const runners = config.apps.map((app) => {
    const tag = `[app:${app.name}]`;
    const gateway = new FeishuGateway(app, {
      log: { warn: (...a: unknown[]) => console.warn(tag, ...a), error: (...a: unknown[]) => console.error(tag, ...a) },
      // 多机器人部署：botOpenId 拉取失败时宁丢群消息不猜（防同群双触发）
      strictGroupMention: config.apps.length > 1,
    });
    const deps: BridgeDeps = {
      gateway: {
        start: (h) => gateway.start(h),
        sendCardTo: (chatId, card) => gateway.sendCard(chatId, card),
        sendTextTo: (chatId, md) => gateway.sendText(chatId, md),
        updateCard: (id, card) => gateway.updateCard(id, card),
        uploadAndSendFile: (chatId, p) => gateway.uploadAndSendFile(chatId, p),
        sendImageTo: (chatId, p, caption) => gateway.sendImage(chatId, p, caption),
      },
      access,
      store: SessionStore.load(join(CONFIG_DIR, `sessions.${app.appId}.json`)),
      executor: runTask,
      transcript: new TranscriptWriter(join(CONFIG_DIR, 'transcripts', app.appId)),
    };
    return { app, gateway, bridge: createBridge(config, app, deps, { reloadConfig }) };
  });
  // 部分失败不拖垮其它 app：一个凭证写错时其余机器人照常服务。
  // 注意：SDK 对非法 appId 的 start() 是静默 return 不抛错——Promise resolve 不等于连接成功，
  // 逐 app 状态行是运维观测的主要手段
  const results = await Promise.allSettled(runners.map((r) => r.gateway.start(r.bridge)));
  runners.forEach((r, i) => {
    if (results[i].status === 'fulfilled') console.log(`✅ ${r.app.name}（${r.app.appId}）长连接已启动`);
  });
  for (const f of results) if (f.status === 'rejected') console.error('❌ 应用启动失败：', f.reason);
  if (results.every((r) => r.status === 'rejected')) throw new Error('所有应用均启动失败，请检查 config.yaml 中的 apps 配置');
  console.log(`🚀 lark-claudecode-bridge 已启动（${results.length - results.filter((r) => r.status === 'rejected').length}/${results.length} 个应用，长连接模式，无需公网 IP）`);
  // 优雅关闭：SIGINT/SIGTERM 时逐个关闭全部长连接
  const shutdown = (sig: string) => {
    console.log(`\n收到 ${sig}，正在关闭 ${runners.length} 条长连接…`);
    for (const r of runners) r.gateway.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
