// ============ 会话 ============
// LCB 本地聊天时间线只读查看器（原型会话页形态）：查询条件卡 → 会话（聊天对象）列表 →
// 气泡消息流 + 任务执行摘要卡。后端 /api/chats/*（chats-api.ts）三接口：树 + 话题 + 任务
// 时间线，全部只读、缺天静默容忍。任务 = 一条飞书消息触发的一次 CC 执行。
// 搜索过滤只切换列表项显隐、不重建 DOM（兼容中文输入法组合输入）。
import { $, esc, api, toast } from '../core.js';
import { renderMarkdown } from '../markdown.js';

/** 页面态（切页重进即重置；不做跨页缓存——树接口本身就是目录扫描，量级很轻） */
const ST = {
  bots: [],            // /api/chats/tree
  app: '', chat: '',   // 当前选中通道
  users: [], dates: [],// 当前通道筛选项（来自树）
  nameByUser: {},      // userId → 显示名（access 人名 + 飞书解析名，兜底尾号）
  topics: [],          // /api/chats/topics
  topic: '',           // 话题筛选（sessionId；''=按日期浏览）
  date: '',            // 日期筛选（'' = 最新一天）
  user: '',            // 人筛选（''=全部）
  kw: '',              // 关键词（定位对话用；''=不检索）
  kwHits: [], kwAt: 0, // 关键词命中的任务索引与当前指向
  tasks: [], truncated: false, partial: false,
};

const svg = (inner, s = 14) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const IC = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/>',
  copy: '<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  group: '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 20c0-3.4 2.9-5.2 6.5-5.2s6.5 1.8 6.5 5.2"/><path d="M16 14.6c3 .4 5.5 2 5.5 5.4"/>',
};

const RESULT_BADGE = {
  success: '<span class="tag ok">已完成</span>',
  stopped: '<span class="tag off">已停止</span>',
  error: '<span class="tag err">出错</span>',
};

export const page = {
  id: 'chats',
  title: '会话',
  desc: '按机器人与聊天对象检索历史对话，查看完整消息与任务执行详情',
  legend: false,
  icon: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  async render(el) {
    el.innerHTML = `
    <div class="panel">
      <header class="panel-head"><h3>查询条件</h3>
        <div class="panel-actions"><span class="dim" style="font-size:11.5px">选择机器人后，左侧列出有落盘记录的聊天对象</span></div></header>
      <div class="panel-body">
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div><label class="fld">飞书机器人 *</label>
            <select id="chBot" style="width:220px"></select></div>
          <button class="btn primary" id="chGo">${svg(IC.search, 13)} 查询会话</button>
        </div>
        <div class="mini-note" style="margin-top:8px">记录落盘于 <code>~/.lark-claudecode-bridge/transcripts/</code>；默认展示每个通道最近一天的记录，设好筛选后点「查询」加载。</div>
        <div class="mini-note" id="chPermHint" hidden style="margin-top:4px;color:var(--warn-tx)">ⓘ 当前显示为飞书 ID（ou_…）：请在飞书开放平台为对应机器人应用开通「获取用户基本信息」（contact:user.base:readonly）权限并发布版本；开通后约 10 分钟内自动恢复真名，无须重启。</div>
      </div>
    </div>
    <div class="chats-layout">
      <div class="panel" style="margin:0">
        <header class="panel-head"><h3>会话列表</h3>
          <div class="panel-actions"><span class="tag off" id="chCnt"></span></div></header>
        <div style="padding:10px 12px 8px"><input type="search" id="chQ" placeholder="搜索聊天对象…"></div>
        <div class="chat-list-panel" id="chList" style="border-top:1px solid var(--border)"></div>
      </div>
      <div class="panel" style="margin:0;min-height:440px" id="chDetail"></div>
    </div>`;
    try {
      const r = await api('GET', '/api/chats/tree');
      ST.bots = r.bots ?? [];
    } catch (e) {
      $('#chDetail').innerHTML = `<div class="empty" style="margin-top:60px">会话树加载失败：${esc(e.message)}</div>`;
      return;
    }
    // 真名依赖 contact:user.base:readonly 权限：只要还有「未解析的 ou_ 用户」就给出指路提示
    //（配对过的人名不受影响照常显示；全部解析到真名才隐藏提示）
    const hasAnonOu = ST.bots.some((b) => b.channels.some((c) => c.users.some((u) => !u.name && /^ou_/i.test(u.userId))));
    const permHint = $('#chPermHint');
    if (permHint) permHint.hidden = !hasAnonOu;
    const botSel = $('#chBot');
    botSel.innerHTML = ST.bots.map((b) => `<option value="${esc(b.appId)}">${esc(b.name)}（${esc(b.appId)}）</option>`).join('');
    if (!ST.bots.length) {
      $('#chList').innerHTML = '<div class="empty">暂无会话记录<br><span class="mini-note">还没有任何对话落盘。在飞书里和机器人聊几句后回来看。</span></div>';
      $('#chCnt').textContent = '0 条会话';
      $('#chGo').disabled = true;
      return;
    }
    $('#chGo').onclick = () => void selectChannel(botSel.value, (ST.bots.find((b) => b.appId === botSel.value)?.channels[0]?.chatId) || '');
    botSel.onchange = () => { $('#chGo').click(); };
    // 默认选中最近活跃的第一个通道，进来即有内容可看
    const firstBot = ST.bots.find((b) => b.channels.length);
    if (firstBot) {
      botSel.value = firstBot.appId;
      await selectChannel(firstBot.appId, firstBot.channels[0].chatId);
    } else {
      renderList();
      renderDetailEmpty();
    }
  },
};

