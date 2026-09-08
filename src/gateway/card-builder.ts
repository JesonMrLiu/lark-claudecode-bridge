import type { CardDecision, ConfirmationRequest, PermissionDecision } from '../types.js';
import type { AskQuestionRequest } from '../executor/permission-gate.js';
import { chunkText } from '../util/chunk-text.js';

export interface ProgressState {
  title: string;
  status: string;
  textTail: string;
  toolLine: string;
  startedAt: number;
  done?: boolean;
  /** 挂起中的工具确认（非空时卡片底部渲染确认按钮区、正文收敛），决策后置回 undefined */
  confirm?: ConfirmationRequest;
  /** 子代理/后台任务清单（启动加入、落定标记保留到任务结束） */
  agents: SubagentTask[];
}

/** 子代理/后台任务的卡片展示条目 */
export interface SubagentTask {
  id: string;
  description: string;
  type: string;
  startedAt: number;
  status: 'running' | 'done' | 'failed' | 'stopped';
  /** 落定时的任务自述结论（task_notification.summary，截断展示） */
  summary?: string;
}

/** 子代理清单最多渲染条数（防爆卡片；超出折叠为「…等共 N 个」） */
const AGENT_LIST_MAX = 5;

function card(elements: unknown[]): unknown {
  return { schema: '2.0', config: { update_multi: true }, body: { elements } };
}
function md(content: string): unknown {
  return { tag: 'markdown', content };
}
export function buildTextCard(markdown: string): unknown {
  return card([md(markdown)]);
}
/** 进度卡正文尾部的字符上限（防爆卡片）；任务收尾据此判断短回复是否需要独立结果消息 */
export const PROGRESS_TAIL_CHARS = 1200;
/** 图片卡片：caption（可选）显示在图片上方——逐张发图时带编号说明用 */
export function buildImageCard(caption: string | undefined, imgKey: string): unknown {
  const elements: unknown[] = [];
  if (caption) elements.push(md(caption));
  elements.push({ tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: caption ?? '图片' } });
  return card(elements);
}
export function buildProgressCard(state: ProgressState): unknown {
  const elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const duration = `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
  const lines = [`**${state.title}**`, ``, state.status, ``];
  if (state.toolLine) lines.push(`🔧 ${state.toolLine}`, ``);
  // 子代理/后台任务清单：运行中在前（带已运行时长，随定时刷新更新），落定条目保留到任务结束
  if (state.agents.length > 0) {
    const order: Record<SubagentTask['status'], number> = { running: 0, done: 1, failed: 2, stopped: 3 };
    const sorted = [...state.agents].sort((a, b) => order[a.status] - order[b.status] || a.startedAt - b.startedAt);
    lines.push(`**🤖 子代理任务**`);
    for (const t of sorted.slice(0, AGENT_LIST_MAX)) {
      if (t.status === 'running') {
        const s = Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000));
        lines.push(`- 🏃 ${t.description}（已运行 ${Math.floor(s / 60)} 分 ${s % 60} 秒）`);
      } else {
        const mark = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : '🛑';
        lines.push(`- ${mark} ${t.description}${t.summary ? `：${t.summary.slice(0, 80)}` : ''}`);
      }
    }
    if (sorted.length > AGENT_LIST_MAX) lines.push(`- …等共 ${sorted.length} 个`);
    lines.push(``);
  }
  if (state.confirm) {
    // 等待确认：正文收敛为一行——确认区已展示工具与摘要，正文尾部流式输出与确认内容
    // 大量重叠（尤其 plan mode 下计划文本同时出现在正文与计划卡），收敛避免重复刷屏
    lines.push('---', `⏸ 正文已收起，等待下方确认后继续…`);
  } else if (state.textTail) {
    lines.push('---', `**📝 最新输出**`, state.textTail.slice(-PROGRESS_TAIL_CHARS)); // 只保留尾部，防爆卡片
  }
  const elements: unknown[] = [md(lines.join('\n'))];
  // 工具确认区：嵌入进度卡（按钮在计时行上方）——不再单独发确认卡（旧版独立确认卡与
  // 进度卡正文内容重复、还会把进度卡顶出会话底部）
  if (state.confirm) {
    const body = state.confirm.diff
      ? `\`\`\`diff\n${state.confirm.diff.slice(0, 1500)}\n\`\`\``
      : `\`\`\`\n${state.confirm.summary.slice(0, 1500)}\n\`\`\``;
    elements.push(md(`**🔐 请求执行操作**\n\n工具: \`${state.confirm.toolName}\`\n${body}`));
    const button = (decision: 'allow' | 'deny' | 'allow-session') => ({
      tag: 'button',
      text: { tag: 'plain_text', content: decision === 'allow' ? '✅ 允许' : decision === 'deny' ? '❌ 拒绝' : '⏭ 本次会话不再询问' },
      type: decision === 'allow' ? 'primary' : decision === 'deny' ? 'danger' : 'default',
      behaviors: [{ type: 'callback', value: { requestId: state.confirm!.requestId, decision } }],
    });
    elements.push({
      // 卡片 V2 已废弃 tag:'action' 交互模块，改用 column_set 分栏实现按钮并排
      tag: 'column_set',
      flex_mode: 'flow',
      columns: (['allow', 'deny', 'allow-session'] as const).map((decision) => ({
        tag: 'column', width: 'auto', weight: 1, vertical_align: 'top',
        elements: [button(decision)],
      })),
    });
  }
  // 计时行上方加分隔横线，与正文/确认区做视觉划分
  elements.push({ tag: 'hr' });
  // 终态改为「总耗时」+ 完成时刻：运行中的「已运行」在停止刷新后读起来仍像在计时，任务
  // 是否结束必须一眼可辨（用户分不清计时停了是完成还是卡死）
  elements.push(md(state.done
    ? `<font color='grey'>⏱ 总耗时 ${duration} · 已结束于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</font>`
    : `<font color='grey'>⏱ 已运行 ${duration}</font>`));
  return card(elements);
}
export const DECISION_TEXT: Record<PermissionDecision, string> = {
  allow: '✅ 已允许',
  deny: '❌ 已拒绝',
  'allow-session': '⏭ 本次会话不再询问',
};

