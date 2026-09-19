import type { CardDecision, ConfirmationRequest, PermissionDecision } from '../types.js';
import type { AskQuestionRequest } from '../executor/permission-gate.js';

export interface ProgressState {
  title: string;
  status: string;
  toolLine: string;
  startedAt: number;
  done?: boolean;
  /** 终态结果提示行：完整回复的字数（finish 传入）——终态不再渲染回复正文（由收尾独立
   *  多卡直接展示），只留一行「已单独发送」指引，消除折叠看不到与两边重复 */
  resultChars?: number;
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
/** 纯文本卡：宽度跟随调用方传入（gateway 层注入 config.card.width，缺省 default） */
export function buildTextCard(markdown: string, widthMode: 'default' | 'fill' = 'default'): unknown {
  return card([md(markdown)], widthMode);
}
/** 图片卡片：caption（可选）显示在图片上方——逐张发图时带编号说明用；宽度同 buildTextCard */
export function buildImageCard(caption: string | undefined, imgKey: string, widthMode: 'default' | 'fill' = 'default'): unknown {
  const elements: unknown[] = [];
  if (caption) elements.push(md(caption));
  elements.push({ tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: caption ?? '图片' } });
  return card(elements, widthMode);
}
/** 进度卡局部更新的固定组件 ID（cardkit element_id，长度限 1-20）：状态主块 + 计时行。
 *  局部更新只替换这两个 markdown 组件的 content，不触碰 form 组件定义——但真机实测
 *  （0.20.1）实体更新落地时部分客户端仍会重置 form 内未提交输入（官方错误码 200810 亦
 *  表明交互期间流式更新受限），因此挂起输入期间的维持性刷新由 ProgressCard 冻结，不依赖
 *  「局部更新保输入」这一假设 */
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
  } else if (state.done && state.resultChars !== undefined) {
    // 终态不再渲染回复正文：完整回复由收尾逻辑独立多卡直接展示（用户决策），主卡只留一行
    // 指引——消除「折叠前面 N 字符看不到全文」与「卡片/消息两边内容重复」两类问题
    // （原 textTail 尾部 400 字方案，P06 耦合随之消解）。停止/出错终态无 resultChars 不显示
    lines.push('---', `📝 完整回复已单独发送（共 ${state.resultChars.toLocaleString()} 字），见下方消息卡片`);
  }
  return lines;
}

/** 计时行文案——整卡渲染与局部更新共用 */
function buildTimerLine(state: ProgressState): string {
  // 挂起等待用户输入（plan 意见框 / qa 作答）期间维持性刷新被冻结、计时停走——必须显式
  // 标注暂停及恢复条件，不可静默停止（停走的计时读起来像「已结束/卡死」，用户分不清）
  if (state.plan) return `<font color='grey'>⏸ 计时已暂停 · 计划确认后恢复</font>`;
  if (state.question) return `<font color='grey'>⏸ 计时已暂停 · 提交答案后恢复</font>`;
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
        { tag: 'input', name: 'feedback', width: 'fill', multiline: true, rows: 3, max_length: 1000, placeholder: { tag: 'plain_text', content: '修改意见（点「按意见修改」时随意见重新出计划，可多行）' } },
      ],
    });
  }
  // 内嵌提问确认区（#3 + 0.20.0）：整个区域包进一个 form——飞书 input 值必须 form 容器 +
  // submit 按钮才回传。每题：标题 + 选项按钮（普通 callback，仅 qa-pick 切选中态，不提交表单）
  // + 自定义输入框（custom_N）；底部「提交答案」为 submit 按钮，form_value 携带全部输入。
  // 合并语义（wiring 侧）：单选 custom 优先覆盖选项，多选 custom 追加进选中数组
  if (state.question) {
    const q = state.question;
    const formElements: unknown[] = [
      md(`**❓ Claude 需要你确认** · 工作区 \`${q.workspaceName}\`\n\n点选选项，或在每题下方输入框填写其他答案（单选：输入优先；多选：输入追加），完成后点「提交答案」`),
    ];
    q.questions.forEach((qq, qIndex) => {
      const sel = q.answers[qIndex];
      const picked = Array.isArray(sel) ? sel : sel !== undefined ? [sel] : [];
      formElements.push(md(`**${qIndex + 1}. ${qq.question}**${qq.multiSelect ? '（可多选）' : ''}`));
      qq.options.forEach((o, optIndex) => {
        formElements.push(embeddedQaOptionButton(q.requestId, qIndex, optIndex, o.label, picked.includes(o.label)));
      });
      formElements.push({
        tag: 'input',
        name: `custom_${qIndex}`,
        width: 'fill',
        multiline: true,
        rows: 2,
        max_length: 500,
        placeholder: { tag: 'plain_text', content: '其他答案（可选）：单选时优先生效，多选时与选项合并' },
      });
    });
    formElements.push({
      tag: 'button',
      // form 容器内交互组件 name 必填（卡片内全局唯一），否则 form 数据发送失败
      name: 'qa_btn_submit',
      text: { tag: 'plain_text', content: '✅ 提交答案' },
      type: 'primary',
      form_action_type: 'submit',
      margin: '8px 0px 0px 0px',
      behaviors: [{ type: 'callback', value: { requestId: q.requestId, decision: 'qa-submit' } }],
    });
    elements.push({ tag: 'form', name: 'qa_form', elements: formElements });
  }
  // 计时行上方加分隔横线，与正文/确认区做视觉划分
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'markdown', content: buildTimerLine(state), element_id: TIMER_ELEMENT_ID });
  return card(elements, widthMode);
}

