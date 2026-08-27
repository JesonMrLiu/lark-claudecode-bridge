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
    this.flushTimer = setInterval(() => void this.flush(), interval);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt >= (this.opts.idleHeartbeatMs ?? 30_000)) {
        void this.flush(); // 心跳：刷新运行时长，证明没卡死
      }
    }, 1000);
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
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.messageId) return;
    if (this.buffer) {
      this.state.textTail += this.buffer;
      this.buffer = '';
    }
    try {
      await this.sender.updateCard(this.messageId, buildProgressCard(this.state));
    } catch {
      // 单次 PATCH 失败不致命（限流/网络抖动），下轮重试
    }
  }
}
