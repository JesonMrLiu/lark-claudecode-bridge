// ============ 会话 ============
// LCB 本地聊天时间线只读查看器（「用户+/new」会话维度）：一次 /new = 一个会话条目（sessionId 粒度）。
// 两接口分段加载（2026-10-28 改版）：① /api/chats/bots 秒出机器人下拉（轻量、零飞书调用）→
// ② /api/chats/sessions 按选中的机器人分页拉会话列表（拍平/排序/关键词过滤在服务端，每页 20 条）：
// 「查询会话」/切机器人/↻ 刷新一律重查第 1 页最新数据整表替换；底部「加载更多」有下一页才显示，
// 翻尽后显示「已全部加载」文案。右内容区时间线走 /api/chats/timeline 不变（任务 = 一次 CC 执行）。
// 列表关键词为查询制（回车/查询按钮才生效，主人定过「不要选一下就搜」），服务端全量过滤。
import { $, esc, api, toast } from '../core.js';
import { renderMarkdown } from '../markdown.js';

/** 页面态（切页重进即重置） */
const ST = {
  bots: [],                     // /api/chats/bots（appId/name/sessions/lastActiveAt，下拉用）
  app: '', name: '',            // 当前机器人 appId 与显示名（sessions 接口回填）
  chat: '', session: '',        // 当前选中：通道 + 会话（sessionId）
  sessions: [],                 // 已加载的会话条目（第 1..N 页累积；updatedAt 降序，服务端排好）
  total: 0, page: 0, hasMore: false, // 分页态：total=过滤后总数；hasMore=false 即「已全部加载」
  busy: false, busyMore: false, // 重查/加载更多防重入
  nameByUser: {},               // userId → 显示名（access 人名 + 飞书解析名，兜底尾号）
  kw: '',                       // 列表关键词（查询制：回车/查询按钮写入，随请求下发服务端过滤）
  taskKw: '',                   // 详情时间线关键词（「查询」按钮写入，与列表关键词互不相干）
  kwHits: [], kwAt: 0,          // 详情关键词命中的任务索引与当前指向
  tasks: [], truncated: false, partial: false,
};

const svg = (inner, s = 14) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const IC = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/>',
  copy: '<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
};

const RESULT_BADGE = {
  success: '<span class="tag ok">已完成</span>',
  stopped: '<span class="tag off">已停止</span>',
  error: '<span class="tag err">出错</span>',
};

/** 整页加载层（仅初始进页存在）：盖住列表+详情区，初始链路（树→时间线）走完/出错即移除。
 *  层移除后以下调用自动变 no-op——页内后续「查询/切会话」仍走时间线区行内「加载中…」，不重复盖罩 */
const bootStage = (t) => { const n = $('#chBootTxt'); if (n) n.textContent = t; };
const hideBoot = () => $('#chBoot')?.remove();

