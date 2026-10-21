import {
  buildProgressCard, buildProgressParts, buildSinkNoticeCard, buildPartialUpdateActions, buildQaButtonActions,
  toolLabel, STEP_TOOLS_MAX, LOOSE_TOOLS_MAX,
  type ProgressState, type TaskPhase, type TaskStep, type SubagentTask, type ToolStep, type TodoItem,
} from './card-builder.js';
import type { ConfirmationRequest } from '../types.js';

export interface CardSender {
  sendCard(card: unknown): Promise<string>;        // 返回 messageId
  updateCard(messageId: string, card: unknown): Promise<void>;
  /** 撤回消息（进度卡沉底用）；缺省（旧 gateway/测试 mock）时沉底退化为仅重刷 */
  deleteCard?(messageId: string): Promise<void>;
  /** 卡片实体模式（cardkit）：创建实体并发送，返回 messageId + cardId。
   *  实体卡片支持 batch_update 局部更新——状态刷新只改指定 element_id 组件，
   *  plan 表单输入框的用户输入不会被心跳刷掉。缺省（无权限/旧 gateway）降级整卡 PATCH。 */
  sendCardEntity?(card: unknown): Promise<{ messageId: string; cardId: string }>;
  /** 卡片实体局部更新（batch_update + partial_update_element），sequence 须严格递增 */
  partialUpdateCard?(cardId: string, sequence: number, actions: unknown[]): Promise<void>;
  /** 卡片实体全量替换（结构变化：交互区增删/终态/选中态变化），sequence 须严格递增 */
  replaceCard?(cardId: string, sequence: number, card: unknown): Promise<void>;
}

/** 进度卡初始文案：markStarted 据此识别「尚未进入执行阶段」——首个执行事件到达时切为执行中 */
const INITIAL_STATUS = '已接收，启动中…';
/** init 到达后的启动阶段文案（CLI 进程已起、会话已建，仍在加载上下文/工具）：markSessionReady
 *  切入此态，markStarted 同样允许从此态接管——冷启动大头发生在 init 之前，先让用户看到进程已建立 */
const BOOT_STATUS = '会话已建立，加载上下文与工具中…';
/** 单次卡片更新请求超时：飞书 SDK 的 axios 无超时（timeout=0），请求被网络黑洞时
 *  flush 串行链会无限期挂起（生产实测单次挂 7.4 分钟）——挂起期间计时/交互区全停，
 *  与任务卡死无从区分。到点按失败处理（seq 不推进）下轮重试；若超时请求实际已在
 *  服务端落地，下轮会收 300317 经跳号自愈分支对齐（MAX_SEQ_SKIP 内零成本恢复，无需弃卡重建） */
const UPDATE_TIMEOUT_MS = 30_000;
/** 300317 sequence 错位的单次跳号探测上限：服务端 seq 超前时本地乐观 +1 逐级逼近。
 *  真机观测假阴性（300308 Server Internal Error 但请求实际已落地）均为单次超前 1，
 *  上限 3 足够覆盖；跳满仍未对齐说明错位成因未知，弃卡沉底重建兜底 */
const MAX_SEQ_SKIP = 3;
/** 沉底撤回旧卡失败后的补撤退避：服务端 500/2200 多为秒级瞬态（1.4.1 真机事故：撤回撞
 *  2200 Internal Error 一次即降级，旧卡原样冻结成第二张进度卡），1.2s 后补撤一次，
 *  成功即不产生双卡；仍失败才转「已沉底」迁移标记兜底 */
const DELETE_RETRY_DELAY_MS = 1_200;
/** 「已沉底」迁移标记补打间隔：230020 单消息更新限频（撤回前旧卡刚经历每秒级 seq 重试，
 *  极易触发频控）通常数秒自愈，5s 后补打大概率成功 */
const SINK_NOTICE_RETRY_DELAY_MS = 5_000;
/** 「已沉底」迁移标记补打次数上限（不含首次）：轻量加固定位——固定次数放弃，不引入
 *  常驻弃卡补偿队列（持续重试反而有加剧限频的风险面） */
const SINK_NOTICE_RETRY_MAX = 3;

