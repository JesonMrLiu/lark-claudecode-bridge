// 权限闸：只读工具直通，写操作经 ask 回调询问（飞书卡片确认），带超时自动拒绝与会话级记忆
import { randomUUID } from 'node:crypto';
import type { ConfirmationRequest, PermissionDecision } from '../types.js';

// 会话内免询问的只读工具白名单（不含任何写文件/执行类工具）
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch',
]);

// 超时默认 10 分钟：飞书端可能长时间无人点击卡片
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// 与 claude-executor 的 canUseTool 判别联合对齐（deny 分支 message 必填）
export type GateDecision = { behavior: 'allow'; message?: string } | { behavior: 'deny'; message: string };

// 内部哨兵：区分「超时拒绝」与「用户主动拒绝」，便于给出准确原因
const TIMED_OUT: unique symbol = Symbol('timed-out');
type AskOutcome = PermissionDecision | typeof TIMED_OUT;

export class PermissionGate {
  private remembered = new Set<string>();

  constructor(
    private opts: { ask: (req: ConfirmationRequest) => Promise<PermissionDecision>; timeoutMs?: number },
  ) {}

  async decide(toolName: string, input: Record<string, unknown>, workspaceName: string): Promise<GateDecision> {
    if (READ_ONLY_TOOLS.has(toolName)) return { behavior: 'allow' };
    if (this.remembered.has(toolName)) return { behavior: 'allow' };
    const req: ConfirmationRequest = {
      requestId: randomUUID(),
      toolName,
      summary: typeof input.command === 'string' ? input.command
        : typeof input.file_path === 'string' ? input.file_path
        : JSON.stringify(input).slice(0, 800),
      workspaceName,
    };
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 持 timer handle：ask 及时答复后主动清理，避免常驻进程中每个已答复 decide 留一个最长 10 分钟的存活 timer
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      timer.unref();
    });
    let decision: AskOutcome;
    try {
      decision = await Promise.race<AskOutcome>([this.opts.ask(req), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
    if (decision === 'allow-session') this.rememberSession(toolName);
    if (decision === TIMED_OUT) {
      return { behavior: 'deny', message: `确认超时（${Math.round(timeoutMs / 60000)} 分钟未响应），已自动拒绝 ${toolName}` };
    }
    if (decision === 'deny') return { behavior: 'deny', message: `用户在飞书端拒绝了本次操作（${toolName}）` };
    return { behavior: 'allow' };
  }

  rememberSession(toolName: string): void {
    this.remembered.add(toolName);
  }

  reset(): void {
    this.remembered.clear();
  }
}