export const page = {
  id: 'chats',
  title: '会话',
  desc: '按机器人检索会话，查看完整消息与任务执行详情',
  legend: false,
  icon: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  async render(el) {
    el.innerHTML = `
    <div class="panel">
      <header class="panel-head"><h3>查询条件</h3>
        <div class="panel-actions"><span class="dim" style="font-size:11.5px">选择机器人后点「查询会话」，每次加载最新 20 条</span></div></header>
      <div class="panel-body">
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div><label class="fld">飞书机器人 *</label>
            <select id="chBot" style="width:220px"></select></div>
          <button class="btn primary" id="chGo">${svg(IC.search, 13)} 查询会话</button>
        </div>
        <div class="mini-note" style="margin-top:8px">记录落盘于 <code>~/.lark-claudecode-bridge/transcripts/</code>；列表按会话最后活跃时间降序，点进即看该会话跨天全部消息。</div>
        <div class="mini-note" id="chPermHint" hidden style="margin-top:4px;color:var(--warn-tx)">ⓘ 当前显示为飞书 ID（ou_…）：请在飞书开放平台为对应机器人应用开通「获取用户基本信息」（contact:user.base:readonly）权限并发布版本；开通后约 10 分钟内自动恢复真名，无须重启。</div>
      </div>
    </div>
    <div class="chats-layout">
      <div class="panel" style="margin:0">
        <header class="panel-head"><h3>会话列表</h3>
          <div class="panel-actions"><span class="tag off" id="chCnt"></span></div></header>
        <div style="padding:10px 12px 8px"><input type="search" id="chQ" placeholder="搜索会话：标题 / 用户 / 群名（回车查询）"></div>
        <div class="chat-list-panel" id="chList" style="border-top:1px solid var(--border)"></div>
        <div id="chMore" style="padding:10px 12px;text-align:center"></div>
      </div>
      <div class="panel" style="margin:0;min-height:440px" id="chDetail"></div>
      <div class="chats-boot" id="chBoot" role="status" aria-live="polite">
        <div class="chats-boot-box"><span class="br-spin-sm" aria-hidden="true"></span><span id="chBootTxt">正在加载机器人列表…</span></div>
      </div>
    </div>`;
    // 列表关键词查询制：回车/「查询会话」统一生效（主人定过「不要选一下就搜」），服务端全量过滤
    $('#chQ').onkeydown = (e) => { if (e.key === 'Enter') $('#chGo').click(); };
    // ① 先查机器人下拉（轻量接口，零飞书调用）
    try {
      const r = await api('GET', '/api/chats/bots');
      ST.bots = r.bots ?? [];
    } catch (e) {
      hideBoot();
      $('#chDetail').innerHTML = `<div class="empty" style="margin-top:60px">机器人列表加载失败：${esc(e.message)}</div>`;
      return;
    }
    const botSel = $('#chBot');
    botSel.innerHTML = ST.bots.map((b) => `<option value="${esc(b.appId)}">${esc(b.name)}（${esc(b.appId)}）</option>`).join('');
    if (!ST.bots.length) {
      hideBoot();
      $('#chList').innerHTML = '<div class="empty">暂无会话记录<br><span class="mini-note">还没有任何对话落盘。在飞书里和机器人聊几句后回来看。</span></div>';
      $('#chCnt').textContent = '0 个会话';
      $('#chGo').disabled = true;
      return;
    }
    // ② 选中机器人后再查会话列表：切机器人 / 点「查询会话」= 重查第 1 页最新数据
    $('#chGo').onclick = () => void freshQuery();
    botSel.onchange = () => { $('#chGo').click(); };
    // 默认选中最近活跃且第一个有会话的机器人，进来即有内容可看
    const firstBot = ST.bots.find((b) => b.sessions > 0) ?? ST.bots[0];
    botSel.value = firstBot.appId;
    bootStage('正在加载会话列表…');
    try {
      await freshQuery();
    } finally {
      hideBoot(); // 成功/空态/报错任何出口都撤层，加载层绝不残留
    }
  },
};

/** 拉一页会话列表（服务端拍平/排序/关键词过滤，每页 20 条） */
async function fetchPage(p) {
  const q = new URLSearchParams({ app: ST.app, page: String(p) });
  if (ST.kw) q.set('kw', ST.kw);
  return api('GET', `/api/chats/sessions?${q.toString()}`);
}

/** 重查第 1 页最新数据（「查询会话」/切机器人/进页默认加载共用）：整表替换并默认选中首条；
 *  opts.keep 用于 ↻ 刷新——当前会话若仍在最新列表里则留在原地，否则落回首条 */
async function freshQuery(opts = {}) {
  if (ST.busy) return;
  ST.busy = true;
  const keep = opts.keep ?? null;
  ST.app = $('#chBot')?.value || ST.app;
  ST.kw = ($('#chQ')?.value || '').trim();
  ST.page = 1;
  ST.hasMore = false;
  // 加载反馈只在底部状态条一处（renderMoreBar('busy')），列表区不再重复挂「加载中」——
  // 旧列表原样保留到新数据到达（2026-10-28 主人反馈：两处「加载中」重复，删列表区那个）
  renderMoreBar('busy');
  try {
    const r = await fetchPage(1);
    ST.name = r.name || ST.app;
    ST.total = r.total ?? 0;
    ST.page = r.page ?? 1;
    ST.hasMore = !!r.hasMore;
    ST.sessions = r.sessions ?? [];
    refreshPermHint();
    renderList();
    const back = keep && ST.sessions.find((s) => s.chatId === keep.chat && s.sessionId === keep.session);
    if (back) await selectSession(back.chatId, back.sessionId);
    else if (ST.sessions[0]) await selectSession(ST.sessions[0].chatId, ST.sessions[0].sessionId);
    else renderDetailEmpty();
  } catch (e) {
    $('#chList').innerHTML = `<div class="empty">会话列表加载失败：${esc(e.message)}</div>`;
    renderDetailEmpty();
  } finally {
    ST.busy = false;
    renderMoreBar();
  }
}

