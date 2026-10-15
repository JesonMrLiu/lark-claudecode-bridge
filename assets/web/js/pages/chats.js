// ============ 会话记录 ============
// LCB 本地聊天时间线只读查看器：机器人 → 通道（飞书真群名）→ 按天 / 按话题浏览任务级对话。
// 后端 /api/chats/*（chats-api.ts）三接口：树 + 话题 + 任务时间线，全部只读、缺天静默容忍。
// 任务 = 一条飞书消息触发的一次 CC 执行（user 提问 + AI 回复拼接 + 工具折叠行 + 收尾状态）。
import { $, esc, api, toast } from '../core.js';

/** 页面态（切页重进即重置；不做跨页缓存——树接口本身就是目录扫描，量级很轻） */
const ST = {
  bots: [],            // /api/chats/tree
  app: '', chat: '',   // 当前选中通道
  users: [], dates: [],// 当前通道筛选项（来自树）
  nameByUser: {},      // userId → 显示名（access 人名，兜底尾号）
  topics: [],          // /api/chats/topics
  topic: '',           // 话题筛选（sessionId；''=按日期浏览）
  date: '',            // 日期筛选（'' = 最新一天）
  user: '',            // 人筛选（''=全部）
  tasks: [], truncated: false, partial: false,
};

const iconSvg = (name) => ({
  bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
  p2p: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  group: '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 20c0-3.4 2.9-5.2 6.5-5.2s6.5 1.8 6.5 5.2"/><path d="M16 14.6c3 .4 5.5 2 5.5 5.4"/>',
}[name] || '');

const RESULT_BADGE = {
  success: '<span class="tag ok">完成</span>',
  stopped: '<span class="tag off">已停止</span>',
  error: '<span class="tag err">出错</span>',
};

