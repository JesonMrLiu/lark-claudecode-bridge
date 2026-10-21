import type { CardDecision, ConfirmationRequest, PermissionDecision, TodoItemStatus } from '../types.js';
import type { AskQuestionRequest } from '../executor/permission-gate.js';

/** 任务阶段：驱动卡片彩色 header 模板与状态行色点 */
export type TaskPhase = 'boot' | 'running' | 'waiting' | 'done' | 'stopped' | 'error';

/** 工具调用明细行（折叠面板/工具清单内的一行） */
export interface ToolStep {
  /** 原始工具名（Read / Write / Bash / mcp__…，toolResult 匹配用） */
  name: string;
  /** 人类化标签（读取文件 / 执行命令 …；MCP 名自动缩短） */
  label: string;
  /** 操作对象摘要（命令 / 路径 / 查询） */
  summary: string;
  ok: boolean | 'running';
}

/** 「刚完成」命令行（↳ 灰）的归属数据：工具落定时记到所属条目，下一条工具开始前保持显示 */
export interface RecentTool { label: string; summary: string }

/** TodoWrite 待办驱动的执行步骤：步骤式进度卡的版面主体 */
export interface TaskStep {
  /** 步骤标题（TodoWrite content，同时是工具归组键） */
  title: string;
  /** 进行时描述（TodoWrite activeForm，active 步骤优先展示） */
  activeLabel?: string;
  status: 'pending' | 'active' | 'done';
  /** 归属到该步骤的工具调用（步骤切换期间发生的调用归当时 active 步骤） */
  tools: ToolStep[];
  /** 首次转入 active 的时刻（v5 倒序执行栈的排序键；跨 TodoWrite 保留） */
  activatedAt?: number;
  /** 最近一次落定的工具（↳ 刚完成 行归属本步骤；步骤完成即收起） */
  recent?: RecentTool;
}

/** 子代理/后台任务（task_started / task_notification 驱动的一等步骤） */
export interface SubagentTask {
  id: string;
  description: string;
  type: string;
  startedAt: number;
  status: 'running' | 'done' | 'failed' | 'stopped';
  /** 落定时的任务自述结论（task_notification.summary，截断展示） */
  summary?: string;
  /** 子代理内发生的工具调用（parent_tool_use_id 归组；CLI 未转发时为空，仅展示运行秒数） */
  tools: ToolStep[];
  /** 最近一次落定的工具（↳ 刚完成 行归属本子代理；落定即收起） */
  recent?: RecentTool;
}

/** TodoWrite 单项（setTodos 入参，wiring 侧已脱敏） */
export interface TodoItem { content: string; activeForm?: string; status: TodoItemStatus }

export interface ProgressState {
  title: string;
  status: string;
  startedAt: number;
  done?: boolean;
  /** 当前阶段（header 模板色 + 状态行色点） */
  phase: TaskPhase;
  /** 卡片回调定位通道用（存量旧卡展开按钮回调 value 携带；新版卡片仅兜底保留） */
  channelKey?: string;
  /** TodoWrite 待办步骤（未使用待办的小任务为空 → 降级视图：只显示状态与当前动作） */
  steps: TaskStep[];
  /** 子代理/后台任务清单 */
  agents: SubagentTask[];
  /** 未归属步骤的主代理工具（TodoWrite 出现前的准备动作等；仅实体卡面板展示） */
  looseTools: ToolStep[];
  /** 当前/最近一条工具命令（↳ 行）：running=正在使用（蓝，未归属到任何执行栈条目时全局显示）；
   *  done=刚完成（灰，仅无步骤/子代理的降级视图使用——栈模式下由条目自身的 recent 承载） */
  runningTool?: { label: string; summary: string; state: 'running' | 'done' };
  /** 模型思考期（💭 处理中…）：CLI status=requesting 心跳置位，首个执行事件即焚。
   *  v5 替代旧「等待模型响应…」笼罩性状态行 */
  thinking?: boolean;
  /** 运行心跳（灰色小字，渲染在执行栈与计时行之间）：上下文压缩/等待后台任务/决策结果等
   *  有信息量的状态文案；执行事件（工具/文本/待办）到达即清空 */
  heartbeat?: string;
  /** 终态结果提示行：完整回复的字数（finish 传入）——终态不渲染回复正文（由收尾独立
   *  多卡直接展示），只留一行「已单独发送」指引 */
  resultChars?: number;
  /** 挂起中的工具确认（非空时卡片顶部渲染确认区），决策后置回 undefined */
  confirm?: ConfirmationRequest;
  /** 计划审批挂起（#3+#6）：v5 计划正文与确认卡均独立直发（buildPlanConfirmCard），
   *  本状态只驱动等待阶段（header 变橙 + 计时行「计划确认后恢复」），不再内嵌审批表单 */
  plan?: EmbeddedPlanState;
  /** 内嵌提问确认（AskUserQuestion：选项按钮 + 提交按钮全部在主卡上，qa-pick PATCH 选中态） */
  question?: EmbeddedQuestionState;
}