/** 给单次更新请求加超时闸：到点 reject 由 flush catch 统一按失败重试 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`卡片更新超时(${ms}ms 无响应)，按失败处理下轮重试`)), ms);
    timer.unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export class ProgressCard {
  private messageId?: string;
  /** 卡片实体 ID（cardkit 实体模式）：非空时状态刷新走局部更新（保 form 输入），结构变化走全量替换 */
  private cardId?: string;
  /** cardkit 操作序号：同一实体的每次 update/batch_update 必须严格递增 */
  private seq = 0;
  /** 同一实体连续更新失败计数（任何错误码）：达到阈值放弃该实体沉底式重建，防未知错误死循环刷日志 */
  private consecutiveFailures = 0;
  /** 300317 跳号自愈计数：服务端 seq 超前时本地乐观 +1 逼近，成功推进即清零；单次错位跳满 MAX_SEQ_SKIP 仍失败则弃卡重建 */
  private seqSkipRetries = 0;
  /** 上次全量渲染的结构签名：交互区（confirm/plan/question）增删、终态需要全量重渲染。
   *  0.20.0 起 qa 选中态不进签名（见 structureKey）——改走 partial 按钮级局部更新 */
  private lastStructure = '';
  /** qa 选中态脏标记：updateQuestionAnswer 置位，下一次实体 partial 经按钮级 actions 发出
   *  （挂起冻结期间的唯一例外放行通道）前快照清零，失败在 flush catch 恢复重试。
   *  显式标记取代快照对比——快照在 replace 与求值之间可能被新一轮点击改写（竞态丢刷） */
  private qaButtonsDirty = false;
  /** 挂起输入期间收到的沉底请求（sinkToBottom 会删卡重发清空输入态）：挂起解除后补执行 */
  private deferSink = false;
  /** 「已沉底」迁移标记补打状态：沉底撤回失败 → 迁移标记 PATCH 也失败（典型 230020
   *  单消息更新限频，数秒自愈）时记入，heartbeatTimer 每秒检查、间隔
   *  SINK_NOTICE_RETRY_DELAY_MS 补打，成功或达 SINK_NOTICE_RETRY_MAX 放弃。
   *  单槽位：同刻两张以上旧卡残留概率极低，新沉底覆盖旧记录 */
  private sinkNoticeRetry?: { messageId: string; attempts: number; lastAt: number };
  private state: ProgressState;
  private flushTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private lastActivityAt = Date.now();
  private done = false;
  /** 工具折叠面板模式（仅实体卡/cardkit 通道）：消息卡通道对新组件兼容面未验证，降级不含面板 */
  private panelMode = false;
  /** 局部更新内容缓存（element_id → 上次下发 content）：内容未变的组件跳过，
   *  心跳每秒只刷真正变化的行（默认仅计时行），避免步骤多时触碰 batch_update 频控 */
  private partialCache = new Map<string, string>();
  // C1 修复：flush 单飞串行化——同一时刻最多一个 updateCard in-flight，
  // 期间的新 flush 请求标记 dirty，落地后补刷一次；保证任何时刻后发起的
  // 更新（尤其 finish 终态）永远晚于先前挂起的更新落地。
  private flushChain: Promise<void> = Promise.resolve();
  private dirty = false;
  private flushing = false;

  constructor(
    private sender: CardSender,
    title: string,
    private opts: { flushIntervalMs?: number; idleHeartbeatMs?: number; cardWidthMode?: 'default' | 'fill'; updateTimeoutMs?: number; channelKey?: string } = {},
  ) {
    this.state = {
      title, status: INITIAL_STATUS, startedAt: Date.now(),
      phase: 'boot', steps: [], agents: [], looseTools: [],
      channelKey: opts.channelKey,
    };
  }

  async start(): Promise<void> {
    // 优先卡片实体模式（支持局部更新 → plan 表单输入不被心跳刷掉，且为工具折叠面板的
    // 唯一渲染通道）；创建失败（cardkit:card:write 权限缺失/接口异常）降级为普通卡片 +
    // 整卡 PATCH，功能不退化（面板随之取消，步骤行内联工具计数）
    if (this.sender.sendCardEntity) {
      try {
        const { messageId, cardId } = await this.sender.sendCardEntity(buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default', true));
        this.messageId = messageId;
        this.cardId = cardId;
        this.panelMode = true;
      } catch (e) {
        console.warn('[进度卡] 卡片实体模式不可用，降级为整卡更新（挂起期间状态/计时停更，输入冻结保护仍生效，工具明细不展示折叠面板）。如已开通 cardkit:card:write，需在飞书开发者后台创建新版本并发布、并重启 bridge 后生效。原因：', e instanceof Error ? e.message : e);
      }
    }
    if (!this.messageId) {
      this.messageId = await this.sender.sendCard(buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default', false));
      this.panelMode = false;
    }
    this.lastStructure = this.structureKey();
    this.qaButtonsDirty = false;
    // 1s 对齐秒级计时（0.20.1：原 1.5s 跨秒边界会跳秒显示，如 1→3）；cardkit batch_update
    // 限频 1000 次/分钟，单卡 60 次/分钟远在限内
    const interval = this.opts.flushIntervalMs ?? 1000;
    this.flushTimer = setInterval(() => void this.flush(), interval).unref();
    this.heartbeatTimer = setInterval(() => {
      if (this.sinkNoticeRetry) this.retrySinkNotice(); // 沉底迁移标记补打（见 retrySinkNotice）
      if (Date.now() - this.lastActivityAt >= (this.opts.idleHeartbeatMs ?? 30_000)) {
        this.lastActivityAt = Date.now(); // I1 修复：心跳刷过即重置空闲计时，否则退化为每秒连刷
        void this.flush(); // 心跳：刷新运行时长，证明没卡死
      }
    }, 1000).unref();
  }

  /** 流式文本块到达（活动信号）：产品决策——运行中与终态都不在主卡渲染过程文本/回复正文，
   *  完整回复由 index.ts 收尾逻辑独立多卡直接展示；此方法清执行瞬态（💭 处理中即焚——
   *  模型已开始吐字）并刷新空闲计时，不再积累 buffer */
  appendText(_delta: string): void {
    if (this.done) return;
    this.clearTransient();
    this.lastActivityAt = Date.now();
  }

  /**
   * 工具调用开始：sub=true 表示发生在子代理内，归组到最后一个运行中的子代理；
   * 主代理调用归组到当前 active 步骤（TodoWrite 驱动），无步骤时入未归属池。
   * 「正在使用 X」行归属到所属条目下方（v5 执行栈），历史明细仅进折叠面板（实体卡模式）。
   */
  toolStart(name: string, summary: string, sub = false): void {
    if (this.done) return;
    const label = toolLabel(name);
    const trimmed = summary.slice(0, 80);
    this.clearTransient(); // 执行证据到达：💭 处理中即焚、心跳小字清空
    if (sub) {
      const agent = [...this.state.agents].reverse().find((a) => a.status === 'running');
      if (agent) {
        if (agent.tools.length < STEP_TOOLS_MAX) {
          // 同工具连续 start（上次未 result）：覆写上一条 running，避免出现两条 running
          const last = agent.tools[agent.tools.length - 1];
          if (last && last.ok === 'running') { last.label = label; last.summary = trimmed; }
          else agent.tools.push({ name, label, summary: trimmed, ok: 'running' });
        }
        this.state.runningTool = { label, summary: trimmed, state: 'running' };
        this.lastActivityAt = Date.now();
        void this.flush();
        return;
      }
      // 无运行中子代理（task_started 竞态/旧 CLI）：落主代理池兜底
    }
    const active = this.state.steps.find((s) => s.status === 'active');
    const pool = active ? active.tools : this.state.looseTools;
    const cap = active ? STEP_TOOLS_MAX : LOOSE_TOOLS_MAX;
    if (pool.length < cap) {
      const last = pool[pool.length - 1];
      if (last && last.ok === 'running') { last.label = label; last.summary = trimmed; }
      else pool.push({ name, label, summary: trimmed, ok: 'running' });
    }
    this.state.runningTool = { label, summary: trimmed, state: 'running' };
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /** 定位在途工具所在集合及其归属条目（toolResult 回写「刚完成」行用）：
   *  优先匹配 sub 标记的池，找不到回退主池；未归属池无 owner */
  private locateRunningOwner(sub: boolean): { pool: Array<ToolStep>; owner?: TaskStep | SubagentTask } | undefined {
    if (sub) {
      for (let i = this.state.agents.length - 1; i >= 0; i--) {
        const a = this.state.agents[i];
        if (a.tools.some((t) => t.ok === 'running')) return { pool: a.tools, owner: a };
      }
    }
    for (let i = this.state.steps.length - 1; i >= 0; i--) {
      const s = this.state.steps[i];
      if (s.tools.some((t) => t.ok === 'running')) return { pool: s.tools, owner: s };
    }
    if (this.state.looseTools.some((t) => t.ok === 'running')) return { pool: this.state.looseTools };
    return undefined;
  }

  /**
   * 工具调用落定：按工具名匹配最后一条 running（找不到回退池内最后一条 running），失败时
   * 带首行原因（权限被拒/命令出错一眼可辨）。落定后 ↳ 行不消失——转「刚完成」灰态保持
   * 显示（归属到工具所在条目下方），直到该条目下一条 toolStart 覆盖或条目完成。
   */
  toolResult(name: string, ok: boolean, note?: string, sub = false): void {
    if (this.done) return;
    this.state.thinking = false; // 有执行结果即非思考期（随后的 requesting 心跳会重新点亮）
    const found = this.locateRunningOwner(sub) ?? this.locateRunningOwner(false);
    let settled: ToolStep | undefined;
    if (found) {
      const { pool, owner } = found;
      for (let i = pool.length - 1; i >= 0; i--) {
        const s = pool[i];
        // 按工具名匹配最后一条 running；名字对不上时回退池内最后一条 running
        if (s.ok === 'running' && (s.name === name || pool.slice(i + 1).every((x) => x.ok !== 'running'))) {
          s.ok = ok;
          if (!ok && note) s.summary = note.slice(0, 60);
          settled = s;
          break;
        }
      }
      // 「刚完成」行归属到工具所在条目（v5：每个条目自己的 ↳ 行）
      if (settled && owner) owner.recent = { label: settled.label, summary: settled.summary };
    }
    const stillRunning = this.state.steps.some((s) => s.tools.some((t) => t.ok === 'running'))
      || this.state.agents.some((a) => a.tools.some((t) => t.ok === 'running'))
      || this.state.looseTools.some((t) => t.ok === 'running');
    if (!stillRunning) {
      this.state.runningTool = settled
        ? { label: settled.label, summary: settled.summary, state: 'done' }
        : undefined;
    }
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * TodoWrite 待办清单（步骤来源）：每次调用全量替换清单与状态，以 content 为键保留已归组
   * 的工具明细、激活时刻（倒序执行栈排序键）与「刚完成」行（步骤完成即收起）。
   * 无待办的小任务 steps 为空 → 降级视图（💭 处理中 + ↳ 当前动作行）
   */
  setTodos(todos: TodoItem[]): void {
    if (this.done) return;
    const prev = new Map(this.state.steps.map((s) => [s.title, s]));
    this.state.steps = todos.map((t) => {
      const old = prev.get(t.content);
      const status = t.status === 'completed' ? 'done' as const : t.status === 'in_progress' ? 'active' as const : 'pending' as const;
      const activatedAt = old?.activatedAt ?? (status === 'active' ? Date.now() : undefined);
      return {
        title: t.content,
        ...(t.activeForm ? { activeLabel: t.activeForm } : {}),
        status,
        tools: old?.tools ?? [],
        ...(activatedAt !== undefined ? { activatedAt } : {}),
        ...(status !== 'done' && old?.recent ? { recent: old.recent } : {}),
      };
    });
    this.clearTransient();
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 首个执行事件（流式增量/工具调用）到达：清掉 💭 处理中与心跳小字；启动阶段文案
   * （已接收/会话已建立）一并清除——v5 执行期不再有笼罩性状态行，版面主体=倒序执行栈。
   * 幂等：状态行已非启动文案时仅清瞬态
   */
  markStarted(): void {
    if (this.done) return;
    this.clearTransient();
    if (this.state.status === INITIAL_STATUS || this.state.status === BOOT_STATUS) {
      this.state.status = '';
    }
    if (this.state.phase === 'boot') this.state.phase = 'running';
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 模型思考期（CLI status=requesting 心跳）：状态行置「💭 处理中…」（执行栈顶唯一状态行），
   * 首个步骤/工具/文本事件到达即焚（markStarted/toolStart/appendText/setTodos 均 clearTransient）。
   * v5 替代旧「等待模型响应…」——思考不再整程笼罩工具列表，只在真正等待模型时出现
   */
  markThinking(): void {
    if (this.done) return;
    this.state.thinking = true;
    this.state.heartbeat = undefined;
    if (this.state.phase === 'boot') this.state.phase = 'running';
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /** 清执行瞬态：💭 处理中即焚 + 心跳小字清空（执行证据到达时调用） */
  private clearTransient(): void {
    this.state.thinking = false;
    this.state.heartbeat = undefined;
  }

  /**
   * system/init 到达（CLI 进程已起、会话已建立）：「已接收，启动中…」切为「会话已建立」，
   * 冷启动期间（加载配置/插件/MCP server、resume 回放，常见数十秒）不再黑盒。幂等且仅在
   * 初始文案时生效——首个执行事件（markStarted）会一并清掉
   */
  markSessionReady(): void {
    if (this.done || this.state.status !== INITIAL_STATUS) return;
    this.state.status = BOOT_STATUS;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 运行心跳（v5 降级为灰色小字行，渲染在执行栈与计时行之间）：上下文压缩/等待后台任务/
   * 决策结果等有信息量的状态文案；空串 = 清空。执行事件（工具/文本/待办）到达时经
   * clearTransient 清空——心跳只描述「当前没在执行时的等待原因」
   */
  setStatus(status: string): void {
    if (this.done) return;
    const s = status.trim();
    this.state.heartbeat = s || undefined;
    this.state.thinking = false; // CLI 显式状态心跳取代思考态（requesting 另走 markThinking）
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /** 挂起/解除用户输入区时同步阶段色点：挂起 → waiting（橙），解除且未终态 → 恢复 running */
  private setWaiting(active: boolean): void {
    if (this.done) return;
    if (active) this.state.phase = 'waiting';
    else if (this.state.phase === 'waiting') this.state.phase = 'running';
  }

  /**
   * 挂起/清除内嵌工具确认：非 undefined 时卡片顶部渲染确认按钮区并收敛正文，
   * 决策（含超时）后置回 undefined 恢复正文展示。appendText 期间照常积累 buffer，
   * 清除后 flush 一次性带出。
   */
  setConfirm(req: ConfirmationRequest | undefined): void {
    if (this.done) return;
    this.state.confirm = req;
    this.setWaiting(!!req);
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 挂起/清除计划审批（#3+#6）：v5 计划正文与审批表单都在独立卡片上（index 侧
   * sendPlanContentCards + buildPlanConfirmCard），本卡不再渲染 plan 区块——此状态仅维持
   * 等待阶段（header 变橙 + 计时行「计划确认后恢复」+ 维持性刷新冻结）。决策后置回 undefined
   */
  setPlan(req: import('./card-builder.js').EmbeddedPlanState | undefined): void {
    if (this.done) return;
    this.state.plan = req;
    this.setWaiting(!!req);
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 挂起/清除内嵌提问确认（#3）：每题选项全宽单行 + 提交按钮全部在主卡上，qa-pick PATCH 选中态。
   * 决策后 clearQuestion() 收回区域
   */
  setQuestion(req: import('./card-builder.js').EmbeddedQuestionState | undefined): void {
    if (this.done) return;
    this.state.question = req;
    this.setWaiting(!!req);
    // 提问区收回时同步清选中态脏标记（按钮已随全量替换消失，qa-only 空批次无意义）
    if (!req) this.qaButtonsDirty = false;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /** 当前某题的选中答案（wiring 的 qa-pick 回调同步给 qaPending 校验用；公开读，
   *  替代旧版 wiring 直接访问私有 state 的 hack） */
  getQuestionAnswer(qIndex: number): string | string[] | undefined {
    return this.state.question?.answers[qIndex];
  }

  /** 当前挂起的内嵌 plan / question requestId（wiring 诊断入口 _pendingAsk 用） */
  pendingAsk(): { planId?: string; questionId?: string } {
    return {
      planId: this.state.plan?.requestId,
      questionId: this.state.question?.requestId,
    };
  }

  /**
   * qa-pick 选项点击：更新选中态并 flush（multiSelect 累加/移除，单选直接覆盖）。
   * 异常状态（如 question 已被清空）静默忽略——迟到点击不报错
   */
  updateQuestionAnswer(qIndex: number, option: string, multiSelect: boolean): void {
    if (this.done || !this.state.question) return;
    const q = this.state.question.questions[qIndex];
    if (!q) return;
    if (multiSelect) {
      const cur = this.state.question.answers[qIndex];
      const arr = Array.isArray(cur) ? [...cur] : cur !== undefined ? [cur] : [];
      const i = arr.indexOf(option);
      if (i >= 0 && arr.length > 1) arr.splice(i, 1); // 至少保留一项：单选/全取消等于未答
      else if (i < 0) arr.push(option);
      this.state.question.answers[qIndex] = arr;
    } else {
      this.state.question.answers[qIndex] = option;
    }
    this.qaButtonsDirty = true; // 下次实体 partial 附带按钮级选中态更新（不走全量替换，保 form 输入）
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /** 子代理/后台任务启动：加入清单（同 id 重复启动幂等跳过）。v5 与步骤同级独立成行，
   *  按启动时间插入倒序执行栈 */
  agentStart(agent: { id: string; description: string; type: string }): void {
    if (this.done) return;
    if (this.state.agents.some((t) => t.id === agent.id)) return;
    this.clearTransient();
    this.state.agents.push({ ...agent, startedAt: Date.now(), status: 'running', tools: [] });
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 子代理/后台任务落定：标记完成/失败/停止（条目保留至任务结束供回看）；
   * 落定即收起「刚完成」行（结论摘要随 ✅/❌ 行展示）。
   * 找不到条目时补建（resume 续跑场景：上轮启动的后台任务本轮才收到通知）。
   */
  agentSettle(id: string, status: 'done' | 'failed' | 'stopped', summary?: string): void {
    if (this.done) return;
    const t = this.state.agents.find((x) => x.id === id);
    if (t) {
      t.status = status;
      t.recent = undefined;
      if (summary) t.summary = summary;
    } else {
      this.state.agents.push({ id, description: summary?.slice(0, 80) ?? id, type: 'task', startedAt: Date.now(), status, tools: [], ...(summary ? { summary } : {}) });
    }
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  /**
   * 终态收敛。resultChars：完整回复字数（有回复时传入）——终态不渲染回复正文，仅在该值
   * 非空时显示一行「完整回复已单独发送」指引（正文由 index.ts 收尾独立多卡直接展示）。
   * phase：终态阶段（done 绿 / stopped 灰 / error 红），驱动结论行 emoji 与 header 色；缺省 done。
   * 工具动态与子代理清单保留到终态（呼应原型：终态卡可回看本次做了哪些动作）。
   */
  async finish(summary: string, resultChars?: number, phase: TaskPhase = 'done'): Promise<void> {
    this.done = true;
    this.state.done = true;
    this.state.phase = phase;
    clearInterval(this.flushTimer);
    clearInterval(this.heartbeatTimer);
    this.sinkNoticeRetry = undefined; // 心跳已停，补打失去驱动；终态后旧卡提示已无意义
    this.state.status = summary;
    this.state.runningTool = undefined;
    this.state.thinking = false;
    this.state.heartbeat = undefined;
    this.state.resultChars = resultChars;
    // 终态不再带交互区（决策未落的最极端兜底；正常路径 plan/question/confirm 先于 finish settle）
    this.state.confirm = undefined;
    this.state.plan = undefined;
    this.state.question = undefined;
    await this.flush(); // 经由同一串行链落地，保证是最后一张（终态不被旧 flush 覆盖）
  }

  /**
   * 沉底：撤回当前进度卡并在会话底部重发（确认卡/计划卡/提问卡/中途推送都会把进度卡
   * 顶上去，用户看不出任务是否还在跑）。plan 场景 force 主动沉底：方案正文直发后把
   * 带审批表单的本卡沉到正文下方，确认动线不用往上滚（form 刚上屏无输入，可旁路挂起延迟）。
   * 删除失败（权限/网络）时降级为仅重发——
   * 极端情况出现两张进度卡，任务照常。终态后不再沉底。
   * 重发失败（限流/网络）重试一次，仍失败则放弃本卡（messageId 留空，flush 自动跳过）——
   * 绝不向上抛：调用方多为 void 调用，未处理 rejection 会拖垮整个 bridge 进程。
   */
  async sinkToBottom(opts?: { force?: boolean }): Promise<void> {
    if (this.done) { this.deferSink = false; return; }
    if (!this.messageId) return;
    // 挂起输入期间沉底会删卡重发（输入态归零，用户打的意见/自定义答案被清掉）——
    // 记录请求延迟到挂起解除（flush 落地后检查补执行）。force 旁路：调用方确信此刻
    // form 刚上屏、用户不可能已打字（planAsk 正文直发后立即沉底的场景）
    if (this.hasInputPending() && !opts?.force) { this.deferSink = true; return; }
    this.deferSink = false; // 主动沉底时清掉可能暂存的延迟请求，避免挂起解除后再多沉一次
    const old = this.messageId;
    const oldCardId = this.cardId;
    this.messageId = undefined; // 期间 flush 自动跳过，避免 PATCH 打到已删除的旧卡
    this.cardId = undefined;
    if (this.sender.deleteCard) {
      await this.sender.deleteCard(old).catch(async (e) => {
        // 撤回失败不再静默：1.3.7 真机事故里旧卡冻结在中间态无结束文案，被误读成任务中断。
        // 每次沉底都出现此日志 ≈ 应用缺 im:message:delete 撤回权限（去开发者后台开通并发布）
        console.warn('[进度卡] 旧卡撤回失败(若每次沉底都出现,多为应用缺 im:message:delete 撤回权限,请在飞书开发者后台开通并发布新版本):',
          e instanceof Error ? e.message : e, feishuErrorBody(e) ?? '');
        // 1.4.1 加固①：撤回失败多为秒级瞬态（2200 Internal Error 等服务端 500）——退避
        // 补撤一次，成功即不产生双卡；仍失败才转「已沉底」迁移标记兜底
        await new Promise((r) => setTimeout(r, DELETE_RETRY_DELAY_MS));
        try {
          await this.sender.deleteCard!(old);
          return;
        } catch (e2) {
          console.warn('[进度卡] 旧卡补撤仍失败,转迁移标记兜底:',
            e2 instanceof Error ? e2.message : e2, feishuErrorBody(e2) ?? '');
        }
        // 1.4.1 加固②：迁移标记 PATCH 常撞 230020 单消息更新限频（撤回前旧卡刚经历每秒级
        // seq 重试，极易触发频控，数秒自愈）——首次失败不再静默放弃（静默会让旧卡原样冻结
        // 在中间态被误读成任务中断，1.4.1 真机事故即「撤回 500 + 标记限频」双失败双卡），
        // 记入待补由心跳延迟补打（retrySinkNotice）
        try {
          await withTimeout(this.sender.updateCard(old, buildSinkNoticeCard(this.state.title)), this.opts.updateTimeoutMs ?? UPDATE_TIMEOUT_MS);
        } catch (e2) {
          this.sinkNoticeRetry = { messageId: old, attempts: 1, lastAt: Date.now() };
          console.warn(`[进度卡] 「已沉底」提示改写失败(限频/网络),将由心跳每 ${SINK_NOTICE_RETRY_DELAY_MS / 1000}s 补打(最多 ${SINK_NOTICE_RETRY_MAX} 次):`,
            e2 instanceof Error ? e2.message : e2, feishuErrorBody(e2) ?? '');
        }
      });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 沉底重发沿用当前模式：原先是实体模式则新建实体（旧实体已随消息撤回弃用），
        // 工具折叠面板随通道走（实体卡有、消息卡降级无）
        if (this.sender.sendCardEntity && oldCardId) {
          const { messageId, cardId } = await this.sender.sendCardEntity(buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default', true));
          this.messageId = messageId;
          this.cardId = cardId;
          this.panelMode = true;
          this.seq = 0; // sequence 按实体计数：新实体从 1 重新递增
        } else {
          this.messageId = await this.sender.sendCard(buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default', false));
          this.panelMode = false;
        }
        this.partialCache.clear();
        this.lastStructure = this.structureKey();
        this.qaButtonsDirty = false; // 重发卡片已含最新选中态
        void this.flush();
        return;
      } catch (e) {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800)); // 退避后重试一次（飞书偶发限流）
        else console.warn('[进度卡] 沉底重发失败，本卡后续更新暂停（任务不受影响）：', e instanceof Error ? e.message : e);
      }
    }
  }

  /**
   * 「已沉底」迁移标记心跳补打（heartbeatTimer 每秒调用）：距上次尝试 ≥
   * SINK_NOTICE_RETRY_DELAY_MS 才发（230020 单消息限频数秒自愈，密集重试反而加剧频控），
   * 成功清槽；达 SINK_NOTICE_RETRY_MAX 放弃并清槽——轻量加固定位，固定次数后不再照看
   * （旧卡保持冻结但不影响任务；需无限期照看见「弃卡补偿队列」扩展方向，暂不引入）。
   * fire-and-forget：不 await，避免阻塞心跳；withTimeout 防网络黑洞挂死槽位。
   */
  private retrySinkNotice(): void {
    const n = this.sinkNoticeRetry!;
    if (Date.now() - n.lastAt < SINK_NOTICE_RETRY_DELAY_MS) return;
    void withTimeout(this.sender.updateCard(n.messageId, buildSinkNoticeCard(this.state.title)), this.opts.updateTimeoutMs ?? UPDATE_TIMEOUT_MS)
      .then(() => { this.sinkNoticeRetry = undefined; })
      .catch((e) => {
        if (n.attempts >= SINK_NOTICE_RETRY_MAX) {
          this.sinkNoticeRetry = undefined;
          console.warn('[进度卡] 「已沉底」提示补打放弃,旧卡保持冻结(不影响任务):',
            e instanceof Error ? e.message : e, feishuErrorBody(e) ?? '');
          return;
        }
        n.attempts += 1;
        n.lastAt = Date.now();
      });
  }

  /**
   * 串行化 flush：所有更新走同一条 promise 链按发起顺序落地。
   * - in-flight 中再来请求 → 标记 dirty，本轮落地后自动补刷一次（带上最新 state）；
   * - finish 的终态 flush 也入链，天然排在先前挂起的更新之后。
   * 实体模式下按结构签名分流：结构未变 → 局部更新（只改 main/timer 两个 markdown 组件）；
   * 结构变化（交互区增删、终态）→ 全量替换实体。两种模式自 0.20.1 起对称实现「挂起输入
   * 冻结」：plan/qa 挂起期间（hasInputPending）跳过维持性刷新——真机实测实体局部更新与
   * 整卡 PATCH 落地都会重置 form 内未提交输入，挂起期间任何更新都清掉用户正在打的字；
   * 计时行随挂起上屏显示「⏸ 计时已暂停」。唯一例外：qa 选中态脏标记放行一次按钮级
   * partial（仅 qa_opt_*，用户刚点选项的即时反馈），失败恢复脏标记重试。
   */
  private flush(): Promise<void> {
    if (!this.messageId) return Promise.resolve();
    if (this.flushing) {
      this.dirty = true; // 已有 in-flight，补刷标记，等它落地后再发
      return this.flushChain;
    }
    this.flushing = true;
    this.flushChain = (async () => {
      for (;;) {
        this.dirty = false;
        const expectedSeq = this.seq + 1; // 仅期望值,await 成功才提交推进
        const timeoutMs = this.opts.updateTimeoutMs ?? UPDATE_TIMEOUT_MS;
        // 本轮是否携带 qa 按钮级更新：发送前快照并清零（先清后发）——await 期间新一轮
        // 选项点击会重新置位，经 dirty 补刷/下轮自动补发；失败恢复见 catch。旧版在成功后
        // 才清标记，await 期间的第二次点击会丢其 ✓ 高亮（0.20.0 既有竞态，0.20.1 修复）
        let withQaButtons = false;
        try {
          if (this.cardId && this.sender.partialUpdateCard && this.sender.replaceCard) {
            const structure = this.structureKey();
            if (structure === this.lastStructure) {
              // 0.20.1 实体模式挂起冻结（与降级分支对称）：真机实测 cardkit batch_update
              // 落地同样会重置 form 内未提交输入（官方错误码 200810 亦表明交互期间流式
              // 更新受限）——挂起期间跳过维持性 partial，计时/状态停更可接受（任务在等
              // 用户，计时行随挂起上屏显示「⏸ 计时已暂停」）。例外：qa 选中态脏标记
              // （用户刚点选项按钮的即时反馈，此刻输入框大概率未打字）放行一次按钮级
              // partial——只发 qa_opt_*，不含 main/timer 替换（最小触碰）
              if (this.hasInputPending() && !this.qaButtonsDirty) break;
              withQaButtons = this.qaButtonsDirty;
              this.qaButtonsDirty = false; // 先清后发：失败恢复见 catch
              // 内容未变化的组件跳过（partialCache 记上次成功下发的 content）：心跳每秒
              // 通常只有计时行变化，步骤多时不至于整批全量触达 batch_update 频控
              const allActions = this.hasInputPending()
                ? buildQaButtonActions(this.state)
                : buildPartialUpdateActions(this.state, this.panelMode, withQaButtons);
              const actions = this.hasInputPending()
                ? allActions
                : allActions.filter((a) => {
                  const content = (a.params.partial_element as { content?: string }).content;
                  if (typeof content !== 'string') return true; // qa 按钮类（text/type）不过滤
                  return this.partialCache.get(a.params.element_id) !== content;
                });
              // 挂起中无 qa 按钮可发（question 刚被清等边界）：视同冻结跳过；脏标记不恢复
              // （空批次重试只会无限刷日志，选中态由下次全量渲染/点击补齐）。
              // 正常路径内容全无变化（纯心跳无事件）同样空批直接跳过
              if (actions.length === 0) break;
              await withTimeout(this.sender.partialUpdateCard(this.cardId, expectedSeq, actions), timeoutMs);
              // 成功才落缓存：失败路径不落，下轮原样重发
              for (const a of actions) {
                const content = (a.params.partial_element as { content?: string }).content;
                if (typeof content === 'string') this.partialCache.set(a.params.element_id, content);
              }
            } else {
              // 结构变化：全量替换实体（form 输入会重置，但这些时刻用户尚未输入或已提交；
              // 全量渲染已含最新选中态）。replace 前同样先清 qa 脏标记（先清后发）：await
              // 期间新点击重新置位的 dirty 由下一轮 partial（qa 例外通道）自动补发
              withQaButtons = this.qaButtonsDirty;
              this.qaButtonsDirty = false;
              await withTimeout(this.sender.replaceCard(this.cardId, expectedSeq, buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default', this.panelMode)), timeoutMs);
              this.partialCache.clear();
              this.lastStructure = structure;
            }
          } else {
            // 降级模式挂起冻结（0.20.0）：im.message.patch 整卡 PATCH 会重置卡片全部客户端
            // 输入态——plan/qa 挂起期间 1.5s 心跳会把用户正在输入的意见/自定义答案瞬间清掉。
            // 仅冻结「结构不变」的维持性刷新；挂起区出现/消失（结构变化）必须放行——
            // 否则确认按钮根本不上屏。计时/状态行在挂起期间停更可接受（任务实际在等用户）
            const structure = this.structureKey();
            if (this.hasInputPending() && structure === this.lastStructure) break;
            await withTimeout(this.sender.updateCard(this.messageId!, buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default', this.panelMode)), timeoutMs);
            this.lastStructure = structure;
          }
          this.seq = expectedSeq; // 仅成功后提交推进
          this.consecutiveFailures = 0; // 成功即清零连续失败计数
          this.seqSkipRetries = 0; // 对齐成功即清零跳号计数（下次错位重新计数）
        } catch (e) {
          // 本轮携带 qa 按钮更新但发送失败：恢复脏标记，下轮重试补发选中态（先清后发的恢复路径）
          if (withQaButtons) this.qaButtonsDirty = true;
          // cardkit sequence OCC 失败恢复：
          // - 300317(本地 seq 落后于服务端,典型成因:上轮请求假阴性——300308/超时但实际已在
          //   服务端落地):本地 seq 乐观 +1 逐级对齐(上限 MAX_SEQ_SKIP),对齐即零成本自愈、
          //   卡片不重建。1.3.7 真机事故:300308 假阴性 → 同 seq 重试必撞 300317 → 弃卡
          //   沉底重建,撤卡又失败留下一张无结束文案的冻结卡。飞书不提供读取服务端 seq 的口;
          //   实测跳 Date.now() 兜底被 9499 拒绝——sequence 只接受从 1 递增的小整数,
          //   故只能小步 +1 逼近,不能大数跳变。
          // - 300317 跳满上限(错位过深/成因未知)或非 300317 连续失败达到阈值:sequence 无法
          //   对齐,继续重试只会永久死循环。放弃当前实体恢复：
          //   非 done:沉底式重建(循环外 deferSink 执行点 → sinkToBottom:删旧卡→新实体,seq 从 1 干净开始);
          //   done(sinkToBottom 不处理终态):降级整卡 PATCH(同一 messageId,无需 sequence;
          //     终态无交互输入,重置客户端输入无副作用),尽力而为失败静默
          // - 偶发错误(限流/200810 交互进行中/网络抖动):服务端没接受本次 seq,seq 不推进,
          //   下轮重试用同一 expectedSeq,由连续失败计数兜底
          // 错误码可能在 axios 的 response.data 里（HTTP 400 时 message 只有 status code），一并带出供定位
          const code = extractFeishuErrorCode(e);
          const detail = feishuErrorBody(e);
          if (code === '300317' && this.seqSkipRetries < MAX_SEQ_SKIP) {
            this.seqSkipRetries += 1;
            this.seq += 1; // 乐观对齐：服务端 seq 已超前，本地 +1 逼近（成功推进处清零计数）
            this.dirty = true; // 立即再跑一轮用 seq+1 重试，不进 giveUp
            console.warn(`[进度卡] 300317 sequence 错位,本地 seq 乐观跳至 ${this.seq + 1} 跳号自愈重试(${this.seqSkipRetries}/${MAX_SEQ_SKIP})`);
          } else {
            const giveUp = code === '300317' || ++this.consecutiveFailures >= 5;
            if (giveUp) {
              this.consecutiveFailures = 0;
              console.warn(`[进度卡] 更新持续失败,放弃当前卡片实体${code === '300317' ? `(300317 sequence 错位,跳号 ${MAX_SEQ_SKIP} 次未对齐)` : '(连续 5 次)'},沉底式重建:`,
                e instanceof Error ? e.message : e, detail ?? '');
              if (this.done) {
                // 终态兜底：整卡 PATCH 不依赖 sequence；失败静默（终态尽力而为，不再重试）
                try {
                  await withTimeout(this.sender.updateCard(this.messageId!, buildProgressCard(this.state, this.opts.cardWidthMode ?? 'default')), timeoutMs);
                  this.lastStructure = this.structureKey();
                } catch { /* 尽力而为 */ }
              } else {
                this.deferSink = true; // 循环外执行点 → sinkToBottom（自带挂起输入延迟逻辑）
                break; // 错位 seq 继续重试无意义，退出本轮循环（定时器每秒仍会触发新 flush，无丢失）
              }
            } else {
              console.warn('[进度卡] 更新失败(seq 未推进,下次用相同 expectedSeq 重试):',
                e instanceof Error ? e.message : e, detail ?? '');
            }
          }
        }
        if (!this.dirty) break; // 落地期间无新请求，收工
      }
      // 沉底延迟触发：挂起期间被暂存的 sink 请求，在挂起解除（plan/question 已清）后补执行
      if (this.deferSink && !this.hasInputPending()) {
        this.deferSink = false;
        void this.sinkToBottom();
      }
    })().finally(() => {
      this.flushing = false;
      // 竞态修复：并发 flush 在「循环最后一次 dirty 检查之后、finally 之前」的微任务窗口
      // 置位 dirty 时，其 return flushChain 的补刷会被吞——终态 PATCH 丢失、进度卡停在
      // 中间态（markStarted 紧邻 finish 的场景实测踩中）。finally 处再查一次：仍有
      // 未消费的 dirty 则重启一轮（幂等：正常路径 dirty 已被循环消费，不会重启）
      if (this.dirty && this.messageId) void this.flush();
    });
    return this.flushChain;
  }

  /** 是否有等待用户输入的挂起区（plan 意见框 / qa 自定义输入）：降级模式冻结与沉底延迟的判定依据 */
  private hasInputPending(): boolean {
    return !!(this.state.plan || this.state.question);
  }

  /** 结构签名：阶段（header 模板色）、交互区存在性、终态、面板模式（通道切换）、
   *  执行栈条目（v5 倒序混排后的渲染序：kind + 标题 + 状态 + 面板工具数）、未归属池有无
   *  ——任一变化都需要全量重渲染才能上屏（条目增删/换序、面板出现/消失都是元素级结构变化）。
   *  行内易变内容（子代理运行秒数、↳ 正在使用/刚完成、状态行处理中）不进签名——那些走
   *  element 级局部更新（partialCache 内容 diff 过滤后发送）。
   *  0.20.0 起不含 qa 选中态：选中态变化只走按钮 element_id 级局部更新，全量替换会
   *  清空 form 内未提交的自定义输入（用户点选项时输入框里可能已打了字） */
  private structureKey(): string {
    const s = this.state;
    const parts = buildProgressParts(s, this.panelMode);
    return JSON.stringify([
      s.phase, !!s.confirm, !!s.plan, !!s.question, !!s.done, this.panelMode,
      parts.items.map((x) => x.sig),
      s.looseTools.length > 0,
    ]);
  }
}

/**
 * 飞书错误响应体原文（截断防刷屏）。axios 把 HTTP 400 的业务错误码藏在 e.response.data
 * （300317/99992402 等），e.message 只有 "Request failed with status code 400"——
 * 不提取响应体的话日志无从定位拒绝原因（本次 card is required 事故即如此）。
 *
 * 导出供单元测试使用;不在生产逻辑外暴露。
 */
export function feishuErrorBody(e: unknown): string | undefined {
  const data = (e as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  if (data === undefined || data === null) return undefined;
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * 从 gateway 抛出的 Error 中提取飞书 cardkit 错误码。
 * 优先读 axios 响应体（HTTP 400 场景），回落 message 正则容错匹配——
 * gateway 业务级错误信息形如 `卡片局部更新失败: {"code":300317,"msg":"..."}`。
 * 这里用正则容错匹配 — 不引入新依赖,只对错误信息做最小解析。
 *
 * 导出供单元测试使用;不在生产逻辑外暴露。
 */
export function extractFeishuErrorCode(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const m = /"code"\s*:\s*(\d+)/.exec(feishuErrorBody(e) ?? e.message);
  return m?.[1];
}
