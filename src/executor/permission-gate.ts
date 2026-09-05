// 权限闸：白名单工具直通（读工具 + Bash，Bash 另过危险命令黑名单），写操作经 ask 回调
// 询问（飞书卡片确认，带 diff 展示），超时自动拒绝 + 会话级记忆；plan mode 的 ExitPlanMode
// 经 planAsk 回调走计划确认卡片；AskUserQuestion 经 askQuestion 回调走问题选项卡片
import { randomUUID } from 'node:crypto';
import type { ConfirmationRequest, PermissionDecision } from '../types.js';
import { NOTIFY_TOOL_PREFIX } from './notify-server.js';
import { generateFileDiff } from '../util/diff.js';

/**
 * 内置默认免确认工具白名单（config.yaml permissions.allow_tools 缺省值；配置即整体替换）。
 * Bash 默认放行是读场景（ls/cat/grep 等经 Bash 执行）不弹卡的前提，安全性由
 * DEFAULT_DANGEROUS_COMMANDS 黑名单兜底——命中仍弹确认卡。
 * LIST 源列表供 config-defaults 预置写盘（lcb setup / web bootstrap），Set 由其派生，保单源。
 */
export const DEFAULT_ALLOW_TOOLS_LIST: readonly string[] = [
  'Read', 'Glob', 'Grep', 'LS', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch', 'Bash',
];
export const DEFAULT_ALLOW_TOOLS: ReadonlySet<string> = new Set(DEFAULT_ALLOW_TOOLS_LIST);

// 保留旧名导出（含只读子集、不含 Bash）：外部引用与测试的语义锚点
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch',
]);

/**
 * 内置 Bash 危险命令正则源串（permissions.dangerous_commands 缺省值；运行期统一 i flag 编译）。
 * 源串形式供 config-defaults 预置写盘——写出的配置回读后与内置行为逐字一致。
 */
export const DEFAULT_DANGEROUS_COMMAND_SOURCES: readonly string[] = [
  '\\brm\\s+-[a-z]*r[a-z]*f',           // rm -rf / rm -fr / rm -Rf（递归强删）
  '\\brm\\s+-f[a-z]*r',
  '\\bsudo\\s',
  '\\bgit\\s+push\\b[^&|;]*--force',     // 强推覆盖远端
  '\\bgit\\s+reset\\s+--hard',           // 丢弃本地改动
  '\\bmkfs\\b',
  '\\bdd\\s+if=',
  '\\bchmod\\s+777\\b',
  '\\b(curl|wget)\\b[^|;&]*\\|\\s*(ba|z)?sh\\b', // 远程脚本管道执行
  '\\b(shutdown|reboot)\\b',
];

/** 内置 Bash 危险命令正则：对 command 全文匹配（不区分大小写），命中弹确认卡 */
export const DEFAULT_DANGEROUS_COMMANDS: readonly RegExp[] =
  DEFAULT_DANGEROUS_COMMAND_SOURCES.map((s) => new RegExp(s, 'i'));

// 超时默认 10 分钟：飞书端可能长时间无人点击卡片
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// 与 claude-executor 的 canUseTool 判别联合对齐（deny 分支 message 必填；
// allow 分支可带 updatedInput——AskUserQuestion 的用户答案经此回传 CLI）
export type GateDecision =
  | { behavior: 'allow'; message?: string; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** plan 确认请求/结果：approve 放行继续执行（executor 随即切 acceptEdits，写操作免确认）；revise 带意见让模型修订计划；reject 终止 */
export interface PlanAskRequest { plan: string; workspaceName: string }
export type PlanAskResult = { action: 'approve' } | { action: 'revise'; feedback: string } | { action: 'reject' };

/** AskUserQuestion 的问题载荷（SDK input.questions 子集） */
export interface QuestionOption { label: string; description?: string }
export interface QuestionItem { question: string; header?: string; multiSelect?: boolean; options: QuestionOption[] }
/** 提问确认请求：questions 已解析校验（至少 1 问、每问至少 2 选项） */
export interface AskQuestionRequest { questions: QuestionItem[]; workspaceName: string }
/** 提问结果：question → 选中的 option label（multiSelect 为数组）；所有问题必须有答案 */
export type AskQuestionResult = Record<string, string | string[]>;

// 内部哨兵：区分「超时拒绝」与「用户主动拒绝」，便于给出准确原因
const TIMED_OUT: unique symbol = Symbol('timed-out');
type AskOutcome = PermissionDecision | typeof TIMED_OUT;
// 提问超时哨兵（与确认卡的 TIMED_OUT 分开，避免类型纠缠）
const TIMED_OUT_SYM = Symbol('question-timed-out');

/** 生成确认 diff 的写工具集合（NotebookEdit 传入 generateFileDiff 后返回空，保持统一入口） */
const DIFF_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);

/** 解析并校验 AskUserQuestion 的 input.questions；非法结构返回空数组（由调用方 deny） */
export function parseQuestions(input: Record<string, unknown>): QuestionItem[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  const items: QuestionItem[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const question = typeof (q as Record<string, unknown>).question === 'string'
      ? (q as Record<string, unknown>).question as string : '';
    const options = Array.isArray((q as Record<string, unknown>).options)
      ? (q as Record<string, unknown>).options as Array<Record<string, unknown>> : [];
    const parsed = options
      .map((o) => ({
        label: typeof o?.label === 'string' ? o.label : '',
        ...(typeof o?.description === 'string' ? { description: o.description } : {}),
      }))
      .filter((o) => o.label);
    if (question && parsed.length >= 2) {
      items.push({
        question,
        ...(typeof (q as Record<string, unknown>).header === 'string' ? { header: (q as Record<string, unknown>).header as string } : {}),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
        options: parsed,
      });
    }
  }
  return items;
}