/** 计划审批挂起元信息：正文与确认动作都在独立卡片上（index 侧 sendPlanContentCards +
 *  buildPlanConfirmCard），进度卡仅需要 requestId 维持挂起语义 */
export interface EmbeddedPlanState {
  requestId: string;
  plan: string;
  workspaceName: string;
}
/** 内嵌提问状态：answers 跟随选项点击 PATCH 更新（multiSelect 时为 string[]） */
export interface EmbeddedQuestionState {
  requestId: string;
  questions: AskQuestionRequest['questions'];
  workspaceName: string;
  answers: Record<number, string | string[]>;
}

/** 单步骤面板内工具明细行上限（卡片体量防爆；超出后计数停止增长） */
export const STEP_TOOLS_MAX = 20;
/** 未归属工具池上限 */
export const LOOSE_TOOLS_MAX = 30;
/** 子代理清单最多渲染条数（超出折叠为「…等共 N 个」） */
const AGENT_LIST_MAX = 5;
/** 展开/收起按钮回调的固定 requestId：新版卡片已无此按钮，仅为存量旧卡回调兜底分流保留 */
export const TOOLS_TOGGLE_REQUEST_ID = 'lcb_tools_toggle';

/** 工具名 → 人类化动作标签（未收录的工具名走 MCP 缩短/原样显示） */
const TOOL_LABELS: Record<string, string> = {
  Read: '读取文件', Write: '修改文件', Edit: '修改文件', Bash: '执行命令',
  Glob: '搜索文件', Grep: '搜索内容', LS: '查看目录', WebFetch: '获取网页',
  WebSearch: '搜索网络', TodoWrite: '更新待办', NotebookEdit: '编辑笔记',
  KillShell: '结束进程', Task: '执行子任务',
};
export function toolLabel(name: string): string {
  const known = TOOL_LABELS[name];
  if (known) return known;
  // MCP 工具名缩短：mcp__plugin_openviking-memory_openviking__list → openviking·list
  if (name.startsWith('mcp__')) {
    const segments = name.slice('mcp__'.length).split('__').filter(Boolean);
    const tool = segments[segments.length - 1] ?? name;
    if (segments.length >= 2) {
      let server = segments[segments.length - 2].replace(/^plugin_/, '');
      if (server.includes('_')) server = server.slice(server.lastIndexOf('_') + 1);
      return `${server}·${tool}`.slice(0, 32);
    }
    return tool;
  }
  return name;
}

/** 阶段 → 卡片 header 模板色（飞书 header.template 枚举）：整卡状态一眼可辨 */
const PHASE_TEMPLATE: Record<TaskPhase, string> = {
  boot: 'blue', running: 'blue', waiting: 'orange',
  done: 'green', stopped: 'grey', error: 'red',
};

/** 常用标记与次要信息样式。
 *  执行栈条目用 emoji 状态符（v5：飞书原生渲染、视觉更醒目）——🔄 进行中（可多个并存=并行）
 *  ✅ 已完成 ❌ 失败 ⬜ 未执行 ⏹ 停止/未完成；折叠面板明细行保留 ✓/✗ 命名色（小尺寸更清爽） */
const OK_MARK = `✅`;
const ERR_MARK = `❌`;
const RUN_MARK = `🔄`;
const HALT_MARK = `⏹`;
const PEND_MARK = `⬜`;
const OK_TICK = `<font color='green'>✓</font>`;
const ERR_TICK = `<font color='red'>✗</font>`;
const GREY = (s: string): string => `<font color='grey'>${s}</font>`;

function card(elements: unknown[], widthMode: 'default' | 'fill' = 'default', header?: { title: string; template: string }): unknown {
  return {
    schema: '2.0',
    config: { update_multi: true, ...(widthMode === 'fill' ? { width_mode: 'fill' } : {}) },
    ...(header ? { header: { title: { tag: 'plain_text', content: header.title }, template: header.template } } : {}),
    body: { elements },
  };
}
function md(content: string): unknown {
  return { tag: 'markdown', content };
}
/** 纯文本卡：宽度跟随调用方传入（gateway 层注入 config.card.width，缺省 default） */
export function buildTextCard(markdown: string, widthMode: 'default' | 'fill' = 'default'): unknown {
  return card([md(markdown)], widthMode);
}
/** 进度卡沉底后旧卡的迁移提示：撤回失败（权限/网络）时兜底打终态标记，
 *  避免旧卡冻结在中间态被误读成任务中断（1.3.7 真机事故）。宽度同 buildTextCard */