// ---------- plan 确认卡片（code-dev 工作区的计划审批流） ----------

export interface PlanCardRequest { requestId: string; plan: string; workspaceName: string }

export type PlanCardDecision = Extract<CardDecision, `plan-${string}`>;

function planButton(decision: PlanCardDecision, label: string, type: string, requestId: string, name: string): unknown {
  return {
    tag: 'button',
    // form 容器内交互组件 name 必填（卡片内唯一）：点击回调据此 + form_value 携带输入框值
    name,
    text: { tag: 'plain_text', content: label },
    type,
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value: { requestId, decision } }],
    // 放弃计划二次确认（confirm 仅对带提交属性的按钮生效）：防误点直接终止
    ...(decision === 'plan-reject'
      ? {
        confirm: {
          title: { tag: 'plain_text', content: '放弃当前计划？' },
          text: { tag: 'plain_text', content: '放弃后 Claude 将停止本计划流程，不会执行任何操作' },
        },
      }
      : {}),
  };
}

/**
 * 计划确认卡片组：plan 超长时按 ~2800 字拆多张（首卡含表单容器，其余为纯正文续篇）。
 * 空白 plan 退化为单卡占位（模型未提交实质计划时用户只能放弃）。
 *
 * 首卡的按钮 + 意见输入框必须包在 tag:'form' 容器内、按钮带 form_action_type:'submit'——
 * 飞书卡片 2.0 中 input 值只有该结构下点击按钮才随 action.form_value 回传，
 * 平铺结构点击任何按钮 form_value 恒空（0.17.0 「按意见修改取不到意见」根因）。
 * 三个按钮都是 submit：批准/放弃忽略意见字段，input 不设 required。
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
        {
          tag: 'form',
          name: 'plan_form',
          elements: [
            {
              // 卡片 V2 已废弃 tag:'action'，与确认卡同款 column_set 分栏按钮
              tag: 'column_set',
              flex_mode: 'flow',
              columns: [
                { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-approve', '✅ 批准执行', 'primary', req.requestId, 'plan_btn_approve')] },
                { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-reject', '❌ 放弃计划', 'danger', req.requestId, 'plan_btn_reject')] },
                { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-revise', '📝 按意见修改', 'default', req.requestId, 'plan_btn_revise')] },
              ],
            },
            // 意见输入框在按钮行下方：先决策后补意见的视觉动线（name=feedback 随 form_value 回传）
            {
              tag: 'input',
              name: 'feedback',
              width: 'fill',
              placeholder: { tag: 'plain_text', content: '修改意见（点「按意见修改」时随意见重新出计划）' },
            },
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

// ---------- 提问卡片（AskUserQuestion 的问题选项卡） ----------

export interface QuestionCardRequest {
  requestId: string;
  questions: AskQuestionRequest['questions'];
  workspaceName: string;
}

/** 已选答案的中间态（wiring 侧维护）：问题下标 → 选中的 option label（multiSelect 为数组） */
export type QuestionCardAnswers = Record<number, string | string[]>;

