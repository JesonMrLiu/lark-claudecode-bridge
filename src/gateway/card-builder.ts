import type { CardDecision, ConfirmationRequest, PermissionDecision } from '../types.js';
import type { AskQuestionRequest } from '../executor/permission-gate.js';

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
  /** 内嵌计划确认（独立提问卡 #3+#6：方案不再单独发卡，正文收敛为一行 + 内嵌表单按钮 + 「查看完整方案」按钮，原文落盘并通过 send_file 发送） */
  plan?: EmbeddedPlanState;
  /** 内嵌提问确认（AskUserQuestion：选项按钮 + 提交按钮全部在主卡上，qa-pick PATCH 选中态） */
  question?: EmbeddedQuestionState;
}

/** 内嵌计划状态：planFilePath 用于「查看完整方案」回调发送原文 md；plan 原文仅在卡片内露出预览片段（防爆卡片） */
export interface EmbeddedPlanState {
  requestId: string;
  plan: string;
  workspaceName: string;
  planFilePath: string;
}
/** 内嵌提问状态：answers 跟随选项点击 PATCH 更新（multiSelect 时为 string[]） */
export interface EmbeddedQuestionState {
  requestId: string;
  questions: AskQuestionRequest['questions'];
  workspaceName: string;
  answers: Record<number, string | string[]>;
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

function card(elements: unknown[], widthMode: 'default' | 'fill' = 'default'): unknown {
  return { schema: '2.0', config: { update_multi: true, ...(widthMode === 'fill' ? { width_mode: 'fill' } : {}) }, body: { elements } };
}
function md(content: string): unknown {
  return { tag: 'markdown', content };
}
export function buildTextCard(markdown: string): unknown {
  return card([md(markdown)]);
}
/** 进度卡终态结果尾部的字符上限（防爆卡片）。运行中不展示过程文本（产品决策：主卡只留
 *  关键信息——状态/工具/子代理/确认区/计时；思考内容与过程文本一律不进卡），仅任务收尾
 *  露出结果尾部。index.ts 以同一常量判断「短回复是否需要独立结果消息」，两处保持同值，
 *  否则 400–1200 区间内容会卡片/消息两边都不展示 */
export const PROGRESS_TAIL_CHARS = 400;
/** 图片卡片：caption（可选）显示在图片上方——逐张发图时带编号说明用 */
export function buildImageCard(caption: string | undefined, imgKey: string): unknown {
  const elements: unknown[] = [];
  if (caption) elements.push(md(caption));
  elements.push({ tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: caption ?? '图片' } });
  return card(elements);
}
/** 进度卡局部更新的固定组件 ID（cardkit element_id，长度限 1-20）：状态主块 + 计时行。
 *  局部更新只替换这两个 markdown 组件的 content，form/按钮区不触碰——用户在 plan 表单
 *  输入框打的内容不会被状态心跳刷掉（整卡 PATCH 会重置全部客户端输入态） */
export const MAIN_ELEMENT_ID = 'lcb_main';
export const TIMER_ELEMENT_ID = 'lcb_timer';

/** 进度卡主块内容（标题/状态/工具行/子代理清单/收敛提示/终态结果尾部）——整卡渲染与局部更新共用 */
function buildMainLines(state: ProgressState): string[] {
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
  } else if (state.question) {
    // 内嵌提问区同样收敛正文：选项已承载信息，正文尾部继续刷只会冲淡提问区
    lines.push('---', `⏸ 正文已收起，等待下方问题作答后继续…`);
  } else if (state.plan) {
    // 内嵌计划区同理收敛正文
    lines.push('---', `⏸ 正文已收起，等待下方计划确认后继续…`);
  } else if (state.done && state.textTail) {
    // 终态才展示结果尾部（产品决策：运行中过程文本不进卡片，主卡只留关键信息；思考内容
    // 也不采集不展示）。textTail 仍保留全部内容（appendText 不断积累），超长部分由 index.ts
    // 的独立结果消息承载（阈值与本常量同值），渲染层截断不丢内容
    if (state.textTail.length > PROGRESS_TAIL_CHARS) {
      const folded = state.textTail.length - PROGRESS_TAIL_CHARS;
      lines.push('---', `**📝 结果**`, `<font color='grey'>⋯ 已折叠前面 ${folded} 字符</font>`, state.textTail.slice(-PROGRESS_TAIL_CHARS));
    } else {
      lines.push('---', `**📝 结果**`, state.textTail);
    }
  }
  return lines;
}