export function buildSinkNoticeCard(title: string, widthMode: 'default' | 'fill' = 'default'): unknown {
  return card([md(`**${title}**\n\n任务仍在正常执行，最新状态请看下方消息。`)], widthMode);
}
/** 图片卡片：caption（可选）显示在图片上方——逐张发图时带编号说明用；宽度同 buildTextCard */
export function buildImageCard(caption: string | undefined, imgKey: string, widthMode: 'default' | 'fill' = 'default'): unknown {
  const elements: unknown[] = [];
  if (caption) elements.push(md(caption));
  elements.push({ tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: caption ?? '图片' } });
  return card(elements, widthMode);
}

/** 进度卡可局部更新的组件 ID（cardkit element_id，字母开头/字母数字下划线/≤20 字符）：
 *  状态行（处理中/启动/终态结论）/ 全局命令行（降级视图）/ 执行栈条目行（每条目一个）/
 *  心跳行 / 计时行 / 收敛提示行。工具折叠面板内容不做局部更新（面板内 element 局部更新
 *  待真机验证），明细随结构变化全量替换刷新 */
export const STATUS_ELEMENT_ID = 'lcb_status';
export const CUR_ELEMENT_ID = 'lcb_cur';
export const HEARTBEAT_ELEMENT_ID = 'lcb_hb';
export const TIMER_ELEMENT_ID = 'lcb_timer';
export const TAIL_ELEMENT_ID = 'lcb_tail';
function itemLineElementId(index: number): string { return `lcb_it_${index}`; }
function itemPanelElementId(index: number): string { return `lcb_pt_${index}`; }
const LOOSE_PANEL_ELEMENT_ID = 'lcb_pt_loose';

/**
 * 状态行（v5 语义）：
 * - 模型思考期：`💭 处理中…`（执行栈顶唯一状态行，首个执行事件即焚）
 * - 启动阶段：灰点 + 启动文案（已接收/会话已建立）
 * - 终态：emoji 结论行置顶（✅ 已完成 / ❌ 出错… / ⏹ 已停止…）
 * - 执行中：空（版面主体=倒序执行栈，不再有「等待模型响应…」等笼罩性状态行）
 */
function buildStatusLine(state: ProgressState): string {
  // 加粗一律用 `**`（飞书卡片 markdown 不渲染 <b> 等 HTML 标签，真机实锤：原样输出）；
  // 状态色由 emoji 自带 + header 模板色承担，不再嵌 <font>（避免标签内嵌套的兼容面）
  if (state.done) {
    const s = (state.status ?? '').trim();
    if (state.phase === 'error') return `**❌ ${s}**`;
    if (state.phase === 'stopped') return `**⏹ ${s}**`;
    return `**✅ ${s}**`;
  }
  if (state.thinking) return `**💭 处理中…**`;
  const s = (state.status ?? '').trim();
  if (s && state.phase === 'boot') return `<font color='grey'>● ${s}</font>`;
  return '';
}

/** 全局命令行（↳）：仅当运行中的工具未归属到任何执行栈条目（无步骤/子代理的降级视图，
 *  或步骤间隙的未归属调用）时显示；栈模式下各条目下方有自己的 ↳ 行 */
function buildCurLine(state: ProgressState): string {
  if (state.done) return '';
  const rt = state.runningTool;
  if (!rt) return '';
  const attributed = state.steps.some((s) => s.tools.some((t) => t.ok === 'running'))
    || state.agents.some((a) => a.tools.some((t) => t.ok === 'running'));
  if (rt.state === 'running') {
    if (attributed) return '';
    return `<font color='blue'>↳</font> 正在使用 **${rt.label}**${rt.summary ? ` ${GREY(rt.summary)}` : ''}`;
  }
  // 刚完成（灰）：仅降级视图保持显示（栈模式下「刚完成」由条目自身 recent 承载）
  if (state.steps.length > 0 || state.agents.length > 0) return '';
  return `<font color='grey'>↳</font> ${GREY(`刚完成 **${rt.label}**${rt.summary ? ` ${rt.summary}` : ''}`)}`;
}

/** 工具明细行（面板/清单内）：运行中蓝 ●，落定 ✓ 绿 / ✗ 红 + 加粗动作 + 灰色对象 */
function toolLine(t: ToolStep): string {
  const target = t.summary ? ` ${GREY(t.summary)}` : '';
  if (t.ok === 'running') return `<font color='blue'>●</font> 正在${t.label}${target}`;
  return `${t.ok ? OK_TICK : ERR_TICK} **${t.label}**${target}`;
}