/**
 * qa 选项按钮级局部更新 actions（cardkit partial_update_element）：仅 qa_opt_* 按钮的
 * 文案（✓ 前缀）与样式（primary/default），不含 main/timer——0.20.1 起这是挂起输入冻结
 * 期间的唯一放行通道（用户刚点选项按钮的即时反馈，最小触碰 form 未提交输入）。
 * question 未挂起时返回空数组（调用方需空判后视同冻结跳过）。
 */
export function buildQaButtonActions(state: ProgressState): Array<{ action: string; params: { element_id: string; partial_element: unknown } }> {
  if (!state.question) return [];
  const q = state.question;
  const actions: Array<{ action: string; params: { element_id: string; partial_element: unknown } }> = [];
  q.questions.forEach((qq, qIndex) => {
    const sel = q.answers[qIndex];
    const picked = Array.isArray(sel) ? sel : sel !== undefined ? [sel] : [];
    qq.options.forEach((o, optIndex) => {
      const selected = picked.includes(o.label);
      actions.push({
        action: 'partial_update_element',
        params: {
          element_id: qaOptionElementId(qIndex, optIndex),
          // 按钮可局部更新的字段：文案（✓ 前缀）与样式（primary/default）
          partial_element: { text: { tag: 'plain_text', content: selected ? `✓ ${o.label}` : o.label }, type: selected ? 'primary' : 'default' },
        },
      });
    });
  });
  return actions;
}

/**
 * 局部更新 actions（cardkit batch_update 的 partial_update_element）：替换状态主块与
 * 计时行两个 markdown 组件的 content。仅结构未变化且无挂起输入时使用（结构变化走全量
 * 替换；挂起期间维持性刷新由 ProgressCard 冻结——真机实测实体更新落地会重置 form 未提交
 * 输入，见 MAIN_ELEMENT_ID 处注释）。
 * includeQaButtons=true 时追加 qa 选项按钮的局部替换（选中态变化不触发全量替换——那会
 * 清空 form 内未提交的自定义输入，改走按钮 element_id 级局部更新）。
 */
export function buildPartialUpdateActions(state: ProgressState, includeQaButtons = false): Array<{ action: string; params: { element_id: string; partial_element: unknown } }> {
  const actions: Array<{ action: string; params: { element_id: string; partial_element: unknown } }> = [
    { action: 'partial_update_element', params: { element_id: MAIN_ELEMENT_ID, partial_element: { content: buildMainLines(state).join('\n') } } },
    { action: 'partial_update_element', params: { element_id: TIMER_ELEMENT_ID, partial_element: { content: buildTimerLine(state) } } },
  ];
  if (includeQaButtons) actions.push(...buildQaButtonActions(state));
  return actions;
}
export const DECISION_TEXT: Record<PermissionDecision, string> = {
  allow: '✅ 已允许',
  deny: '❌ 已拒绝',
  'allow-session': '⏭ 本次会话不再询问',
};

// ---------- plan 确认（内嵌主进度卡的审批流，独立计划卡已停用删除） ----------

export interface PlanCardRequest { requestId: string; plan: string; workspaceName: string }

export type PlanCardDecision = Extract<CardDecision, `plan-${string}`>;