/** 飞书 id 不在树里也要能拼选择器（esc 后进 data 属性，dataset 取回即原文） */
function chanOf(app, chat) {
  for (const b of ST.bots) {
    if (b.appId !== app) continue;
    const c = b.channels.find((x) => x.chatId === chat);
    if (c) return { bot: b, chan: c };
  }
  return null;
}

function renderList() {
  const el = $('#chList');
  const bot = ST.bots.find((b) => b.appId === ST.app);
  if (!bot) { el.innerHTML = '<div class="empty">无记录通道</div>'; $('#chCnt').textContent = '0 条会话'; return; }
  el.innerHTML = bot.channels.map((c) => `
    <div class="chat-obj ${bot.appId === ST.app && c.chatId === ST.chat ? 'active' : ''}" data-chat="${esc(c.chatId)}" role="button" tabindex="0" title="${esc(c.chatId)}">
      <span class="c-ava">${c.chatType === 'group' ? svg(IC.group, 15) : esc((c.displayName || '?')[0])}</span>
      <div class="c-main">
        <div class="c-top"><span class="c-name">${esc(c.displayName)}</span><span class="c-time">${c.dates.length} 天</span></div>
        <div class="c-prev">${c.topics} 话题 · ${fmtSize(c.sizeBytes)}</div>
        <div class="c-badges">${c.chatType === 'group' ? '<span class="tag info">群聊</span>' : '<span class="tag off">私聊</span>'}</div>
      </div>
    </div>`).join('') || '<div class="empty">无记录通道</div>';
  $('#chCnt').textContent = `${bot.channels.length} 条会话`;
  el.querySelectorAll('.chat-obj').forEach((n) => {
    n.onclick = () => void selectChannel(ST.app, n.dataset.chat);
    n.onkeydown = (e) => { if (e.key === 'Enter') void selectChannel(ST.app, n.dataset.chat); };
  });
  applyFilter();
}

/** 搜索过滤：只切换显隐不重建 DOM（兼容中文输入法组合输入） */
function applyFilter() {
  const inp = $('#chQ');
  if (!inp) return;
  const kw = (inp.value || '').trim().toLowerCase();
  $('#chList').querySelectorAll('.chat-obj').forEach((n) => {
    n.hidden = !!kw && !n.textContent.toLowerCase().includes(kw);
  });
}