/** 工具折叠面板（飞书 collapsible_panel：点击 ⌄ 或文案展开，客户端本地行为，不走回调）。
 *  v4 纯文字形态：无边框/无底色/零内边距——只留灰色「已使用 N 个工具」文案 + 紧跟右侧 ⌄
 *  （2026-10-21 真机反馈：带边框圆角渲染成按钮长条，体验差）。仅实体卡（cardkit）通道渲染。
 *  面板内容只放已完成的明细（running 行过滤）——执行中的命令永远只在 ↳ 行，杜绝面板内
 *  残留陈旧「正在执行」行造成的混乱 */
function toolsPanelElement(elementId: string, title: string, tools: ToolStep[]): unknown {
  const settled = tools.filter((t) => t.ok !== 'running').slice(-STEP_TOOLS_MAX);
  return {
    tag: 'collapsible_panel',
    expanded: false,
    padding: '0px 0px 0px 0px',
    vertical_spacing: '4px',
    header: {
      title: { tag: 'markdown', content: GREY(title) },
      vertical_align: 'center',
      padding: '2px 0px 2px 0px',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '12px 12px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    elements: [{ tag: 'markdown', content: settled.map(toolLine).join('\n'), element_id: elementId }],
  };
}

/** 步骤行（v5 执行栈条目）：🔄 进行中（加粗，优先 activeForm，下方跟自己的 ↳ 命令行）/
 *  ✅ 完成 / ⬜ 未执行（灰）；终态时未走完的步骤如实标注（⏹ 未完成 / ⬜ 未执行） */
function stepStackLine(s: TaskStep, state: ProgressState, panelMode: boolean): string {
  if (state.done && s.status === 'active') return `${HALT_MARK} ${GREY(`${s.activeLabel ?? s.title}（未完成）`)}`;
  if (state.done && s.status === 'pending') return `${PEND_MARK} ${GREY(`${s.title}（未执行）`)}`;
  if (s.status === 'active') {
    const label = (s.activeLabel ?? s.title).trim();
    return `${RUN_MARK} **${label}**${stackCurLine(s)}`;
  }
  if (s.status === 'done') {
    // 零工具的完成步骤不显示计数（避免「· 0 个工具」噪音）
    return `${OK_MARK} ${s.title}${!panelMode && s.tools.length > 0 ? GREY(` · ${s.tools.length} 个工具`) : ''}`;
  }
  return `${PEND_MARK} ${GREY(s.title)}`;
}

/** 子代理行（v5：与步骤同级的独立条目，不再并入步骤行）——运行中带秒数（随定时刷新更新），
 *  落定 ✅/❌/⏹ + 结论（去重复前缀） */
function agentStackLine(t: SubagentTask, now: number, state: ProgressState): string {
  if (t.status === 'running') {
    const sec = Math.max(0, Math.floor((now - t.startedAt) / 1000));
    return `${RUN_MARK} **${t.description}**${GREY(` · 子代理（已运行 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒）`)}${stackCurLine(t)}`;
  }
  const mark = t.status === 'done' ? OK_MARK : t.status === 'failed' ? ERR_MARK : HALT_MARK;
  let suffix = GREY(' · 子代理');
  if (t.summary) {
    const s = t.summary.slice(0, 80);
    // 描述重复前缀（如 desc='Agent' 且 summary 以 'Agent …' 开头）只保留一份
    const deduped = t.description && s.toLowerCase().startsWith(t.description.toLowerCase())
      ? s.slice(t.description.length).trimStart()
      : s;
    if (deduped) suffix += GREY(`：${deduped}`);
  }
  return `${mark} ${t.description}${suffix}`;
}

/** 条目自己的 ↳ 命令行（工具归属其下）：优先「正在使用」（蓝，最新一条 running），
 *  无在途工具时「刚完成」（灰，保持到本条目下一条工具开始或条目完成） */
function stackCurLine(t: { tools: ToolStep[]; recent?: RecentTool }): string {
  for (let i = t.tools.length - 1; i >= 0; i--) {
    const x = t.tools[i];
    if (x.ok === 'running') {
      return `\n<font color='blue'>↳</font> 正在使用 **${x.label}**${x.summary ? ` ${GREY(x.summary)}` : ''}`;
    }
  }
  if (t.recent) {
    return `\n<font color='grey'>↳</font> ${GREY(`刚完成 **${t.recent.label}**${t.recent.summary ? ` ${t.recent.summary}` : ''}`)}`;
  }
  return '';
}

/** 进度卡各组件的内容清单：整卡渲染与局部更新共用同一内容源（保证两种路径渲染一致） */
export interface ProgressPartContent {
  status: string;
  /** 全局命令行（↳，仅未归属工具/降级视图非空），空串表示无该组件 */
  cur: string;
  /** 执行栈条目（v5 倒序：步骤与子代理按启动时间混排、最新在上；⬜ 未执行沉底）。
   *  每条目一个 element，工具折叠面板紧跟其下（实体卡模式）。
   *  sig 为结构签名（不含秒数/↳ 行等易变内容）——局部更新路径据此识别结构变化 */
  items: Array<{ id: string; line: string; sig: string; panel?: { id: string; title: string; tools: ToolStep[] } }>;
  /** 子代理超限折叠提示行（…等共 N 个子代理），空串表示无 */
  agentsMore: string;
  /** 运行心跳行（上下文压缩/等待后台任务/决策结果等灰色小字），空串表示无 */
  heartbeat: string;
  /** 收敛提示行（终态指引），空串表示无该组件 */
  tail: string;
  timer: string;
  /** 未归属工具面板（TodoWrite 出现前的准备动作等），无则为 undefined */
  loose?: { id: string; title: string; tools: ToolStep[] };
}

/** 面板内已落定的工具数（running 行不入面板——执行中的命令只在 ↳ 行） */
const settledCount = (tools: ToolStep[]): number => tools.filter((t) => t.ok !== 'running').length;

/** 步骤式内容源：确认区/终态收敛行等所有可变文本都在这里，整卡与局部更新共用。
 *  执行栈排序（v5 倒序）：非 pending 条目（active/done 步骤 + 子代理）按激活时间倒序——
 *  最新在最上；⬜ 未执行步骤保持 TodoWrite 顺序沉底。子代理渲染上限：运行中全部保留，
 *  落定按最近优先补足，超出折叠为「…等共 N 个子代理」计数行 */
export function buildProgressParts(state: ProgressState, panelMode: boolean): ProgressPartContent {
  const now = Date.now();
  type Entry = { sig: string; line: string; at: number; tools: ToolStep[]; desc: string };
  const entries: Entry[] = [];
  const pendings: TaskStep[] = [];
  for (const s of state.steps) {
    if (s.status === 'pending') { pendings.push(s); continue; }
    entries.push({
      sig: `s:${s.title}|${s.status[0]}|t${settledCount(s.tools)}`,
      line: stepStackLine(s, state, panelMode),
      at: s.activatedAt ?? 0,
      tools: s.tools,
      desc: s.title,
    });
  }
  const runningAgents = state.agents.filter((a) => a.status === 'running');
  const settledAgents = state.agents.filter((a) => a.status !== 'running').sort((a, b) => b.startedAt - a.startedAt);
  const agentCap = Math.max(0, AGENT_LIST_MAX - runningAgents.length);
  const shownAgents = [...runningAgents, ...settledAgents.slice(0, agentCap)];
  for (const a of shownAgents) {
    entries.push({
      sig: `a:${a.id}|${a.status[0]}|t${settledCount(a.tools)}`,
      line: agentStackLine(a, now, state),
      at: a.startedAt,
      tools: a.tools,
      desc: a.description,
    });
  }
  entries.sort((x, y) => y.at - x.at); // 倒序：最新在最上（Array.sort 稳定，同刻保插入序）
  const items: ProgressPartContent['items'] = entries.map((e, i) => {
    const part: ProgressPartContent['items'][number] = { id: itemLineElementId(i), line: e.line, sig: e.sig };
    const settled = settledCount(e.tools);
    if (panelMode && settled > 0) part.panel = { id: itemPanelElementId(i), title: `已使用 ${settled} 个工具`, tools: e.tools };
    return part;
  });
  for (const s of pendings) {
    items.push({
      id: itemLineElementId(items.length),
      line: state.done ? `${PEND_MARK} ${GREY(`${s.title}（未执行）`)}` : `${PEND_MARK} ${GREY(s.title)}`,
      sig: `p:${s.title}|p`,
    });
  }
  const agentsMore = state.agents.length > shownAgents.length ? GREY(`…等共 ${state.agents.length} 个子代理`) : '';
  if (agentsMore) {
    items.push({ id: itemLineElementId(items.length), line: agentsMore, sig: `m:${state.agents.length}` });
  }
  const status = buildStatusLine(state);
  const cur = buildCurLine(state);
  const heartbeat = state.heartbeat?.trim() ? GREY(state.heartbeat.trim()) : '';
  // 收敛提示行：仅终态留「完整回复已单独发送」指引（v5 移除挂起期「正文已收起」——
  // 决策区本就置顶/独立成卡，无需再占一行）
  const tail = state.done && state.resultChars !== undefined
    ? `---\n${GREY(`完整回复已单独发送（共 ${state.resultChars.toLocaleString()} 字），见下方消息`)}`
    : '';
  const looseSettled = settledCount(state.looseTools);
  const loose = panelMode && looseSettled > 0
    ? { id: LOOSE_PANEL_ELEMENT_ID, title: `其他操作 · 已使用 ${looseSettled} 个工具`, tools: state.looseTools }
    : undefined;
  return { status, cur, items, agentsMore, heartbeat, tail, timer: buildTimerLine(state), loose };
}

/** 计时行文案——整卡渲染与局部更新共用 */
function buildTimerLine(state: ProgressState): string {
  // 挂起等待用户输入（plan 意见框 / qa 作答）期间维持性刷新被冻结、计时停走——必须显式
  // 标注暂停及恢复条件，不可静默停止（停走的计时读起来像「已结束/卡死」，用户分不清）
  if (state.plan) return GREY('计时已暂停 · 计划确认后恢复');
  if (state.question) return GREY('计时已暂停 · 提交答案后恢复');
  const elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const duration = `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
  // 终态改为「总耗时」+ 完成时刻：运行中的「已运行」在停止刷新后读起来仍像在计时，任务
  // 是否结束必须一眼可辨（用户分不清计时停了是完成还是卡死）
  return state.done
    ? GREY(`总耗时 ${duration} · 已结束于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
    : GREY(`已运行 ${duration}`);
}

/**
 * 进度卡整卡渲染（结构变化 / 沉底重发 / 降级整卡 PATCH 共用）。
 * 版面（v5，自上而下）：确认区（置顶）→ 状态行（💭 处理中/启动/终态结论；执行中为空）
 * → 全局命令行（降级视图）→ 执行栈条目×N（倒序混排，面板穿插其下）→ 未归属工具面板
 * → 心跳行（灰色小字）→ 收敛提示行 → hr → 计时行。
 * 计划审批不再内嵌本卡（v5：独立确认卡 buildPlanConfirmCard 紧跟方案正文直发）。
 * panelMode：仅实体卡（cardkit）通道为 true——工具明细折叠面板（collapsible_panel，需客户端
 * V7.9+）只在已验证支持卡片 JSON 2.0 组件全量的通道渲染；消息卡通道降级为行内计数、无面板。
 */
export function buildProgressCard(state: ProgressState, widthMode: 'default' | 'fill' = 'default', panelMode = false): unknown {
  const parts = buildProgressParts(state, panelMode);
  const elements: unknown[] = [];
  // 决策区置顶：需要用户操作的确认/提问区块放卡片最上方，与下方执行状态区分层——
  // 用户一进卡先看到「要做什么」，不用在一堆状态行里找按钮
  if (state.confirm) {
    const body = state.confirm.diff
      ? `\`\`\`diff\n${state.confirm.diff.slice(0, 1500)}\n\`\`\``
      : `\`\`\`\n${state.confirm.summary.slice(0, 1500)}\n\`\`\``;
    elements.push(md(`**需要你确认**\n\nClaude 想执行以下操作：\n\n工具：\`${state.confirm.toolName}\`\n${body}`));
    const button = (decision: 'allow' | 'deny' | 'allow-session') => ({
      tag: 'button',
      text: { tag: 'plain_text', content: decision === 'allow' ? '允许执行' : decision === 'deny' ? '拒绝' : '本会话不再询问' },
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
  // 内嵌提问确认区（#3 + 0.20.0）：整个区域包进一个 form——飞书 input 值必须 form 容器 +
  // submit 按钮才回传。每题：标题 + 选项按钮（普通 callback，仅 qa-pick 切选中态，不提交表单）
  // + 自定义输入框（custom_N）；底部「提交答案」为 submit 按钮，form_value 携带全部输入。
  // 合并语义（wiring 侧）：单选 custom 优先覆盖选项，多选 custom 追加进选中数组
  if (state.question) {
    const q = state.question;
    const formElements: unknown[] = [
      md(`**需要你补充信息**（${q.questions.length} 题）\n\n点选选项，或在每题下方输入框填写其他答案（单选：输入优先；多选：输入追加），完成后点「提交答案」`),
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
      text: { tag: 'plain_text', content: '提交答案' },
      type: 'primary',
      form_action_type: 'submit',
      margin: '8px 0px 0px 0px',
      behaviors: [{ type: 'callback', value: { requestId: q.requestId, decision: 'qa-submit' } }],
    });
    elements.push({ tag: 'form', name: 'qa_form', elements: formElements });
  }
  // 状态行（💭 处理中 / 启动文案 / 终态结论；执行中为空——版面主体是执行栈）
  elements.push({ tag: 'markdown', content: parts.status, element_id: STATUS_ELEMENT_ID });
  // 全局命令行（仅未归属工具/降级视图非空）
  elements.push({ tag: 'markdown', content: parts.cur, element_id: CUR_ELEMENT_ID });
  // 执行栈条目（倒序混排，每条目一个 element，工具折叠面板穿插其下——「正在使用」的命令行
  // 跟随所属条目，用完转「刚完成」灰显保持）
  for (const it of parts.items) {
    elements.push({ tag: 'markdown', content: it.line, element_id: it.id });
    if (it.panel) elements.push(toolsPanelElement(it.panel.id, it.panel.title, it.panel.tools));
  }
  // 未归属工具面板（TodoWrite 出现前的准备动作等）
  if (parts.loose) elements.push(toolsPanelElement(parts.loose.id, parts.loose.title, parts.loose.tools));
  // 心跳行（上下文压缩/等待后台任务/决策结果等灰色小字；执行事件到达即清空）
  elements.push({ tag: 'markdown', content: parts.heartbeat, element_id: HEARTBEAT_ELEMENT_ID });
  // 收敛提示行（终态指引）：仅非空时渲染
  if (parts.tail) elements.push({ tag: 'markdown', content: parts.tail, element_id: TAIL_ELEMENT_ID });
  // 计时行上方加分隔横线，与正文/决策区做视觉划分
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'markdown', content: parts.timer, element_id: TIMER_ELEMENT_ID });
  return card(elements, widthMode, { title: state.title, template: PHASE_TEMPLATE[state.phase] ?? 'blue' });
}

/**
 * qa 选项按钮级局部更新 actions（cardkit partial_update_element）：仅 qa_opt_* 按钮的
 * 文案（✓ 前缀）与样式（primary/default），不含步骤/计时行——0.20.1 起这是挂起输入冻结
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
 * 局部更新 actions（cardkit batch_update 的 partial_update_element）：状态行、全局命令行、
 * 每个执行栈条目行、心跳行、收敛提示行与计时行的 content 替换。panelMode 必须与整卡渲染
 * 一致——条目行的行内工具计数随面板有无而不同，两种路径内容源若不一致会导致整卡/局部渲染
 * 漂移。工具面板内容不在局部更新内（面板内 element 更新待真机验证），明细随结构变化全量
 * 替换刷新——调用方（progress-card）会对内容未变化的组件做过滤后再发送，避免每秒全量刷
 * 所有 element。
 * includeQaButtons=true 时追加 qa 选项按钮的局部替换（选中态变化不触发全量替换——那会
 * 清空 form 内未提交的自定义输入，改走按钮 element_id 级局部更新）。
 */
export function buildPartialUpdateActions(state: ProgressState, panelMode: boolean, includeQaButtons = false): Array<{ action: string; params: { element_id: string; partial_element: unknown } }> {
  const parts = buildProgressParts(state, panelMode);
  const actions: Array<{ action: string; params: { element_id: string; partial_element: unknown } }> = [
    { action: 'partial_update_element', params: { element_id: STATUS_ELEMENT_ID, partial_element: { content: parts.status } } },
    { action: 'partial_update_element', params: { element_id: CUR_ELEMENT_ID, partial_element: { content: parts.cur } } },
    ...parts.items.map((it) => ({ action: 'partial_update_element' as const, params: { element_id: it.id, partial_element: { content: it.line } } })),
    { action: 'partial_update_element', params: { element_id: HEARTBEAT_ELEMENT_ID, partial_element: { content: parts.heartbeat } } },
  ];
  if (parts.tail) {
    actions.push({ action: 'partial_update_element', params: { element_id: TAIL_ELEMENT_ID, partial_element: { content: parts.tail } } });
  }
  actions.push({ action: 'partial_update_element', params: { element_id: TIMER_ELEMENT_ID, partial_element: { content: parts.timer } } });
  if (includeQaButtons) actions.push(...buildQaButtonActions(state));
  return actions;
}
export const DECISION_TEXT: Record<PermissionDecision, string> = {
  allow: '已允许',
  deny: '已拒绝',
  'allow-session': '本会话不再询问',
};

// ---------- plan 确认（v5：独立橙色确认卡，紧跟方案正文多卡直发；主进度卡不再内嵌审批表单） ----------

export interface PlanCardRequest { requestId: string; plan: string; workspaceName: string }

export type PlanCardDecision = Extract<CardDecision, `plan-${string}`>;

/** 方案要点摘要（确认卡上半部）：取方案正文的非空行提炼前 3 条，单条截断防卡片过长——
 *  只看确认卡这一张也能做决策，不依赖往上翻方案正文 */
export function planSummaryLines(plan: string, max = 3): string[] {
  return plan
    .split('\n')
    .map((l) => l.trim().replace(/^[-*•>\d.、)\s]+/, ''))
    .filter((l) => l.length >= 6)
    .slice(0, max)
    .map((l) => (l.length > 72 ? `${l.slice(0, 72)}…` : l));
}

