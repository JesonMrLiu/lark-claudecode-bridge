import { buildProgressCard, type ProgressState } from './card-builder.js';

export interface CardSender {
  sendCard(card: unknown): Promise<string>;        // 返回 messageId
  updateCard(messageId: string, card: unknown): Promise<void>;
}

const FLUSH_CHARS = 200;

export class ProgressCard {
  private messageId?: string;
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
    private opts: { flushIntervalMs?: number; idleHeartbeatMs?: number } = {},
  ) {
    this.state = { title, status: '🚀 已接收，启动中…', textTail: '', toolLine: '', startedAt: Date.now() };
  }

  async start(): Promise<void> {
    this.messageId = await this.sender.sendCard(buildProgressCard(this.state));
    const interval = this.opts.flushIntervalMs ?? 1500;
    this.flushTimer = setInterval(() => void this.flush(), interval).unref();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt >= (this.opts.idleHeartbeatMs ?? 30_000)) {
        this.lastActivityAt = Date.now(); // I1 修复：心跳刷过即重置空闲计时，否则退化为每秒连刷
        void this.flush(); // 心跳：刷新运行时长，证明没卡死
      }
    }, 1000).unref();
  }

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

  toolResult(name: string, ok: boolean): void {
    if (this.done) return;
    this.state.toolLine = `${ok ? '✔' : '✘'} ${name}`;
    this.lastActivityAt = Date.now();
  }

  setStatus(status: string): void {
    if (this.done) return;
    this.state.status = status;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  async finish(summary: string): Promise<void> {
    this.done = true;
    clearInterval(this.flushTimer);
    clearInterval(this.heartbeatTimer);
    this.state.status = summary;
    this.state.toolLine = '';
    await this.flush(); // 经由同一串行链落地，保证是最后一张（终态不被旧 flush 覆盖）
  }

  /**
   * 串行化 flush：所有更新走同一条 promise 链按发起顺序落地。
   * - in-flight 中再来请求 → 标记 dirty，本轮落地后自动补刷一次（带上最新 state）；
   * - finish 的终态 flush 也入链，天然排在先前挂起的更新之后。
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
          await this.sender.updateCard(this.messageId!, buildProgressCard(this.state));
        } catch {
          // 单次 PATCH 失败不致命（限流/网络抖动），下轮重试
        }
        if (!this.dirty) break; // 落地期间无新请求，收工
      }
    })().finally(() => {
      this.flushing = false;
    });
    return this.flushChain;
  }
}