function planButton(decision: CardDecision, label: string, type: string, requestId: string, name: string): unknown {
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

/** qa 选项按钮的 cardkit element_id（局部更新定位用）：字母开头/仅字母数字下划线/≤20 字符 */
function qaOptionElementId(qIndex: number, optIndex: number): string {
  return `qa_opt_${qIndex}_${optIndex}`;
}

/** 内嵌提问按钮（qa-pick callback）：form 内普通回传按钮（不带 form_action_type，点击仅切换
 *  选中态不提交表单）；name/element_id 必备——前者是 form 数据回传要求，后者供 cardkit
 *  partial_update_element 局部替换选中态视觉（✓ + primary），不清空 form 内未提交输入 */
function embeddedQaOptionButton(reqId: string, qIndex: number, optIndex: number, label: string, selected: boolean): unknown {
  return {
    tag: 'button',
    name: `qa_pick_${qIndex}_${optIndex}`,
    element_id: qaOptionElementId(qIndex, optIndex),
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

// ---------- 结论多卡（完整回复分块直接展示） ----------

export interface ResultCardRequest {
  charCount: number;
  workspaceName: string;
}

/** 结论块头部标号行：非尾卡（sendTextTo 文本卡）与尾卡共用同一标题样式，仅位置标号不同 */
export function resultChunkHeader(req: ResultCardRequest, index: number, total: number): string {
  return `**📝 完整回复**（${total > 1 ? `${index}/${total} · ` : ''}共 ${req.charCount.toLocaleString()} 字）· 工作区 \`${req.workspaceName}\``;
}

/**
 * 结论尾卡：完整回复多卡的最后一张——末块正文（头部标号行 + 正文，纯展示无交互组件；
 * 想继续对话/提意见直接回复消息即可）。仍走消息卡通道以支持 config.card.width 与头部加粗渲染。
 */
export function buildResultTailCard(
  req: ResultCardRequest,
  chunkContent: string,
  pos: { index: number; total: number },
  widthMode: 'default' | 'fill' = 'default',
): unknown {
  return card([md(`${resultChunkHeader(req, pos.index, pos.total)}\n\n${chunkContent}`)], widthMode);
}

// ---------- 工作区切换卡（裸 /ws）：左按钮右路径一行一工作区，点击即切换，切换后整卡终态 ----------

export interface WorkspaceCardRequest {
  requestId: string;
  workspaces: Array<{ name: string; path: string }>;
  currentName: string;
}

/** 工作区按钮：文案即工作区名（点击即切换，同 QA 选项卡的「按钮即选项」模式），width fill
 *  填满所在列保住点击面积；当前项 ✓+primary+disabled 不可点。只用 disabled（消息卡 2.0
 *  通用），不带 disabled_reason 等 cardkit 实体卡专属字段——旧版 im.message.create 的
 *  interactive 卡不识别未知字段 */
function wsSwitchButton(requestId: string, name: string, current: boolean): unknown {
  return {
    tag: 'button',
    width: 'fill',
    text: { tag: 'plain_text', content: current ? `✓ ${name}（当前）` : name },
    type: current ? 'primary' : 'default',
    ...(current ? { disabled: true } : {}),
    behaviors: [{ type: 'callback', value: { requestId, decision: 'ws-switch' as CardDecision, ws: name } }],
  };
}

/** 工作区选择卡：每个工作区一行 column_set——左列 30% 整宽按钮（点击即切换），右列 70%
 *  灰色路径（仅名字无法区分各工作区对应目录，路径上卡面后免切错），两列垂直居中、长路径
 *  自动换行；固定百分比列宽（非 flow）保证多行按钮纵向对齐。回调侧按按钮 value.ws 定位
 *  目标；卡片体量随工作区数线性增长（典型 2-5 个远低于单卡 30KB 上限，量级失控时再折叠
 *  为 markdown 列表） */
export function buildWorkspaceCard(req: WorkspaceCardRequest, widthMode: 'default' | 'fill' = 'default'): unknown {
  const elements: unknown[] = [
    md(`**📁 选择工作区**（当前：**${req.currentName}**）\n<font color='grey'>点击工作区名直接切换；切换后自动开启新会话（历史保留，/resume 可切回）</font>`),
  ];
  for (const w of req.workspaces) {
    elements.push({
      tag: 'column_set',
      columns: [
        { tag: 'column', width: '30%', vertical_align: 'center', elements: [wsSwitchButton(req.requestId, w.name, w.name === req.currentName)] },
        { tag: 'column', width: '70%', vertical_align: 'center', elements: [md(`<font color='grey'>\`${w.path}\`</font>`)] },
      ],
    });
  }
  return card(elements, widthMode);
}

/** 工作区切换完成终态卡：纯 markdown 无交互组件——一次性选择语义（点过即定），再切重发 /ws */
export function buildWorkspaceSwitchedCard(name: string, path: string, widthMode: 'default' | 'fill' = 'default'): unknown {
  return card([
    md(`✅ 已切换到工作区：**${name}**（\`${path}\`）\n<font color='grey'>已自动开启新会话（历史保留，/resume 可切回）；再次切换请重发 /ws</font>`),
  ], widthMode);
}
