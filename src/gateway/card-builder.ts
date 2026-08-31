import type { CardDecision, ConfirmationRequest, PermissionDecision } from '../types.js';
import { chunkText } from '../util/chunk-text.js';

export interface ProgressState { title: string; status: string; textTail: string; toolLine: string; startedAt: number }

function card(elements: unknown[]): unknown {
  return { schema: '2.0', config: { update_multi: true }, body: { elements } };
}
function md(content: string): unknown {
  return { tag: 'markdown', content };
}
export function buildTextCard(markdown: string): unknown {
  return card([md(markdown)]);
}
/** 图片卡片：caption（可选）显示在图片上方——逐张发图时带编号说明用 */
export function buildImageCard(caption: string | undefined, imgKey: string): unknown {
  const elements: unknown[] = [];
  if (caption) elements.push(md(caption));
  elements.push({ tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: caption ?? '图片' } });
  return card(elements);
}
export function buildProgressCard(state: ProgressState): unknown {
  const elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const lines = [`**${state.title}**`, ``, state.status, ``];
  if (state.toolLine) lines.push(`🔧 ${state.toolLine}`, ``);
  if (state.textTail) lines.push('---', state.textTail.slice(-1200)); // 只保留尾部，防爆卡片
  lines.push(``, `<font color='grey'>⏱ 已运行 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒</font>`);
  return card([md(lines.join('\n'))]);
}
export function buildConfirmCard(req: ConfirmationRequest): unknown {
  const body = req.diff
    ? `\`\`\`diff\n${req.diff.slice(0, 1500)}\n\`\`\``
    : `\`\`\`\n${req.summary.slice(0, 1500)}\n\`\`\``;
  const button = (decision: 'allow' | 'deny' | 'allow-session') => ({
    tag: 'button',
    text: { tag: 'plain_text', content: decision === 'allow' ? '✅ 允许' : decision === 'deny' ? '❌ 拒绝' : '⏭ 本次会话不再询问' },
    type: decision === 'allow' ? 'primary' : decision === 'deny' ? 'danger' : 'default',
    behaviors: [{ type: 'callback', value: { requestId: req.requestId, decision } }],
  });
  return card([
    md(`**🔐 Claude 请求执行操作**\n\n工具: \`${req.toolName}\`　工作区: \`${req.workspaceName}\`\n${body}`),
    {
      // 卡片 V2 已废弃 tag:'action' 交互模块，改用 column_set 分栏实现按钮并排
      tag: 'column_set',
      flex_mode: 'flow',
      columns: (['allow', 'deny', 'allow-session'] as const).map((decision) => ({
        tag: 'column', width: 'auto', weight: 1, vertical_align: 'top',
        elements: [button(decision)],
      })),
    },
  ]);
}
export const DECISION_TEXT: Record<PermissionDecision, string> = {
  allow: '✅ 已允许',
  deny: '❌ 已拒绝',
  'allow-session': '⏭ 本次会话不再询问',
};
export function buildConfirmResultCard(req: ConfirmationRequest, decision: PermissionDecision, byName: string): unknown {
  // 摘要截断与确认卡一致（1500）：点击瞬间回调响应内联换卡，摘要突然缩水会被用户看到
  return card([md(`**🔐 Claude 请求执行操作**\n\n工具: \`${req.toolName}\`　工作区: \`${req.workspaceName}\`\n\`\`\`\n${req.summary.slice(0, 1500)}\n\`\`\`\n\n${DECISION_TEXT[decision]}（由 ${byName} 操作）`)]);
}

// ---------- plan 确认卡片（code-dev 工作区的计划审批流） ----------

export interface PlanCardRequest { requestId: string; plan: string; workspaceName: string }

export type PlanCardDecision = Extract<CardDecision, `plan-${string}`>;

function planButton(decision: PlanCardDecision, label: string, type: string, requestId: string): unknown {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value: { requestId, decision } }],
  };
}

/**
 * 计划确认卡片组：plan 超长时按 ~2800 字拆多张（首卡含输入框与按钮，其余为纯正文续篇）。
 * 空白 plan 退化为单卡占位（模型未提交实质计划时用户只能放弃）。
 */
export function buildPlanCards(req: PlanCardRequest): unknown[] {
  const chunks = chunkText(req.plan, 2800);
  if (chunks.length === 0) chunks.push('（模型未提交计划正文）');
  return chunks.map((chunk, i) => {
    const header = chunks.length > 1
      ? `**📋 Claude 提交执行计划（${i + 1}/${chunks.length}）**\n\n工作区: \`${req.workspaceName}\`\n`
      : `**📋 Claude 提交执行计划**\n\n工作区: \`${req.workspaceName}\`\n`;
    if (i === 0) {
      return card([
        md(`${header}${chunk}`),
        // 修改意见输入框：plan-revise 点击时随回调 form_value 传回（name=feedback）
        {
          tag: 'input',
          name: 'feedback',
          placeholder: { tag: 'plain_text', content: '修改意见（点「按意见修改」时随意见重新出计划）' },
        },
        {
          // 卡片 V2 已废弃 tag:'action'，与确认卡同款 column_set 分栏按钮
          tag: 'column_set',
          flex_mode: 'flow',
          columns: [
            { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-approve', '✅ 批准执行', 'primary', req.requestId)] },
            { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-revise', '📝 按意见修改', 'default', req.requestId)] },
            { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-reject', '❌ 放弃计划', 'danger', req.requestId)] },
          ],
        },
      ]);
    }
    return card([md(`${header}${chunk}`)]);
  });
}

/** 计划决策结果卡（决策后由回调响应内联 + 兜底 PATCH 首卡） */
export function buildPlanResultCard(req: PlanCardRequest, decision: PlanCardDecision, byName: string, feedback?: string): unknown {
  const text = decision === 'plan-approve'
    ? `✅ 计划已批准，开始执行（由 ${byName} 操作）`
    : decision === 'plan-revise'
      ? `📝 已提交修改意见，Claude 将修订计划后重新提交（由 ${byName} 操作）：\n${(feedback ?? '').slice(0, 500)}`
      : `❌ 计划已放弃（由 ${byName} 操作）`;
  return card([md(`**📋 Claude 提交执行计划**\n\n工作区: \`${req.workspaceName}\`\n\n${text}`)]);
}

/** 计划确认超时卡（此后迟到点击不再改写此卡片） */
export function buildExpiredPlanCard(req: PlanCardRequest, timeoutMs: number): unknown {
  return card([md(`**📋 Claude 提交执行计划**\n\n工作区: \`${req.workspaceName}\`\n\n⏰ 已超时自动放弃（${Math.round(timeoutMs / 60000)} 分钟未确认）`)]);
}