const fmtSize = (n) => {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

async function selectChannel(app, chat) {
  if (!chat) return;
  ST.app = app;
  ST.chat = chat;
  ST.topic = '';
  ST.user = '';
  const hit = chanOf(app, chat);
  ST.dates = hit?.chan.dates ?? [];
  ST.date = ST.dates[0] ?? '';
  ST.users = hit?.chan.users ?? [];
  ST.nameByUser = {};
  for (const u of ST.users) ST.nameByUser[u.userId] = u.name || `${u.userId.slice(0, 10)}…`;
  renderList();
  renderDetailSkeleton();
  try {
    const r = await api('GET', `/api/chats/topics?app=${encodeURIComponent(app)}&chat=${encodeURIComponent(chat)}`);
    ST.topics = r.topics ?? [];
  } catch { ST.topics = []; } // 话题接口失败不挡时间线：按日期照样能看
  renderFilters();
  await loadTimeline();
}

function renderDetailEmpty() {
  $('#chDetail').innerHTML = '<div class="empty" style="margin-top:80px">选择左侧聊天对象查看会话详情</div>';
}

function renderDetailSkeleton() {
  const hit = chanOf(ST.app, ST.chat);
  const c = hit?.chan;
  $('#chDetail').innerHTML = `
    <header class="panel-head" style="padding-bottom:12px;border-bottom:1px solid var(--border)">
      <h3 id="chDName"></h3>
      <span class="panel-sub" id="chDSub"></span>
      <div class="panel-actions">
        <button class="btn sm" id="chCopyId">${svg(IC.copy, 13)} 复制会话 ID</button>
      </div></header>
    <div class="panel-body" style="padding-top:6px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
        <select id="chatTopic" style="width:auto;max-width:250px" title="按话题（CC 会话）筛选，跨天聚合"></select>
        <select id="chatDate" style="width:auto" title="按天浏览"></select>
        <select id="chatUser" style="width:auto" title="按发信人筛选"></select>
        <input type="search" id="chatKw" placeholder="关键词：定位对话…" style="width:180px;padding:5px 10px;font-size:12.5px">
        <button class="btn sm primary" id="chatGo">查询</button>
        <button class="btn sm" id="chatReset" title="恢复默认筛选并重新加载">重置</button>
        <button class="btn sm" id="chatRefresh" title="重拉会话树与本通道记录">↻</button>
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
  $('#chDName').innerHTML = `${esc(c?.displayName || ST.chat)} ${c?.chatType === 'group' ? '<span class="tag info">群聊</span>' : '<span class="tag off">私聊</span>'}`;
  $('#chDSub').textContent = `${hit?.bot.name || ''}${ST.topic ? '' : ''} · ${c?.topics ?? 0} 话题 · ${fmtSize(c?.sizeBytes ?? 0)}`;
  $('#chCopyId').onclick = async () => {
    try { await navigator.clipboard.writeText(ST.chat); toast(`会话 ID ${ST.chat} 已复制`); }
    catch { toast('复制失败（浏览器剪贴板权限）', true); }
  };
  // 查询制：下拉/关键词改动不立即生效，点「查询」统一应用（主人反馈：不要选一下就搜）
  $('#chatTopic').onchange = (e) => { $('#chatDate').disabled = !!e.target.value; };
  $('#chatGo').onclick = () => {
    ST.topic = $('#chatTopic').value;
    ST.date = $('#chatDate').value;
    ST.user = $('#chatUser').value;
    ST.kw = $('#chatKw').value.trim();
    void loadTimeline();
  };
  $('#chatKw').onkeydown = (e) => { if (e.key === 'Enter') $('#chatGo').click(); };
  $('#chatReset').onclick = () => {
    ST.topic = '';
    ST.user = '';
    ST.kw = '';
    $('#chatKw').value = '';
    ST.date = ST.dates[0] ?? '';
    renderFilters();
    void loadTimeline();
  };
  $('#kwPrev').onclick = () => { ST.kwAt--; gotoKwHit(); };
  $('#kwNext').onclick = () => { ST.kwAt++; gotoKwHit(); };
  $('#kwClear').onclick = () => { ST.kw = ''; $('#chatKw').value = ''; renderTimeline(); };
  $('#chatRefresh').onclick = () => void fullRefresh();
}

/** 刷新 = 重拉树 + 重拉当前通道话题与时间线（群名/新落盘一并更新） */
async function fullRefresh() {
  try {
    const r = await api('GET', '/api/chats/tree');
    ST.bots = r.bots ?? [];
  } catch (e) { toast(`刷新失败：${e.message}`, true); }
  if (chanOf(ST.app, ST.chat)) await selectChannel(ST.app, ST.chat);
  else renderList();
}

function renderFilters() {
  const topic = $('#chatTopic');
  if (topic) {
    topic.innerHTML = `<option value="">全部话题（按天浏览）</option>` + ST.topics.map((t) =>
      `<option value="${esc(t.sessionId)}" ${t.sessionId === ST.topic ? 'selected' : ''}>${esc(short(t.title, 42))}</option>`).join('');
    topic.value = ST.topic;
    topic.disabled = ST.topics.length === 0;
  }
  const date = $('#chatDate');
  if (date) {
    date.innerHTML = ST.dates.map((d) => `<option value="${esc(d)}" ${d === ST.date ? 'selected' : ''}>${esc(d)}</option>`).join('');
    date.disabled = !!ST.topic;
    if (!ST.topic && !ST.dates.includes(ST.date)) ST.date = ST.dates[0] ?? '';
    date.value = ST.date;
  }
  const user = $('#chatUser');
  if (user) {
    user.innerHTML = `<option value="">全部成员</option>` + ST.users.map((u) =>
      `<option value="${esc(u.userId)}" ${u.userId === ST.user ? 'selected' : ''}>${esc(u.name || short(u.userId, 14))}</option>`).join('');
    user.value = ST.user;
    user.disabled = ST.users.length === 0;
  }
}

async function loadTimeline() {
  const tl = $('#chatTl');
  if (!tl) return;
  // 筛选值以 DOM 现值为准（查询按钮已把下拉/关键词写入 DOM；selectChannel 流程 renderFilters 刚回填默认）
  ST.topic = $('#chatTopic')?.value ?? '';
  ST.date = $('#chatDate')?.value ?? ST.date;
  ST.user = $('#chatUser')?.value ?? '';
  ST.kw = ($('#chatKw')?.value || '').trim();
  ST.kwAt = 0;
  if (!ST.dates.length) {
    tl.innerHTML = '<div class="empty">这一天没有记录<br><span class="mini-note">该通道没有可读的落盘文件（可能已被保留期清理）。</span></div>';
    return;
  }
  tl.innerHTML = '<div class="hint" style="padding:6px 2px">加载中…</div>';
  const p = new URLSearchParams({ app: ST.app, chat: ST.chat });
  if (ST.topic) p.set('session', ST.topic);
  else p.set('date', ST.date || ST.dates[0]);
  if (ST.user) p.set('user', ST.user);
  try {
    const r = await api('GET', `/api/chats/timeline?${p.toString()}`);
    ST.tasks = r.tasks ?? [];
    ST.truncated = !!r.truncated;
    ST.partial = !!r.partial;
  } catch (e) {
    tl.innerHTML = `<div class="empty">时间线加载失败：${esc(e.message)}</div>`;
    return;
  }
  renderTimeline();
}

function renderTimeline() {
  const tl = $('#chatTl');
  const notes = [];
  if (ST.topic) notes.push(`话题视图：跨 ${ST.tasks.length ? new Set(ST.tasks.map((t) => t.date)).size : 0} 天聚合`);
  if (ST.truncated) notes.push('已达单次返回上限，仅显示最近一部分');
  if (ST.partial) notes.push('历史文件超量，仅扫描了部分（防呆上限 300 文件 / 150MB）');
  $('#chatScan').textContent = notes.join(' · ');
  if (!ST.tasks.length) {
    tl.innerHTML = `<div class="empty">没有匹配的记录<br><span class="mini-note">${ST.topic ? '该话题暂无可读消息（可能早于落盘功能启用）。' : '换个日期或清除筛选试试。'}</span></div>`;
    return;
  }
  const botName = chanOf(ST.app, ST.chat)?.bot.name || '机器人';
  let html = '';
  let lastDate = '';
  let idx = 0;
  for (const t of ST.tasks) {
    if (t.date !== lastDate) {
      lastDate = t.date;
      html += `<div class="cmsg-day">${esc(t.date)}</div>`;
    }
    html += taskHtml(t, botName, idx);
    idx++;
  }
  tl.innerHTML = html;
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

/** 渲染后收集命中并跳到第一处（ST.kw 由「查询」写入） */
function bindKwNav(tl) {
  const nav = $('#kwNav');
  if (!nav) return;
  ST.kwHits = [];
  const kw = (ST.kw || '').toLowerCase();
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
        <div class="m-bubble">${promptHtml(t.prompt, ST.kw)}</div>
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
