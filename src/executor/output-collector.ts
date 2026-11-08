// 产出收集器：跟踪任务过程中写文件工具产出的文件路径（去重，仅工作区内文件）
import { isAbsolute, relative, resolve } from 'node:path';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export class OutputCollector {
  private seen = new Set<string>();
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
  }

  track(toolName: string, input: Record<string, unknown>): void {
    if (!WRITE_TOOLS.has(toolName)) return;
    // NotebookEdit 用 notebook_path，Write/Edit 用 file_path
    const p = input.file_path ?? input.notebook_path;
    if (typeof p !== 'string' || !p) return;
    // 只收工作区内文件：plan mode 的计划文件（~/.claude/plans/*.md）、临时目录等
    // 工作区外产物不属于任务产出，不参与图片自动回传与 transcript 记录
    const abs = resolve(this.cwd, p);
    const rel = relative(this.cwd, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return;
    this.seen.add(abs);
  }

  files(): string[] {
    return [...this.seen];
  }
}