/** 「加载更多」：拉下一页追加（不重置选中、不重查已加载数据）；防重入 */
async function loadMore() {
  if (!ST.hasMore || ST.busyMore || ST.busy) return;
  ST.busyMore = true;
  renderMoreBar('busy');
  try {
    const r = await fetchPage(ST.page + 1);
    ST.name = r.name || ST.app;
    ST.total = r.total ?? ST.total;
    ST.page = r.page ?? ST.page;
    ST.hasMore = !!r.hasMore;
    ST.sessions.push(...(r.sessions ?? []));
    refreshPermHint();
    renderList();
  } catch (e) {
    toast(`加载更多失败：${e.message}`, true);
  } finally {
    ST.busyMore = false;
    renderMoreBar();
  }
}

/** 列表底部状态：有下一页 → 「加载更多」按钮；翻尽 → 「已全部加载」文案；空列表不渲染 */
function renderMoreBar(state) {
  const el = $('#chMore');
  if (!el) return;
  if (!ST.total) { el.innerHTML = ''; return; }
  if (state === 'busy') { el.innerHTML = '<span class="mini-note">加载中…</span>'; return; }
  if (ST.hasMore) {
    el.innerHTML = '<button class="btn sm" id="chMoreBtn">加载更多</button>';
    const b = $('#chMoreBtn');
    if (b) b.onclick = () => void loadMore();
  } else {
    el.innerHTML = `<span class="mini-note">已全部加载，共 ${ST.total} 个会话</span>`;
  }
}

/** 真名依赖 contact:user.base:readonly 权限：已加载的会话里还有「未解析的 ou_ 用户」就指路
 *（分页改版后跟随当前已加载数据判断，不再全树扫描） */
function refreshPermHint() {
  const hint = $('#chPermHint');
  if (!hint) return;
  hint.hidden = !ST.sessions.some((s) => s.users.some((u) => !u.name && /^ou_/i.test(u.userId)));
}

async function selectSession(chatId, sessionId) {
  ST.chat = chatId;
  ST.session = sessionId;
  ST.taskKw = '';
  ST.kwHits = [];
  ST.kwAt = 0;
  ST.nameByUser = {};
  const s = curSession();
  // 真名优先，无真名退 ou 尾号（自指记录按无真名处理，后端同理过滤）
  for (const u of s?.users ?? []) ST.nameByUser[u.userId] = u.name && u.name !== u.userId ? u.name : `${u.userId.slice(0, 10)}…`;
  renderList();
  renderDetailSkeleton();
  await loadTimeline();
}

const curSession = () => ST.sessions.find((s) => s.chatId === ST.chat && s.sessionId === ST.session) ?? null;

/** 会话类型徽标三态：group=群聊 / p2p|private=私聊（副行已注明「私聊」，不再重复挂标）/ 空=未知 */
const typeTag = (t) => t === 'group' ? '<span class="tag info">群聊</span>'
  : (t === 'p2p' || t === 'private') ? ''
    : '<span class="tag off" title="暂无法识别会话类型（飞书群信息拉取失败）">未知</span>';
/** 成员名串（= 该会话的参与用户）：真名优先，无真名退 ou 尾号 */
const membersOf = (s) => (s?.users || [])
  .map((u) => (u.name && u.name !== u.userId ? u.name : short(u.userId, 8)))
  .join('、');

