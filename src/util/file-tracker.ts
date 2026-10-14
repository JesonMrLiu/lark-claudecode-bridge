/**
 * 通道级 producedFiles LRU 跟踪器：key=channelKey（chatId+userId），value=该通道最后一次任务产生的非图片文件路径。
 *
 * 设计动机：任务收尾默认不再自动回传非图片文件，改为在 finalText 后追加文件清单（数字编号）；
 * 用户回复清单序号取该文件的本次 diff——按通道 key 取本通道最近一次任务的记录。
 * 用户明确要文件本体时由模型侧 send_file 工具处理（bridge 不做消息文本的点名匹配，提到 ≠ 要文件）。
 *
 * 软上限：单实例最多保留 100 个通道的清单，超出按 Map 插入顺序淘汰最旧键。
 * 进程内存，重启后清空；状态非持久化是有意为之——重启后用户没看到的文件清单本就该重新生成。
 */
export class FileTracker {
  private store = new Map<string, string[]>();
  /** 清单所属工作区根（同键同生命周期：数字取 diff 时按它解析相对路径与 git 命令 cwd） */
  private workspaces = new Map<string, string>();
  /** 通道数软上限 100：单进程长驻，覆盖式 LRU */
  private static readonly MAX_KEYS = 100;

  /** 记录某通道本轮任务的非图片文件清单（覆盖该通道旧值）。
   *  files 为空时清空整键（含 workspace）——空任务不该残留上一轮的清单与编号语义 */
  record(key: string, files: string[], meta?: { workspace?: string }): void {
    if (files.length === 0) {
      this.store.delete(key);
      this.workspaces.delete(key);
      return;
    }
    // LRU 淘汰：超出上限时删最旧键（仅在新键时淘汰，已有键的更新不触发）
    if (this.store.size >= FileTracker.MAX_KEYS && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest) {
        this.store.delete(oldest);
        this.workspaces.delete(oldest);
      }
    }
    this.store.set(key, [...files]);
    if (meta?.workspace) this.workspaces.set(key, meta.workspace);
  }

  /** 读取某通道的非图片文件清单（无值返回空数组） */
  get(key: string): string[] {
    return this.store.get(key) ?? [];
  }

  /** 读取清单所属工作区根（未记录返回 undefined） */
  getWorkspace(key: string): string | undefined {
    return this.workspaces.get(key);
  }
}
