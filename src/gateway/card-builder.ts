import type { ConfirmationRequest, PermissionDecision } from '../types.js';

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