function renderList() {
  const el = $('#chList');
  if (!el) return;
  el.innerHTML = ST.sessions.map((s, i) => `
    <div class="chat-obj ${s.chatId === ST.chat && s.sessionId === ST.session ? 'active' : ''}" data-i="${i}" role="button" tabindex="0" title="${esc(s.title)}">
      <span class="c-ava ${s.chatType === 'group' ? 'group' : ''}">${esc(((s.users[0]?.name || s.users[0]?.userId) || '?')[0])}</span>
      <div class="c-main">
        <div class="c-top"><span class="c-name">${esc(s.title)}</span><span class="c-time">${esc(fmtRel(s.updatedAt))}</span></div>
        <div class="c-prev">${esc(membersOf(s) || '未知用户')} · ${s.chatType === 'group' ? esc(s.chatName) : '私聊'}</div>
        <div class="c-badges">${typeTag(s.chatType)}</div>
      </div>
    </div>`).join('')
    || `<div class="empty">${ST.kw ? '没有匹配的会话' : '暂无会话记录'}<br><span class="mini-note">${ST.kw ? '换个关键词，或清空后点「查询会话」重试。' : '该机器人还没有可展示的会话索引（早期落盘数据不含会话边界）。'}</span></div>`;
  $('#chCnt').textContent = `${ST.sessions.length} / ${ST.total} 个会话`;
  el.querySelectorAll('.chat-obj').forEach((n) => {
    const go = () => void selectSession(ST.sessions[Number(n.dataset.i)].chatId, ST.sessions[Number(n.dataset.i)].sessionId);
    n.onclick = go;
    n.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}

const fmtSize = (n) => {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/** 相对时间（列表条目右上角）：今天 HH:MM / 昨天 / M-D / 跨年 YYYY-M-D */
const fmtRel = (iso) => {
  const ms = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(new Date()) - day0(d)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return '昨天';
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}-${d.getDate()}`;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
/** 日期段（信息行时间范围用）：今天/昨天/M-D（ts 为北京时间 ISO，直接取日期段避免跨时区换算） */
const fmtDayRel = (ts) => {
  const s = String(ts ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s.slice(0, 10);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return `${+m[2]}-${+m[3]}`;
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const d = new Date(ms);
  const diff = Math.round((day0(new Date()) - day0(d)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return `${+m[2]}-${+m[3]}`;
};

function renderDetailEmpty() {
  $('#chDetail').innerHTML = '<div class="empty" style="margin-top:80px">选择左侧会话查看会话详情</div>';
}

function renderDetailSkeleton() {
  const s = curSession();
  $('#chDetail').innerHTML = `
    <header class="panel-head" style="padding-bottom:12px;border-bottom:1px solid var(--border)">
      <h3 id="chDName"></h3>${typeTag(s?.chatType)}
      <div class="panel-actions">
        <button class="btn sm" id="chCopyId">${svg(IC.copy, 13)} 复制会话 ID</button>
        <button class="btn sm" id="chatRefresh" title="重拉会话树与本会话记录">↻</button>
      </div></header>
    <div class="panel-body" style="padding-top:6px">
      <div class="mini-note" id="chDMeta" style="margin:0 0 8px"></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
        <input type="search" id="chatKw" placeholder="关键词：定位对话…" style="width:200px;padding:5px 10px;font-size:12.5px">
        <button class="btn sm primary" id="chatGo">查询</button>
        <span id="kwNav" hidden style="display:inline-flex;align-items:center;gap:6px">
          <span class="mini-note" id="kwPos"></span>
          <button class="btn sm" id="kwPrev" title="上一处">↑</button>
          <button class="btn sm" id="kwNext" title="下一处">↓</button>
          <button class="btn sm ghost" id="kwClear" title="清除关键词">✕</button>
        </span>
        <span class="mini-note" id="chatScan"></span>
      </div>
      <div id="chatTl" class="chats-scroll"></div>
    </div>`;
  $('#chDName').textContent = s?.title || ST.session.slice(0, 8);
  // 只读信息行：聊天对象（群聊场景，私聊对象=成员本人不再重复）· 成员 · 时间范围（时间线渲染后回填）
  $('#chDMeta').innerHTML = `${s?.chatType === 'group' ? `${esc(s?.chatName || ST.chat)} · ` : ''}成员：${esc(membersOf(s) || '未知用户')} · 时间范围：<b id="chDRange">渲染后回填</b>`;
  $('#chCopyId').onclick = async () => {
    try { await navigator.clipboard.writeText(ST.session); toast(`会话 ID ${ST.session} 已复制`); }
    catch { toast('复制失败（浏览器剪贴板权限）', true); }
  };
  // 查询制：关键词改动不立即生效，回车或点「查询」统一应用（主人反馈：不要选一下就搜）
  $('#chatGo').onclick = () => void loadTimeline();
  $('#chatKw').onkeydown = (e) => { if (e.key === 'Enter') $('#chatGo').click(); };
  $('#kwPrev').onclick = () => { ST.kwAt--; gotoKwHit(); };
  $('#kwNext').onclick = () => { ST.kwAt++; gotoKwHit(); };
  $('#kwClear').onclick = () => { ST.taskKw = ''; $('#chatKw').value = ''; renderTimeline(); };
  $('#chatRefresh').onclick = () => void fullRefresh();
}

/** 刷新 = 重查第 1 页最新数据 + 尽量留在当前会话（不在了就落到最新一条） */
async function fullRefresh() {
  await freshQuery({ keep: { chat: ST.chat, session: ST.session } });
}

async function loadTimeline() {
  const tl = $('#chatTl');
  if (!tl || !ST.session) return;
  // 筛选值以 DOM 现值为准（查询按钮已把关键词写入 DOM；selectSession 流程骨架刚重建）
  ST.taskKw = ($('#chatKw')?.value || '').trim();
  ST.kwAt = 0;
  tl.innerHTML = '<div class="hint" style="padding:6px 2px">加载中…</div>';
  const p = new URLSearchParams({ app: ST.app, chat: ST.chat, session: ST.session });
  try {
    const r = await api('GET', `/api/chats/timeline?${p.toString()}`);
    ST.tasks = r.tasks ?? [];
    ST.truncated = !!r.truncated;
    ST.partial = !!r.partial;
  } catch (e) {
    tl.innerHTML = `<div class="empty">时间线加载失败：${esc(e.message)}</div>`;
    return;
  }
  bootStage('正在渲染消息…'); // 仅初始进页有加载层时生效；页内查询时层已移除，自动 no-op
  renderTimeline();
}

/** 信息行时间范围回填：该会话首末任务时间（同天只写一个日期） */
function fillRange() {
  const el = $('#chDRange');
  if (!el) return;
  if (!ST.tasks.length) { el.textContent = '—'; return; }
  const a = ST.tasks[0];
  const b = ST.tasks[ST.tasks.length - 1];
  const da = String(a.ts).slice(0, 10);
  const db = String(b.ts).slice(0, 10);
  el.textContent = da === db
    ? `${fmtDayRel(da)} ${fmtTime(a.ts)} ~ ${fmtTime(b.ts)}`
    : `${fmtDayRel(da)} ${fmtTime(a.ts)} ~ ${fmtDayRel(db)} ${fmtTime(b.ts)}`;
}

function renderTimeline() {
  const tl = $('#chatTl');
  if (!tl) return;
  const notes = [];
  if (ST.truncated) notes.push('已达单次返回上限，仅显示最近一部分');
  if (ST.partial) notes.push('历史文件超量，仅扫描了部分（防呆上限 300 文件 / 150MB）');
  $('#chatScan').textContent = notes.join(' · ');
  if (!ST.tasks.length) {
    tl.innerHTML = '<div class="empty">该会话暂无可读消息<br><span class="mini-note">可能早于落盘功能启用，或落盘文件已被保留期清理。</span></div>';
    fillRange();
    return;
  }
  const botName = ST.name || '机器人';
  let html = '';
  let lastDate = '';
  let idx = 0;
  for (const t of ST.tasks) {
    if (t.date !== lastDate) {
      lastDate = t.date;
      html += `<div class="cmsg-day">${esc(fmtDayRel(t.date))}</div>`;
    }
    html += taskHtml(t, botName, idx);
    idx++;
  }
  tl.innerHTML = html;
  fillRange();
  // 「查看完整内容」折叠切换（用户消息）
  tl.querySelectorAll('[data-more]').forEach((b) => b.onclick = () => {
    const f = b.nextElementSibling;
    f.hidden = !f.hidden;
    b.textContent = f.hidden ? '查看完整内容' : '收起完整内容';
  });
  // AI 回复气泡：Markdown 视图 ↔ 纯文本原文切换
  tl.querySelectorAll('[data-md-toggle]').forEach((b) => {
    b.onclick = () => {
      const task = ST.tasks[Number(b.dataset.task)];
      const bubbleEl = b.closest('.m-bubble');
      if (!task || !bubbleEl) return;
      const toRaw = b.dataset.mode === 'md';
      bubbleEl.innerHTML = toRaw ? `<div class="m-raw">${esc(task.reply)}</div>` : renderMarkdown(task.reply);
      bubbleEl.appendChild(b);
      b.dataset.mode = toRaw ? 'raw' : 'md';
      b.textContent = toRaw ? 'Markdown 视图' : '查看原文';
    };
  });
  bindKwNav(tl);
}

// ============ 关键词定位：任务级命中 → n/m 计数 + 上下切换 + 滚动定位 ============

/** 渲染后收集命中并跳到第一处（ST.taskKw 由「查询」写入） */
function bindKwNav(tl) {
  const nav = $('#kwNav');
  if (!nav) return;
  ST.kwHits = [];
  const kw = (ST.taskKw || '').toLowerCase();
  if (kw) {
    ST.tasks.forEach((t, i) => {
      const hay = `${t.prompt || ''}\n${t.reply || ''}\n${(t.tools || []).map((x) => x.tool || '').join('\n')}`.toLowerCase();
      if (hay.includes(kw)) ST.kwHits.push(i);
    });
  }
  if (!ST.kwHits.length) { nav.hidden = true; return; }
  ST.kwAt = Math.min(ST.kwAt, ST.kwHits.length - 1);
  nav.hidden = false;
  gotoKwHit();
}

/** 跳到当前命中：高亮任务块 + 滚动居中（循环） */
function gotoKwHit() {
  const tl = $('#chatTl');
  if (!tl || !ST.kwHits.length) return;
  ST.kwAt = ((ST.kwAt % ST.kwHits.length) + ST.kwHits.length) % ST.kwHits.length;
  const idx = ST.kwHits[ST.kwAt];
  const pos = $('#kwPos');
  if (pos) pos.textContent = `第 ${ST.kwAt + 1}/${ST.kwHits.length} 处`;
  tl.querySelectorAll('.kw-active').forEach((n) => n.classList.remove('kw-active'));
  const node = tl.querySelector(`[data-task-idx="${idx}"]`);
  if (node) {
    node.classList.add('kw-active');
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function taskHtml(t, botName, idx) {
  const who = ST.nameByUser[t.userId] || short(t.userId, 12);
  const meAva = `<span class="m-ava">${esc(who[0] || '?')}</span>`;
  const tools = t.tools?.length ? `
    <details class="adv" style="margin:6px 0 6px 37px;max-width:min(76%,740px)">
      <summary>⚙ ${t.tools.length} 次工具调用</summary>
      <div class="adv-body">${t.tools.map((x) => `<div class="mono" style="padding:2px 0">${x.ok === false ? '<span style="color:var(--err-tx)">✗</span>' : x.ok === true ? '<span style="color:var(--ok-tx)">✓</span>' : '<span class="dim">·</span>'} ${esc(short(x.tool, 120))}</div>`).join('')}</div>
    </details>` : '';
  const summary = t.result ? `
    <div class="csum">
      <div class="csum-top"><b>任务执行摘要</b>${RESULT_BADGE[t.result.subtype] || `<span class="tag off">${esc(t.result.subtype)}</span>`}</div>
      <div class="csum-stats">
        <span>工具调用 <b>${t.tools?.length || 0}</b> 次</span>
        <span>对话轮次 <b>${t.result.turns || 0}</b> 轮</span>
        ${t.result.producedFiles?.length ? `<span>产出文件 <b>${t.result.producedFiles.length}</b> 个</span>` : ''}
        <span>时间 <b>${esc(fmtTime(t.ts))}</b></span>
      </div>
    </div>` : '';
  // AI 回复默认按 Markdown 渲染（回复多为 md 格式）；「查看原文」切纯文本
  const replyBubble = t.reply ? `
    <div class="cmsg">
      <span class="m-ava">${esc((botName || 'B')[0])}</span>
      <div class="m-body">
        <div class="m-meta">${esc(botName)} <span>${esc(fmtTime(t.ts))}</span></div>
        <div class="m-bubble">${renderMarkdown(t.reply)}<button class="btn sm ghost m-link" data-md-toggle data-task="${idx}" data-mode="md">查看原文</button></div>
      </div>
    </div>` : '';
  return `
  <div class="chat-task" data-task-idx="${idx}">
    <div class="cmsg me">
      ${meAva}
      <div class="m-body">
        <div class="m-meta" style="justify-content:flex-end">${esc(who)} <span>${esc(fmtTime(t.ts))}</span></div>
        <div class="m-bubble">${promptHtml(t.prompt, ST.taskKw)}</div>
      </div>
    </div>
    ${tools}
    ${replyBubble}
    ${summary}
  </div>`;
}

/** 用户消息渲染：有关键词时做命中高亮（先分段再各自转义，无 XSS）；>600 字折叠 */
function promptHtml(text, kw) {
  const s = String(text ?? '');
  const mark = (str) => {
    if (!kw) return esc(str);
    const re = new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return str.split(re).map((p, i) => (i % 2 ? `<mark class="kw-mark">${esc(p)}</mark>` : esc(p))).join('');
  };
  if (s.length > 600) {
    return `${mark(s.slice(0, 600))}…<button class="btn sm ghost m-link" data-more>查看完整内容</button><div class="m-full" hidden>${esc(s)}</div>`;
  }
  return mark(s);
}

const short = (s, n) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
};
const fmtTime = (ts) => {
  const s = String(ts ?? '');
  // ts 为北京时间 ISO（…T21:53:00.000+08:00）——直接取时刻段，避免跨时区换算
  const m = s.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : s;
};
