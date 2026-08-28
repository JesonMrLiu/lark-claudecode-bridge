// 产出收集器：跟踪任务过程中写文件工具产出的文件路径（去重）
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export class OutputCollector {
  private seen = new Set<string>();

  track(toolName: string, input: Record<string, unknown>): void {
    if (!WRITE_TOOLS.has(toolName)) return;
    // NotebookEdit 用 notebook_path，Write/Edit 用 file_path
    const p = input.file_path ?? input.notebook_path;
    if (typeof p === 'string' && p) this.seen.add(p);
  }

  files(): string[] {
    return [...this.seen];
  }
}
