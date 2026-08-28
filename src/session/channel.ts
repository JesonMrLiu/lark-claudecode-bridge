/** 通道键：chatId 与 userId 拼接，同 chat + 同 user 视为同一会话通道 */
export function channelKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

/**
 * 异步信号量：限制同时在跑的 Claude 任务数。
 * acquire() 返回一个 release 函数，调用后唤醒最早排队者（FIFO）。
 *
 * - 许可转移式 release：有等待者时不减 active，直接把许可转移给队首等待者，
 *   消除「release 先减、waiter 恢复后加」的 microtask 窗口内被新 acquire 插队超发。
 * - 每个 release 带 once 保护：重复调用为 no-op，防止 active 递减为负。
 */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private n: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.n) {
      this.active++;
    } else {
      // 排队等待；许可由 release() 原地转移（active 保持），唤醒后不再自增
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // 重复释放为 no-op
      released = true;
      const next = this.waiters.shift();
      if (next) next(); // 许可直接转移给队首等待者，active 不变
      else this.active--;
    };
  }
}