/**
 * 计划确认卡（v5 独立直发）：橙色 header「执行计划 · 待确认」，上半部方案要点摘要、
 * 下半部审批表单（批准/按意见修改/放弃 + 意见输入框）。由 index 侧 planAsk 在方案正文
 * 多卡落地后紧接着发送——顺序即动线（先方案、后确认），不再依赖主卡强制沉底保证顺序。
 * 走普通消息卡通道（决策后整卡收口为终态卡，无局部更新需求；表单提交语义与原内嵌 form 一致）
 */
export function buildPlanConfirmCard(req: PlanCardRequest, widthMode: 'default' | 'fill' = 'default'): unknown {
  const lines = planSummaryLines(req.plan);
  const summary = lines.length > 0
    ? lines.map((l) => `• ${l}`).join('\n')
    : GREY('方案内容较短，完整正文见上方「执行计划」卡片');
  return card([
    md(`**方案要点**\n${summary}\n${GREY(`完整方案见上方「执行计划」卡片（共 ${req.plan.length.toLocaleString()} 字）`)}`),
    {
      tag: 'form',
      name: 'plan_form',
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'flow',
          columns: [
            { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-approve', '批准执行', 'primary', req.requestId, 'plan_btn_approve')] },
            { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-revise', '按意见修改', 'default', req.requestId, 'plan_btn_revise')] },
            { tag: 'column', width: 'auto', weight: 1, vertical_align: 'top', elements: [planButton('plan-reject', '放弃', 'danger', req.requestId, 'plan_btn_reject')] },
          ],
        },
        { tag: 'input', name: 'feedback', width: 'fill', multiline: true, rows: 3, max_length: 1000, placeholder: { tag: 'plain_text', content: '修改意见（选填）：选择「按意见修改」时随意见一起提交' } },
      ],
    },
  ], widthMode, { title: '执行计划 · 待确认', template: 'orange' });
}

