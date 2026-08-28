/** 通道键：chatId 与 userId 拼接，同 chat + 同 user 视为同一会话通道 */
export function channelKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

/**
 * 异步信号量：限制同时在跑的 Claude 任务数。
 * acquire() 返回一个 release 函数，调用后唤醒最早排队者（FIFO）。
 */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private n: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.n) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
