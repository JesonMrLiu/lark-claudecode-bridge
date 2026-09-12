import { buildProgressCard, buildPartialUpdateActions, buildQaButtonActions, type ProgressState } from './card-builder.js';
import type { ConfirmationRequest } from '../types.js';

export interface CardSender {
  sendCard(card: unknown): Promise<string>;        // 返回 messageId
  updateCard(messageId: string, card: unknown): Promise<void>;
  /** 撤回消息（进度卡沉底用）；缺省（旧 gateway/测试 mock）时沉底退化为仅重刷 */
  deleteCard?(messageId: string): Promise<void>;
  /** 卡片实体模式（cardkit）：创建实体并发送，返回 messageId + cardId。
   *  实体卡片支持 batch_update 局部更新——状态刷新只改指定 element_id 组件，
   *  plan 表单输入框的用户输入不会被心跳刷掉。缺省（无权限/旧 gateway）降级整卡 PATCH。 */
  sendCardEntity?(card: unknown): Promise<{ messageId: string; cardId: string }>;
  /** 卡片实体局部更新（batch_update + partial_update_element），sequence 须严格递增 */
  partialUpdateCard?(cardId: string, sequence: number, actions: unknown[]): Promise<void>;
  /** 卡片实体全量替换（结构变化：交互区增删/终态/选中态变化），sequence 须严格递增 */
  replaceCard?(cardId: string, sequence: number, card: unknown): Promise<void>;
}

const FLUSH_CHARS = 200;
/** 单次卡片更新请求超时：飞书 SDK 的 axios 无超时（timeout=0），请求被网络黑洞时
 *  flush 串行链会无限期挂起（生产实测单次挂 7.4 分钟）——挂起期间计时/交互区全停，
 *  与任务卡死无从区分。到点按失败处理（seq 不推进）下轮重试；若超时请求实际已在
 *  服务端落地，下轮会收 300317 经跳号分支自愈 */
const UPDATE_TIMEOUT_MS = 30_000;