/**
 * 计划确认卡终态收口：决策（批准/按意见修改/放弃/超时自动放弃）落定后整卡 PATCH 为灰色
 * 静态卡——按钮消失防重复点击，决策结果一眼可辨（更新失败仅落日志，不影响流程）
 */
export function buildPlanSettledCard(text: string, widthMode: 'default' | 'fill' = 'default'): unknown {
  return card([
    md(`**${text}**\n${GREY('本卡已收口；任务执行进度见任务进度卡')}`),
  ], widthMode, { title: '执行计划 · 已处理', template: 'grey' });
}

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

/** 结论块头部标号行：尾卡放彩色 header（绿）标题，非尾卡（sendTextTo 文本卡）作为正文首行。
 *  纯文本（不带 **），header plain_text 与 markdown 正文两处共用 */
export function resultChunkHeader(req: ResultCardRequest, index: number, total: number): string {
  return `完整回复（${total > 1 ? `${index}/${total} · ` : ''}共 ${req.charCount.toLocaleString()} 字）`;
}

/**
 * 结论尾卡：完整回复多卡的最后一张——末块正文（绿色 header 标号 + 正文，纯展示无交互组件；
 * 想继续对话/提意见直接回复消息即可）。仍走消息卡通道以支持 config.card.width 与头部渲染。
 */