export const page = {
  id: 'chats',
  title: '会话',
  icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9.5h8M8 13.5h5"/>',
  async render(el) {
    el.innerHTML = '<div class="hint" style="padding:8px 2px">加载会话树…</div><div class="chats-wrap" id="chatsWrap" hidden><div class="chats-side" id="chatSide"></div><div class="chats-main" id="chatMain"></div></div>';
    try {
      const r = await api('GET', '/api/chats/tree');
      ST.bots = r.bots ?? [];
    } catch (e) {
      el.innerHTML = `<div class="card"><h3>会话树加载失败</h3><div class="desc">${esc(e.message)}</div></div>`;
      return;
    }
    $('#chatsWrap').hidden = false;
    renderSide();
    // 默认选中最近活跃的第一个通道，进来即有内容可看
    const firstBot = ST.bots.find((b) => b.channels.length);
    if (firstBot) await selectChannel(firstBot.appId, firstBot.channels[0].chatId);
    else renderMainEmpty();
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

function renderSide() {
  const el = $('#chatSide');
  if (!ST.bots.length) {
    el.innerHTML = '<div class="card"><h3>暂无会话记录</h3><div class="desc">还没有任何对话落盘（~/.lark-claudecode-bridge/transcripts/ 为空）。在飞书里和机器人聊几句后回来看。</div></div>';
    return;
  }
  el.innerHTML = ST.bots.map((b) => `
    <div class="chat-bot">
      <div class="chat-bot-name">${icoBot()}${esc(b.name)}</div>
      ${b.channels.map((c) => `
        <button class="chat-chan ${b.appId === ST.app && c.chatId === ST.chat ? 'active' : ''}"
                data-app="${esc(b.appId)}" data-chat="${esc(c.chatId)}" title="${esc(c.chatId)}">
          <span class="chat-chan-name">${icoChan(c)}${esc(c.displayName)}</span>
          <span class="chat-chan-meta">${c.topics} 话题 · ${c.dates.length} 天 · ${fmtSize(c.sizeBytes)}</span>
        </button>`).join('') || '<div class="chat-chan-none">无记录通道</div>'}
    </div>`).join('');
  el.querySelectorAll('.chat-chan').forEach((btn) => {
    btn.onclick = () => void selectChannel(btn.dataset.app, btn.dataset.chat);
  });
}

const icoBot = () => `<span class="chat-ico"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconSvg('bot')}</svg></span>`;
const icoChan = (c) => `<span class="chat-ico"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconSvg(c.chatType === 'group' ? 'group' : c.chatType === 'p2p' ? 'p2p' : 'p2p')}</svg></span>`;

function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function selectChannel(app, chat) {
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
  renderSide();
  renderMainSkeleton();
  try {
    const r = await api('GET', `/api/chats/topics?app=${encodeURIComponent(app)}&chat=${encodeURIComponent(chat)}`);
    ST.topics = r.topics ?? [];
  } catch { ST.topics = []; } // 话题接口失败不挡时间线：按日期照样能看
  renderFilters();
  await loadTimeline();
}

function renderMainEmpty() {
  $('#chatMain').innerHTML = '<div class="card"><h3>选择左侧通道查看对话</h3><div class="desc">左侧按机器人分组列出有落盘记录的会话通道。</div></div>';
}

function renderMainSkeleton() {
  $('#chatMain').innerHTML = `
    <div class="chat-filters">
      <select id="chatTopic" class="chat-select" title="按话题（CC 会话）筛选，跨天聚合"></select>
      <select id="chatDate" class="chat-select" title="按天浏览"></select>
      <select id="chatUser" class="chat-select" title="按发信人筛选"></select>
      <button class="btn sm" id="chatRefresh">刷新</button>
      <span class="chat-scan" id="chatScan"></span>
    </div>
    <div class="chat-timeline" id="chatTl"></div>`;
  $('#chatTopic').onchange = (e) => {
    ST.topic = e.target.value;
    $('#chatDate').disabled = !!ST.topic; // 话题视图跨天，日期筛选失效
    void loadTimeline();
  };
  $('#chatDate').onchange = (e) => { ST.date = e.target.value; void loadTimeline(); };
  $('#chatUser').onchange = (e) => { ST.user = e.target.value; void loadTimeline(); };
  $('#chatRefresh').onclick = () => void fullRefresh();
}

/** 刷新 = 重拉树 + 重拉当前通道话题与时间线（群名/新落盘一并更新） */
async function fullRefresh() {
  try {
    const r = await api('GET', '/api/chats/tree');
    ST.bots = r.bots ?? [];
  } catch (e) { toast(`刷新失败：${e.message}`, true); }
  if (chanOf(ST.app, ST.chat)) await selectChannel(ST.app, ST.chat);
  else renderSide();
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
  if (!ST.dates.length) {
    tl.innerHTML = '<div class="card"><h3>这一天没有记录</h3><div class="desc">该通道没有可读的落盘文件（可能已被保留期清理）。</div></div>';
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
    tl.innerHTML = `<div class="card"><h3>时间线加载失败</h3><div class="desc">${esc(e.message)}</div></div>`;
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
    tl.innerHTML = `<div class="card"><h3>没有匹配的记录</h3><div class="desc">${ST.topic ? '该话题暂无可读消息（可能早于落盘功能启用）。' : '换个日期或清除筛选试试。'}</div></div>`;
    return;
  }
  let html = '';
  let lastDate = '';
  for (const t of ST.tasks) {
    if (t.date !== lastDate) {
      lastDate = t.date;
      html += `<div class="chat-day-head">${esc(t.date)}</div>`;
    }
    html += taskHtml(t);
  }
  tl.innerHTML = html;
}

function taskHtml(t) {
  const who = ST.nameByUser[t.userId] || short(t.userId, 12);
  const tools = t.tools?.length ? `
    <details class="chat-tools">
      <summary>⚙ ${t.tools.length} 次工具调用</summary>
      ${t.tools.map((x) => `<div class="chat-tool">${x.ok === false ? '✗' : x.ok === true ? '✓' : '·'} ${esc(short(x.tool, 120))}</div>`).join('')}
    </details>` : '';
  const res = t.result ? `
    <div class="chat-result">${RESULT_BADGE[t.result.subtype] || esc(t.result.subtype)}
      ${t.result.turns ? `<span class="chat-res-meta">· ${t.result.turns} 轮</span>` : ''}
      ${t.result.producedFiles?.length ? `<span class="chat-res-meta">· 产出 ${t.result.producedFiles.length} 个文件</span>` : ''}
      <span class="chat-res-meta">· ${esc(fmtTime(t.ts))}</span>
    </div>` : '';
  return `<div class="chat-task">
    <div class="msg user">
      <div class="bubble">${bubble(t.prompt)}</div>
      <div class="meta">${esc(who)}<br>${esc(fmtTime(t.ts))}</div>
    </div>
    ${tools}
    ${t.reply ? `<div class="msg ai"><div class="bubble">${bubble(t.reply)}</div></div>` : ''}
    ${res}
  </div>`;
}

/** 长文本折叠（>600 字用 details；保留换行） */
function bubble(text) {
  const s = String(text ?? '');
  if (s.length > 600) {
    return `<details><summary>展开全文（${s.length} 字）</summary>${esc(s)}</details>`;
  }
  return esc(s);
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
