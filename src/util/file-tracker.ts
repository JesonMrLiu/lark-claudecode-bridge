/**
 * 通道级 producedFiles LRU 跟踪器：key=channelKey（chatId+userId），value=该通道最后一次任务产生的非图片文件路径。
 *
 * 设计动机：任务收尾默认不再自动回传非图片文件，改为在 finalText 后追加文件清单；
 * 用户主动说"把 article.md 发给我"时，bridge 按通道 key 取出本通道最近一次任务的非图片文件清单，
 * 命中 basename 即上传 + ack + 从清单中清除已发文件，避免重复发送。
 *
 * 软上限：单实例最多保留 100 个通道的清单，超出按 Map 插入顺序淘汰最旧键。
 * 进程内存，重启后清空；状态非持久化是有意为之——重启后用户没看到的文件清单本就该重新生成。
 */
export class FileTracker {
  private store = new Map<string, string[]>();
  /** 通道数软上限 100：单进程长驻，覆盖式 LRU */
  private static readonly MAX_KEYS = 100;

  /** 记录某通道本轮任务的非图片文件清单（覆盖该通道旧值） */
  record(key: string, files: string[]): void {
    if (files.length === 0) return;
    // LRU 淘汰：超出上限时删最旧键（仅在新键时淘汰，已有键的更新不触发）
    if (this.store.size >= FileTracker.MAX_KEYS && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(key, [...files]);
  }

  /** 读取某通道的非图片文件清单（无值返回空数组） */
  get(key: string): string[] {
    return this.store.get(key) ?? [];
  }

  /**
   * 清除指定通道下若干已发文件；不传 files 则清空整通道。
   * 部分清除后清单变空则删键，避免空 Map 占位。
   */
  clear(key: string, files?: string[]): void {
    if (!files) { this.store.delete(key); return; }
    const cur = this.store.get(key);
    if (!cur) return;
    const remain = cur.filter((f) => !files.includes(f));
    if (remain.length === 0) this.store.delete(key);
    else this.store.set(key, remain);
  }
}