/** 计时行文案——整卡渲染与局部更新共用 */
function buildTimerLine(state: ProgressState): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const duration = `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
  // 终态改为「总耗时」+ 完成时刻：运行中的「已运行」在停止刷新后读起来仍像在计时，任务
  // 是否结束必须一眼可辨（用户分不清计时停了是完成还是卡死）
  return state.done
    ? `<font color='grey'>⏱ 总耗时 ${duration} · 已结束于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</font>`
    : `<font color='grey'>⏱ 已运行 ${duration}</font>`;
}

export function buildProgressCard(state: ProgressState, widthMode: 'default' | 'fill' = 'default'): unknown {
  const elements: unknown[] = [{ tag: 'markdown', content: buildMainLines(state).join('\n'), element_id: MAIN_ELEMENT_ID }];
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
  // 内嵌计划确认区（#3+#6）：方案正文不进卡片（产品决策：主卡不铺长内容），仅一行就绪提示 +
  // 「查看完整方案」按钮（send_file 发送落盘的原 md）+ 表单（批准/放弃/按意见修改 + 意见输入框）。
  // 用户动线：点按钮看方案文件 → 回卡片选操作
  if (state.plan) {
    elements.push(md(`**📋 执行计划已就绪**（共 ${state.plan.plan.length} 字）· 工作区 \`${state.plan.workspaceName}\`\n\n请先点击下方「📂 查看完整方案」阅读原文，再选择操作`));
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '📂 查看完整方案' },
      type: 'default',
      behaviors: [{ type: 'callback', value: { requestId: state.plan.requestId, decision: 'plan-view-file' } }],
    });
    elements.push({
      tag: 'form',
      name: 'plan_form',
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'flow',
          columns: [
            { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-approve', '✅ 批准执行', 'primary', state.plan.requestId, 'plan_btn_approve')] },
            { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-reject', '❌ 放弃计划', 'danger', state.plan.requestId, 'plan_btn_reject')] },
            { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-revise', '📝 按意见修改', 'default', state.plan.requestId, 'plan_btn_revise')] },
          ],
        },
        { tag: 'input', name: 'feedback', width: 'fill', placeholder: { tag: 'plain_text', content: '修改意见（点「按意见修改」时随意见重新出计划）' } },
      ],
    });
  }
  // 内嵌提问确认区（#3）：选项按钮全宽单行 + 提交按钮；qa-pick PATCH 选中态（✓ + primary），
  // qa-submit 一次性 resolve。点击是 callback（非 form 提交），所以可与 plan/confirm 共存区下同列
  if (state.question) {
    const q = state.question;
    elements.push(md(`**❓ Claude 需要你确认** · 工作区 \`${q.workspaceName}\``));
    q.questions.forEach((qq, qIndex) => {
      const sel = q.answers[qIndex];
      const picked = Array.isArray(sel) ? sel : sel !== undefined ? [sel] : [];
      elements.push(md(`**${qIndex + 1}. ${qq.question}**${qq.multiSelect ? '（可多选）' : ''}`));
      for (const o of qq.options) {
        elements.push(embeddedQaOptionButton(q.requestId, qIndex, o.label, picked.includes(o.label)));
      }
    });
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 提交答案' },
      type: 'primary',
      margin: '8px 0px 0px 0px',
      behaviors: [{ type: 'callback', value: { requestId: q.requestId, decision: 'qa-submit' } }],
    });
  }
  // 计时行上方加分隔横线，与正文/确认区做视觉划分
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'markdown', content: buildTimerLine(state), element_id: TIMER_ELEMENT_ID });
  return card(elements, widthMode);
}

/**
 * 局部更新 actions（cardkit batch_update 的 partial_update_element）：只替换状态主块与
 * 计时行两个 markdown 组件的 content，form/按钮区完全不触碰——用户在 plan 意见输入框
 * 里打的字不会被状态心跳刷掉。仅结构未变化时使用（结构变化走全量替换）。
 */
export function buildPartialUpdateActions(state: ProgressState): Array<{ action: string; params: { element_id: string; partial_element: { content: string } } }> {
  return [
    { action: 'partial_update_element', params: { element_id: MAIN_ELEMENT_ID, partial_element: { content: buildMainLines(state).join('\n') } } },
    { action: 'partial_update_element', params: { element_id: TIMER_ELEMENT_ID, partial_element: { content: buildTimerLine(state) } } },
  ];
}
export const DECISION_TEXT: Record<PermissionDecision, string> = {
  allow: '✅ 已允许',
  deny: '❌ 已拒绝',
  'allow-session': '⏭ 本次会话不再询问',
};

// ---------- plan 确认（内嵌主进度卡的审批流，独立计划卡已停用删除） ----------

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

/** 内嵌提问按钮（qa-pick callback）：与独立卡片同款「选中 ✓ + primary」视觉，qa-pick 不消耗挂起项，仅 PATCH 选中态 */
function embeddedQaOptionButton(reqId: string, qIndex: number, label: string, selected: boolean): unknown {
  return {
    tag: 'button',
    width: 'fill',
    text: { tag: 'plain_text', content: selected ? `✓ ${label}` : label },
    type: selected ? 'primary' : 'default',
    behaviors: [{ type: 'callback', value: { requestId: reqId, decision: 'qa-pick' as const, qIndex, option: label } }],
  };
}

// ---------- 提问类型（AskUserQuestion 内嵌主进度卡的选项区，独立提问卡已停用删除） ----------

export interface QuestionCardRequest {
  requestId: string;
  questions: AskQuestionRequest['questions'];
  workspaceName: string;
}

/** 已选答案的中间态（wiring 侧维护）：问题下标 → 选中的 option label（multiSelect 为数组） */
export type QuestionCardAnswers = Record<number, string | string[]>;