/** 给单次更新请求加超时闸：到点 reject 由 flush catch 统一按失败重试 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`卡片更新超时(${ms}ms 无响应)，按失败处理下轮重试`)), ms);
    timer.unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export class ProgressCard {
  private messageId?: string;
  /** 卡片实体 ID（cardkit 实体模式）：非空时状态刷新走局部更新（保 form 输入），结构变化走全量替换 */
  private cardId?: string;
  /** cardkit 操作序号：同一实体的每次 update/batch_update 必须严格递增 */
  private seq = 0;
  /** 上次全量渲染的结构签名：交互区（confirm/plan/question）增删、终态需要全量重渲染。
   *  0.20.0 起 qa 选中态不进签名（见 structureKey）——改走 partial 按钮级局部更新 */
  private lastStructure = '';
  /** qa 选中态脏标记：updateQuestionAnswer 置位，下一次实体 partial 经按钮级 actions 发出
   *  （挂起冻结期间的唯一例外放行通道）前快照清零，失败在 flush catch 恢复重试。
   *  显式标记取代快照对比——快照在 replace 与求值之间可能被新一轮点击改写（竞态丢刷） */
  private qaButtonsDirty = false;
  /** 挂起输入期间收到的沉底请求（sinkToBottom 会删卡重发清空输入态）：挂起解除后补执行 */
  private deferSink = false;
  private buffer = '';
  private state: ProgressState;
  private flushTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private lastActivityAt = Date.now();
  private done = false;
  // C1 修复：flush 单飞串行化——同一时刻最多一个 updateCard in-flight，
  // 期间的新 flush 请求标记 dirty，落地后补刷一次；保证任何时刻后发起的
  // 更新（尤其 finish 终态）永远晚于先前挂起的更新落地。
  private flushChain: Promise<void> = Promise.resolve();
  private dirty = false;
  private flushing = false;

  constructor(
    private sender: CardSender,
    title: string,
    private opts: { flushIntervalMs?: number; idleHeartbeatMs?: number; cardWidthMode?: 'default' | 'fill'; updateTimeoutMs?: number } = {},
  ) {
    this.state = { title, status: '🚀 已接收，启动中…', textTail: '', toolLine: '', startedAt: Date.now(), agents: [] };
  }

  async start(): Promise<void> {
    const initial = buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default');
    // 优先卡片实体模式（支持局部更新 → plan 表单输入不被心跳刷掉）；
    // 创建失败（cardkit:card:write 权限缺失/接口异常）降级为普通卡片 + 整卡 PATCH，功能不退化
    if (this.sender.sendCardEntity) {
      try {
        const { messageId, cardId } = await this.sender.sendCardEntity(initial);
        this.messageId = messageId;
        this.cardId = cardId;
      } catch (e) {
        console.warn('[进度卡] 卡片实体模式不可用，降级为整卡更新（挂起期间状态/计时停更，输入冻结保护仍生效）。如已开通 cardkit:card:write，需在飞书开发者后台创建新版本并发布、并重启 bridge 后生效。原因：', e instanceof Error ? e.message : e);
      }
    }
    if (!this.messageId) {
      this.messageId = await this.sender.sendCard(initial);
    }
    this.lastStructure = this.structureKey();
    this.qaButtonsDirty = false;
    // 1s 对齐秒级计时（0.20.1：原 1.5s 跨秒边界会跳秒显示，如 1→3）；cardkit batch_update
    // 限频 1000 次/分钟，单卡 60 次/分钟远在限内
    const interval = this.opts.flushIntervalMs ?? 1000;
    this.flushTimer = setInterval(() => void this.flush(), interval).unref();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt >= (this.opts.idleHeartbeatMs ?? 30_000)) {
        this.lastActivityAt = Date.now(); // I1 修复：心跳刷过即重置空闲计时，否则退化为每秒连刷
        void this.flush(); // 心跳：刷新运行时长，证明没卡死
      }
    }, 1000).unref();
  }

  /** 过程文本累积（产品决策：运行中不在卡片渲染过程文本与思考内容，仅终态露出结果尾部——
   *  见 card-builder buildProgressCard 的 done 分支；buffer 照常积累供终态使用，不丢内容） */
  appendText(delta: string): void {
    if (this.done) return;
    this.buffer += delta;
    this.lastActivityAt = Date.now();
    if (this.buffer.length >= FLUSH_CHARS) void this.flush();
  }

  toolStart(name: string, summary: string): void {
    if (this.done) return;
    this.state.toolLine = `${name}: ${summary.slice(0, 120)}`;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  toolResult(name: string, ok: boolean, note?: string): void {
    if (this.done) return;
    // 失败时带首行原因（权限被拒/命令出错一眼可辨），不再让 ✘ 被误读成「工具没权限」
    this.state.toolLine = note ? `${ok ? '✔' : '✘'} ${name} — ${note}` : `${ok ? '✔' : '✘'} ${name}`;
    this.lastActivityAt = Date.now();
  }

  setStatus(status: string): void {
    if (this.done) return;
    this.state.status = status;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 挂起/清除内嵌工具确认：非 undefined 时卡片底部渲染确认按钮区并收敛正文，
   * 决策（含超时）后置回 undefined 恢复正文展示。appendText 期间照常积累 buffer，
   * 清除后 flush 一次性带出。
   */
  setConfirm(req: ConfirmationRequest | undefined): void {
    if (this.done) return;
    this.state.confirm = req;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 挂起/清除内嵌计划确认（#3+#6）：plan 内容过长仅露 600 字预览，完整原文落盘到 planFilePath，
   * 「查看完整方案」按钮 callback 触发 send_file 而非嵌入卡片。决策后 clearPlan() 收回区域
   */
  setPlan(req: import('./card-builder.js').EmbeddedPlanState | undefined): void {
    if (this.done) return;
    this.state.plan = req;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 挂起/清除内嵌提问确认（#3）：每题选项全宽单行 + 提交按钮全部在主卡上，qa-pick PATCH 选中态。
   * 决策后 clearQuestion() 收回区域
   */
  setQuestion(req: import('./card-builder.js').EmbeddedQuestionState | undefined): void {
    if (this.done) return;
    this.state.question = req;
    // 提问区收回时同步清选中态脏标记（按钮已随全量替换消失，qa-only 空批次无意义）
    if (!req) this.qaButtonsDirty = false;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /** 当前某题的选中答案（wiring 的 qa-pick 回调同步给 qaPending 校验用；公开读，
   *  替代旧版 wiring 直接访问私有 state 的 hack） */
  getQuestionAnswer(qIndex: number): string | string[] | undefined {
    return this.state.question?.answers[qIndex];
  }

  /** 当前挂起的内嵌 plan / question requestId（wiring 诊断入口 _pendingAsk 用） */
  pendingAsk(): { planId?: string; questionId?: string } {
    return {
      planId: this.state.plan?.requestId,
      questionId: this.state.question?.requestId,
    };
  }

  /**
   * qa-pick 选项点击：更新选中态并 flush（multiSelect 累加/移除，单选直接覆盖）。
   * 异常状态（如 question 已被清空）静默忽略——迟到点击不报错
   */
  updateQuestionAnswer(qIndex: number, option: string, multiSelect: boolean): void {
    if (this.done || !this.state.question) return;
    const q = this.state.question.questions[qIndex];
    if (!q) return;
    if (multiSelect) {
      const cur = this.state.question.answers[qIndex];
      const arr = Array.isArray(cur) ? [...cur] : cur !== undefined ? [cur] : [];
      const i = arr.indexOf(option);
      if (i >= 0 && arr.length > 1) arr.splice(i, 1); // 至少保留一项：单选/全取消等于未答
      else if (i < 0) arr.push(option);
      this.state.question.answers[qIndex] = arr;
    } else {
      this.state.question.answers[qIndex] = option;
    }
    this.qaButtonsDirty = true; // 下次实体 partial 附带按钮级选中态更新（不走全量替换，保 form 输入）
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /** 子代理/后台任务启动：加入清单（同 id 重复启动幂等跳过） */
  agentStart(agent: { id: string; description: string; type: string }): void {
    if (this.done) return;
    if (this.state.agents.some((t) => t.id === agent.id)) return;
    this.state.agents.push({ ...agent, startedAt: Date.now(), status: 'running' });
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 子代理/后台任务落定：标记完成/失败/停止（条目保留至任务结束供回看）。
   * 找不到条目时补建（resume 续跑场景：上轮启动的后台任务本轮才收到通知）。
   */
  agentSettle(id: string, status: 'done' | 'failed' | 'stopped', summary?: string): void {
    if (this.done) return;
    const t = this.state.agents.find((x) => x.id === id);
    if (t) {
      t.status = status;
      if (summary) t.summary = summary;
    } else {
      this.state.agents.push({ id, description: summary?.slice(0, 80) ?? id, type: 'task', startedAt: Date.now(), status, ...(summary ? { summary } : {}) });
    }
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  async finish(summary: string): Promise<void> {
    this.done = true;
    this.state.done = true;
    clearInterval(this.flushTimer);
    clearInterval(this.heartbeatTimer);
    this.state.status = summary;
    this.state.toolLine = '';
    // 终态不再带交互区（决策未落的最极端兜底；正常路径 plan/question/confirm 先于 finish settle）
    this.state.confirm = undefined;
    this.state.plan = undefined;
    this.state.question = undefined;
    await this.flush(); // 经由同一串行链落地，保证是最后一张（终态不被旧 flush 覆盖）
  }

  /**
   * 沉底：撤回当前进度卡并在会话底部重发（确认卡/计划卡/提问卡/中途推送都会把进度卡
   * 顶上去，用户看不出任务是否还在跑）。删除失败（权限/网络）时降级为仅重发——
   * 极端情况出现两张进度卡，任务照常。终态后不再沉底。
   * 重发失败（限流/网络）重试一次，仍失败则放弃本卡（messageId 留空，flush 自动跳过）——
   * 绝不向上抛：调用方多为 void 调用，未处理 rejection 会拖垮整个 bridge 进程。
   */
  async sinkToBottom(): Promise<void> {
    if (this.done) { this.deferSink = false; return; }
    if (!this.messageId) return;
    // 挂起输入期间沉底会删卡重发（输入态归零，用户打的意见/自定义答案被清掉）——
    // 记录请求延迟到挂起解除（flush 落地后检查补执行）
    if (this.hasInputPending()) { this.deferSink = true; return; }
    const old = this.messageId;
    const oldCardId = this.cardId;
    this.messageId = undefined; // 期间 flush 自动跳过，避免 PATCH 打到已删除的旧卡
    this.cardId = undefined;
    if (this.sender.deleteCard) await this.sender.deleteCard(old).catch(() => {});
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fresh = buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default');
        // 沉底重发沿用当前模式：原先是实体模式则新建实体（旧实体已随消息撤回弃用）
        if (this.sender.sendCardEntity && oldCardId) {
          const { messageId, cardId } = await this.sender.sendCardEntity(fresh);
          this.messageId = messageId;
          this.cardId = cardId;
          this.seq = 0; // sequence 按实体计数：新实体从 1 重新递增
        } else {
          this.messageId = await this.sender.sendCard(fresh);
        }
        this.lastStructure = this.structureKey();
        this.qaButtonsDirty = false; // 重发卡片已含最新选中态
        void this.flush();
        return;
      } catch (e) {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800)); // 退避后重试一次（飞书偶发限流）
        else console.warn('[进度卡] 沉底重发失败，本卡后续更新暂停（任务不受影响）：', e instanceof Error ? e.message : e);
      }
    }
  }

  /**
   * 串行化 flush：所有更新走同一条 promise 链按发起顺序落地。
   * - in-flight 中再来请求 → 标记 dirty，本轮落地后自动补刷一次（带上最新 state）；
   * - finish 的终态 flush 也入链，天然排在先前挂起的更新之后。
   * 实体模式下按结构签名分流：结构未变 → 局部更新（只改 main/timer 两个 markdown 组件）；
   * 结构变化（交互区增删、终态）→ 全量替换实体。两种模式自 0.20.1 起对称实现「挂起输入
   * 冻结」：plan/qa 挂起期间（hasInputPending）跳过维持性刷新——真机实测实体局部更新与
   * 整卡 PATCH 落地都会重置 form 内未提交输入，挂起期间任何更新都清掉用户正在打的字；
   * 计时行随挂起上屏显示「⏸ 计时已暂停」。唯一例外：qa 选中态脏标记放行一次按钮级
   * partial（仅 qa_opt_*，用户刚点选项的即时反馈），失败恢复脏标记重试。
   */
  private flush(): Promise<void> {
    if (!this.messageId) return Promise.resolve();
    if (this.flushing) {
      this.dirty = true; // 已有 in-flight，补刷标记，等它落地后再发
      return this.flushChain;
    }
    this.flushing = true;
    this.flushChain = (async () => {
      for (;;) {
        this.dirty = false;
        if (this.buffer) {
          this.state.textTail += this.buffer;
          this.buffer = '';
        }
        const expectedSeq = this.seq + 1; // 仅期望值,await 成功才提交推进
        const timeoutMs = this.opts.updateTimeoutMs ?? UPDATE_TIMEOUT_MS;
        // 本轮是否携带 qa 按钮级更新：发送前快照并清零（先清后发）——await 期间新一轮
        // 选项点击会重新置位，经 dirty 补刷/下轮自动补发；失败恢复见 catch。旧版在成功后
        // 才清标记，await 期间的第二次点击会丢其 ✓ 高亮（0.20.0 既有竞态，0.20.1 修复）
        let withQaButtons = false;
        try {
          if (this.cardId && this.sender.partialUpdateCard && this.sender.replaceCard) {
            const structure = this.structureKey();
            if (structure === this.lastStructure) {
              // 0.20.1 实体模式挂起冻结（与降级分支对称）：真机实测 cardkit batch_update
              // 落地同样会重置 form 内未提交输入（官方错误码 200810 亦表明交互期间流式
              // 更新受限）——挂起期间跳过维持性 partial，计时/状态停更可接受（任务在等
              // 用户，计时行随挂起上屏显示「⏸ 计时已暂停」）。例外：qa 选中态脏标记
              // （用户刚点选项按钮的即时反馈，此刻输入框大概率未打字）放行一次按钮级
              // partial——只发 qa_opt_*，不含 main/timer 替换（最小触碰）
              if (this.hasInputPending() && !this.qaButtonsDirty) break;
              withQaButtons = this.qaButtonsDirty;
              this.qaButtonsDirty = false; // 先清后发：失败恢复见 catch
              const actions = this.hasInputPending()
                ? buildQaButtonActions(this.state)
                : buildPartialUpdateActions(this.state, withQaButtons);
              // 挂起中无 qa 按钮可发（question 刚被清等边界）：视同冻结跳过；脏标记不恢复
              // （空批次重试只会无限刷日志，选中态由下次全量渲染/点击补齐）
              if (actions.length === 0) break;
              await withTimeout(this.sender.partialUpdateCard(this.cardId, expectedSeq, actions), timeoutMs);
            } else {
              // 结构变化：全量替换实体（form 输入会重置，但这些时刻用户尚未输入或已提交；
              // 全量渲染已含最新选中态）。replace 前同样先清 qa 脏标记（先清后发）：await
              // 期间新点击重新置位的 dirty 由下一轮 partial（qa 例外通道）自动补发
              withQaButtons = this.qaButtonsDirty;
              this.qaButtonsDirty = false;
              await withTimeout(this.sender.replaceCard(this.cardId, expectedSeq, buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default')), timeoutMs);
              this.lastStructure = structure;
            }
          } else {
            // 降级模式挂起冻结（0.20.0）：im.message.patch 整卡 PATCH 会重置卡片全部客户端
            // 输入态——plan/qa 挂起期间 1.5s 心跳会把用户正在输入的意见/自定义答案瞬间清掉。
            // 仅冻结「结构不变」的维持性刷新；挂起区出现/消失（结构变化）必须放行——
            // 否则确认按钮根本不上屏。计时/状态行在挂起期间停更可接受（任务实际在等用户）
            const structure = this.structureKey();
            if (this.hasInputPending() && structure === this.lastStructure) break;
            await withTimeout(this.sender.updateCard(this.messageId!, buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default')), timeoutMs);
            this.lastStructure = structure;
          }
          this.seq = expectedSeq; // 仅成功后提交推进
        } catch (e) {
          // 本轮携带 qa 按钮更新但发送失败：恢复脏标记，下轮重试补发选中态（先清后发的恢复路径）
          if (withQaButtons) this.qaButtonsDirty = true;
          // cardkit sequence OCC:失败时区分错误码
          // - 300317(服务端 sequence 已推进超过本地,网络超时但服务端已处理):
          //   飞书不提供读服务端 sequence 接口,跳到 Date.now() 兜底(飞书允许 sequence 是时间戳,且保证 next > 服务端 last)
          // - 其他错误(限流/200810 交互进行中/网络抖动):服务端没接受本次 seq,seq 不推进,下轮重试用同一 expectedSeq
          // 错误码可能在 axios 的 response.data 里（HTTP 400 时 message 只有 status code），一并带出供定位
          const code = extractFeishuErrorCode(e);
          const detail = feishuErrorBody(e);
          if (code === '300317') {
            this.seq = Date.now();
            console.warn('[进度卡] sequence 错位(300317),本地 seq 跳到时间戳:', this.seq,
              e instanceof Error ? e.message : e, detail ?? '');
          } else {
            console.warn('[进度卡] 更新失败(seq 未推进,下次用相同 expectedSeq 重试):',
              e instanceof Error ? e.message : e, detail ?? '');
          }
        }
        if (!this.dirty) break; // 落地期间无新请求，收工
      }
      // 沉底延迟触发：挂起期间被暂存的 sink 请求，在挂起解除（plan/question 已清）后补执行
      if (this.deferSink && !this.hasInputPending()) {
        this.deferSink = false;
        void this.sinkToBottom();
      }
    })().finally(() => {
      this.flushing = false;
    });
    return this.flushChain;
  }

  /** 是否有等待用户输入的挂起区（plan 意见框 / qa 自定义输入）：降级模式冻结与沉底延迟的判定依据 */
  private hasInputPending(): boolean {
    return !!(this.state.plan || this.state.question);
  }

  /** 结构签名：交互区存在性 + 终态——任一变化都需要全量重渲染才能上屏。
   *  0.20.0 起不含 qa 选中态：选中态变化只走按钮 element_id 级局部更新，全量替换会
   *  清空 form 内未提交的自定义输入（用户点选项时输入框里可能已打了字） */
  private structureKey(): string {
    const s = this.state;
    return JSON.stringify([!!s.confirm, !!s.plan, !!s.question, !!s.done]);
  }
}

/**
 * 飞书错误响应体原文（截断防刷屏）。axios 把 HTTP 400 的业务错误码藏在 e.response.data
 * （300317/99992402 等），e.message 只有 "Request failed with status code 400"——
 * 不提取响应体的话日志无从定位拒绝原因（本次 card is required 事故即如此）。
 *
 * 导出供单元测试使用;不在生产逻辑外暴露。
 */
export function feishuErrorBody(e: unknown): string | undefined {
  const data = (e as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  if (data === undefined || data === null) return undefined;
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * 从 gateway 抛出的 Error 中提取飞书 cardkit 错误码。
 * 优先读 axios 响应体（HTTP 400 场景），回落 message 正则容错匹配——
 * gateway 业务级错误信息形如 `卡片局部更新失败: {"code":300317,"msg":"..."}`。
 * 这里用正则容错匹配 — 不引入新依赖,只对错误信息做最小解析。
 *
 * 导出供单元测试使用;不在生产逻辑外暴露。
 */
export function extractFeishuErrorCode(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const m = /"code"\s*:\s*(\d+)/.exec(feishuErrorBody(e) ?? e.message);
  return m?.[1];
}
