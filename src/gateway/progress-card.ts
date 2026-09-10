import { buildProgressCard, buildPartialUpdateActions, type ProgressState } from './card-builder.js';
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

export class ProgressCard {
  private messageId?: string;
  /** 卡片实体 ID（cardkit 实体模式）：非空时状态刷新走局部更新（保 form 输入），结构变化走全量替换 */
  private cardId?: string;
  /** cardkit 操作序号：同一实体的每次 update/batch_update 必须严格递增 */
  private seq = 0;
  /** 上次全量渲染的结构签名：交互区（confirm/plan/question）增删、终态、qa 选中态变化都需要全量重渲染 */
  private lastStructure = '';
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
    private opts: { flushIntervalMs?: number; idleHeartbeatMs?: number; cardWidthMode?: 'default' | 'fill' } = {},
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
        console.warn('[进度卡] 卡片实体模式不可用，降级为整卡更新（plan 表单输入可能被心跳清空）：', e instanceof Error ? e.message : e);
      }
    }
    if (!this.messageId) {
      this.messageId = await this.sender.sendCard(initial);
    }
    this.lastStructure = this.structureKey();
    const interval = this.opts.flushIntervalMs ?? 1500;
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
    if (this.done || !this.messageId) return;
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
   * 实体模式下按结构签名分流：结构未变（纯状态/计时/子代理刷新）→ 局部更新
   * （只改 main/timer 两个 markdown 组件，form 输入保留）；结构变化（交互区增删、
   * 终态、qa 选中态）→ 全量替换实体。旧模式（无实体能力）维持整卡 PATCH。
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
        try {
          if (this.cardId && this.sender.partialUpdateCard && this.sender.replaceCard) {
            const structure = this.structureKey();
            if (structure === this.lastStructure) {
              // 纯状态刷新：局部更新，form/按钮区不动（用户输入保留）
              await this.sender.partialUpdateCard(this.cardId, ++this.seq, buildPartialUpdateActions(this.state));
            } else {
              // 结构变化：全量替换实体（form 输入会重置，但这些时刻用户尚未输入或已提交）
              await this.sender.replaceCard(this.cardId, ++this.seq, buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default'));
              this.lastStructure = structure;
            }
          } else {
            await this.sender.updateCard(this.messageId!, buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default'));
          }
        } catch {
          // 单次更新失败不致命（限流/网络抖动/交互进行中 200810），下轮重试
        }
        if (!this.dirty) break; // 落地期间无新请求，收工
      }
    })().finally(() => {
      this.flushing = false;
    });
    return this.flushChain;
  }

  /** 结构签名：交互区存在性 + 终态 + qa 选中态——任一变化都需要全量重渲染才能上屏 */
  private structureKey(): string {
    const s = this.state;
    return JSON.stringify([!!s.confirm, !!s.plan, !!s.question, !!s.done, s.question?.answers ?? null]);
  }
}
