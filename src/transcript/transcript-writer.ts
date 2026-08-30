// 对话内容落盘：用户消息 / Claude 回复 / 工具调用 / 最终结果 全文持久化为 JSONL。
// 布局 <CONFIG_DIR>/transcripts/<appId>/<chatId>/<本地日期>.jsonl，按天分文件即天然轮转。
// 为后续「对话挖掘写 Notion」打底（v:1 版本号为挖掘管道的格式演化留空间）。
// 设计约束：任何写失败只节流告警，绝不向调用方抛出、绝不阻断任务主流程。
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type TranscriptEvent =
  | { v: 1; ts: string; kind: 'user'; app: string; chatId: string; userId: string; workspace?: string; sessionId?: string; text: string }
  | { v: 1; ts: string; kind: 'assistant'; app: string; chatId: string; userId: string; sessionId?: string; text: string }
  | { v: 1; ts: string; kind: 'tool'; app: string; chatId: string; userId: string; sessionId?: string; phase: 'start' | 'result'; tool: string; summary: string; ok: boolean }
  | { v: 1; ts: string; kind: 'result'; app: string; chatId: string; userId: string; workspace?: string; sessionId: string; subtype: 'success' | 'stopped' | 'error'; text: string; producedFiles?: string[]; turns?: number };

/** 落盘记录器 DI 接口：wiring 层依赖此抽象，测试可注入 mock */
export interface TranscriptRecorder {
  user(ev: TranscriptEvent & { kind: 'user' }): void;
  assistant(ev: TranscriptEvent & { kind: 'assistant' }): void;
  tool(ev: TranscriptEvent & { kind: 'tool' }): void;
  result(ev: TranscriptEvent & { kind: 'result' }): void;
}

/** 本地时区日期（避免 toISOString 的 UTC 偏移导致跨天分文件错位） */
export function localDate(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export class TranscriptWriter implements TranscriptRecorder {
  /** 已确认存在的会话目录缓存：避免每行一次 existsSync/mkdirSync syscall */
  private madeDirs = new Set<string>();
  /** 告警节流：同一分钟内最多告警一次（失败风暴不刷屏） */
  private lastWarnMin = 0;

  constructor(private baseDir: string) {}

  user(ev: TranscriptEvent & { kind: 'user' }): void { this.append(ev); }
  assistant(ev: TranscriptEvent & { kind: 'assistant' }): void { this.append(ev); }
  tool(ev: TranscriptEvent & { kind: 'tool' }): void { this.append(ev); }
  result(ev: TranscriptEvent & { kind: 'result' }): void { this.append(ev); }

  private append(ev: TranscriptEvent): void {
    try {
      const dir = join(this.baseDir, ev.chatId);
      if (!this.madeDirs.has(dir)) {
        mkdirSync(dir, { recursive: true });
        this.madeDirs.add(dir);
      }
      appendFileSync(join(dir, `${localDate()}.jsonl`), JSON.stringify(ev) + '\n', 'utf8');
    } catch (e) {
      const min = Math.floor(Date.now() / 60_000);
      if (min !== this.lastWarnMin) {
        this.lastWarnMin = min;
        console.warn('[transcripts] 对话落盘失败（不影响任务执行）：', e instanceof Error ? e.message : e);
      }
    }
  }
}

/** 清理过期落盘：递归删除 baseDir 下 mtime 早于 retentionDays 的 .jsonl，返回删除文件数 */
export function sweepTranscripts(baseDir: string, retentionDays: number): number {
  if (!existsSync(baseDir)) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.jsonl') && statSync(p).mtimeMs < cutoff) {
        unlinkSync(p);
        removed++;
      }
    }
  };
  walk(baseDir);
  return removed;
}