export function buildResultTailCard(
  req: ResultCardRequest,
  chunkContent: string,
  pos: { index: number; total: number },
  widthMode: 'default' | 'fill' = 'default',
): unknown {
  return card([md(chunkContent)], widthMode, { title: resultChunkHeader(req, pos.index, pos.total), template: 'green' });
}

// ---------- 计划多卡（plan 正文与结论同款两段式直发，无特例按钮） ----------

/** 计划块头部标号行：与 resultChunkHeader 同构（非尾卡文本消息与尾卡共用同一标题文案） */
export function planChunkHeader(req: PlanCardRequest, index: number, total: number): string {
  return `执行计划（${total > 1 ? `${index}/${total} · ` : ''}共 ${req.plan.length.toLocaleString()} 字）`;
}

/**
 * 计划尾卡：计划正文多卡的最后一张——末块正文（蓝色 header 标号 + 正文，纯展示无交互组件；
 * 审批按钮在主进度卡的内嵌 plan 区）。仍走消息卡通道以支持 config.card.width 与头部渲染。
 */
export function buildPlanTailCard(
  req: PlanCardRequest,
  chunkContent: string,
  pos: { index: number; total: number },
  widthMode: 'default' | 'fill' = 'default',
): unknown {
  return card([md(chunkContent)], widthMode, { title: planChunkHeader(req, pos.index, pos.total), template: 'blue' });
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
    md(`**选择工作区**（当前：**${req.currentName}**）\n<font color='grey'>点击工作区名直接切换；切换后自动开启新会话（历史保留，/resume 可切回）</font>`),
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
    md(`已切换到工作区：**${name}**（\`${path}\`）\n<font color='grey'>已自动开启新会话（历史保留，/resume 可切回）；再次切换请重发 /ws</font>`),
  ], widthMode);
}