function qaOptionButton(reqId: string, qIndex: number, label: string, selected: boolean): unknown {
  return {
    tag: 'button',
    // 全宽单行：选项文字完整可见（横排 flow 分栏长文本会被 ellipsis 截断，看不全无法决策）
    width: 'fill',
    text: { tag: 'plain_text', content: selected ? `✓ ${label}` : label },
    type: selected ? 'primary' : 'default',
    behaviors: [{ type: 'callback', value: { requestId: reqId, decision: 'qa-pick' as const, qIndex, option: label } }],
  };
}

/**
 * 提问卡片：每个问题一节（问题文本 + 选项按钮，每选项独占一行全宽、选中态打 ✓），
 * 底部「提交答案」按钮。选项点击仅更新选中态（PATCH 重渲染），全部问题有答案后提交才有效。
 */
export function buildQuestionCard(req: QuestionCardRequest, answers: QuestionCardAnswers): unknown {
  const elements: unknown[] = [md(`**❓ Claude 需要你确认**\n\n工作区: \`${req.workspaceName}\``)];
  req.questions.forEach((q, qIndex) => {
    const sel = answers[qIndex];
    const picked = Array.isArray(sel) ? sel : sel !== undefined ? [sel] : [];
    elements.push(md(`**${qIndex + 1}. ${q.question}**${q.multiSelect ? '（可多选）' : ''}`));
    // JSON 2.0 按钮可直接放 elements：逐个纵排替代旧 column_set flow 横排
    for (const o of q.options) {
      elements.push(qaOptionButton(req.requestId, qIndex, o.label, picked.includes(o.label)));
    }
  });
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '✅ 提交答案' },
    type: 'primary',
    margin: '8px 0px 0px 0px',
    behaviors: [{ type: 'callback', value: { requestId: req.requestId, decision: 'qa-submit' as const } }],
  });
  return card(elements);
}

/** 提交后的结果卡（展示每问的最终答案） */
export function buildQuestionResultCard(req: QuestionCardRequest, answers: QuestionCardAnswers, byName: string): unknown {
  const lines = req.questions.map((q, i) => {
    const a = answers[i];
    const ans = a === undefined ? '（未作答）' : Array.isArray(a) ? a.join('、') : a;
    return `- ${q.question} → **${ans}**`;
  });
  return card([md(`**❓ Claude 需要你确认**\n\n工作区: \`${req.workspaceName}\`\n\n${lines.join('\n')}\n\n✅ 答案已提交（由 ${byName} 操作）`)]);
}

/** 提问超时卡（此后迟到点击不再改写此卡片） */
export function buildExpiredQuestionCard(req: QuestionCardRequest, timeoutMs: number): unknown {
  return card([md(`**❓ Claude 需要你确认**\n\n工作区: \`${req.workspaceName}\`\n\n⏰ 已超时自动跳过（${Math.round(timeoutMs / 60000)} 分钟未响应），Claude 将自行决策继续`)]);
}