export class PermissionGate {
  private remembered = new Set<string>();
  private allowTools: ReadonlySet<string>;
  private dangerousCommands: readonly RegExp[];

  constructor(
    private opts: {
      ask: (req: ConfirmationRequest) => Promise<PermissionDecision>;
      /** plan 确认回调：ExitPlanMode 工具调用时触发；未配置时 ExitPlanMode 一律拒绝（不支持 plan 工作流） */
      planAsk?: (req: PlanAskRequest) => Promise<PlanAskResult>;
      /** 提问回调：AskUserQuestion 工具调用时触发（飞书问题选项卡片）；未配置时一律拒绝并让模型改用文本 */
      askQuestion?: (req: AskQuestionRequest) => Promise<AskQuestionResult>;
      timeoutMs?: number;
      /** 免确认白名单；缺省 DEFAULT_ALLOW_TOOLS */
      allowTools?: ReadonlySet<string>;
      /** Bash 危险命令正则；缺省 DEFAULT_DANGEROUS_COMMANDS */
      dangerousCommands?: readonly RegExp[];
    },
  ) {
    this.allowTools = opts.allowTools ?? DEFAULT_ALLOW_TOOLS;
    this.dangerousCommands = opts.dangerousCommands ?? DEFAULT_DANGEROUS_COMMANDS;
  }

  private isDangerousCommand(input: Record<string, unknown>): boolean {
    const cmd = typeof input.command === 'string' ? input.command : '';
    return cmd ? this.dangerousCommands.some((re) => re.test(cmd)) : false;
  }

  async decide(
    toolName: string,
    input: Record<string, unknown>,
    workspaceName: string,
    ctx?: { suggestions?: unknown[] },
  ): Promise<GateDecision> {
    // lcb-notify 通知工具直通：server 实例由 executeTask 闭包构造，chatId 硬绑定，
    // 模型无法选择接收者（只能发到当前任务发起的聊天），无破坏性，逐张发图不应逐次弹确认卡。
    // 用前缀匹配：后续往 notify server 新增工具自动直通。
    if (toolName.startsWith(NOTIFY_TOOL_PREFIX)) return { behavior: 'allow' };
    // ExitPlanMode：plan mode 的计划确认，永不走白名单/会话记忆（每次计划都必须过用户）
    if (toolName === 'ExitPlanMode') {
      if (!this.opts.planAsk) return { behavior: 'deny', message: '当前环境未配置计划确认流程，无法退出 plan mode' };
      const r = await this.opts.planAsk({ plan: typeof input.plan === 'string' ? input.plan : '', workspaceName });
      if (r.action === 'approve') return { behavior: 'allow' };
      if (r.action === 'revise') return { behavior: 'deny', message: `用户未批准当前计划，要求按以下意见修改后重新提交计划：\n${r.feedback}` };
      return { behavior: 'deny', message: '用户在飞书端放弃了本次计划，请停止执行并等待用户下一步指示' };
    }
    // AskUserQuestion：headless 下 CLI 把问题经 canUseTool 交给宿主，飞书侧渲染问题选项卡片；
    // 用户提交的答案经 updatedInput.answers 回传（官方 user-input 姿势），模型据此继续任务
    if (toolName === 'AskUserQuestion') {
      if (!this.opts.askQuestion) {
        return { behavior: 'deny', message: '当前环境不支持交互式提问卡片，请直接基于任务上下文自行决策并继续（不要向用户提问）' };
      }
      const questions = parseQuestions(input);
      if (questions.length === 0) {
        return { behavior: 'deny', message: 'AskUserQuestion 携带的问题结构不完整（至少 1 个问题、每问至少 2 个选项），请改用文本说明' };
      }
      const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const answers = await this.withTimeout(this.opts.askQuestion({ questions, workspaceName }), timeoutMs);
      if (answers === TIMED_OUT_SYM) {
        return { behavior: 'deny', message: `提问超时（${Math.round(timeoutMs / 60000)} 分钟未响应），请自行决策并继续` };
      }
      return { behavior: 'allow', updatedInput: { questions: input.questions, answers } };
    }
    // 白名单直通；Bash 命中危险命令正则时落到确认卡（安全优先于白名单）
    if (this.allowTools.has(toolName) && !(toolName === 'Bash' && this.isDangerousCommand(input))) {
      return { behavior: 'allow' };
    }
    // 会话记忆同样不能绕过危险命令黑名单（用户对 Bash 点过「不再询问」≠ 授权 rm -rf）
    if (this.remembered.has(toolName) && !(toolName === 'Bash' && this.isDangerousCommand(input))) {
      return { behavior: 'allow' };
    }
    const req: ConfirmationRequest = {
      requestId: randomUUID(),
      toolName,
      summary: typeof input.command === 'string' ? input.command
        : typeof input.file_path === 'string' ? input.file_path
        : JSON.stringify(input).slice(0, 800),
      workspaceName,
      // 写工具带 diff：确认卡直接展示改前/改后（generateFileDiff 失败或无差异返回空，回退 summary）
      ...(DIFF_TOOLS.has(toolName) ? { diff: generateFileDiff(toolName, input) || undefined } : {}),
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

  /** 提问挂起窗（与 ask 同款超时语义）：到点自动跳过，不让任务无限等待 */
  private async withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT_SYM> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof TIMED_OUT_SYM>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT_SYM), timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([p, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  rememberSession(toolName: string): void {
    this.remembered.add(toolName);
  }

  reset(): void {
    this.remembered.clear();
  }
}
