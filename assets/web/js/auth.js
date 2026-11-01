// ============ 配置页密码锁屏（原型设置/锁屏模块的服务端真实现） ============
// 行为约定：
// - 进页即锁：每次进入配置页（刷新/新开标签）都要输入密码，服务端会话放行 API（会话已持久化，
//   桥接器重启后会话延续，重启轮询/刷新不再被 401 拦截；手动锁屏/登出仍即时吊销）
// - 默认密码 123456；解锁响应带 isDefault，仍为默认密码时每次登录弹「修改默认密码」引导
// - 无操作自动锁屏：lockMinutes 分钟（服务端 webauth.json，默认 30 分钟；0=永不），双端同步过期。
//   「操作」= 鼠标键盘交互 或 本页 API 成功响应（与服务端滑动续期同语义，2026-11-01 起），
//   且经 localStorage 心跳跨标签页共享——后台标签页不再误吊销前台正在使用的会话
// - 恢复初始密码两条路：本弹窗（验当前密码）/ 本机终端 `lcb reset-password`（忘记密码兜底）
// - 密文落盘在服务端（webauth.json 只存 salt+md5），前端全程不接触哈希
import { $, api, toast, hooks } from './core.js';
import { openModal, closeModal, confirmDialog } from './ui.js';

export const AUTH = {
  unlocked: false,
  everUnlocked: false, // 本次页面生命周期内是否解锁过：锁屏时才需要吊销服务端会话
  isDefault: true,
  lockMinutes: 30,
  lastActive: Date.now(),
  enteredPwd: '', // 本次解锁所输密码（仅内存）：引导改密时作为「当前密码」提交，免重复输入
};

// ---- 全局活跃心跳（localStorage 跨标签页共享）----
// 「无操作」必须是浏览器级的，不是单标签页级的：此前各标签页只记自己的 lastActive，
// 后台标签页看门狗到点即 lockPage——而 lockPage 会调 /api/auth/logout 吊销全局会话，
// 把前台正在活跃使用的其他标签页一起踢下线（用户视角：我明明一直在用，突然要解锁）。
// 现在活跃时写心跳、判定读全局最新值：任意标签页有活动 ⇒ 所有标签页都不锁。
const LS_ACTIVE_KEY = 'lcb.lastActive';
let lastBeatAt = 0;

/** 记录一次活跃：刷新本页时间戳 + 节流写全局心跳（mousemove 高频，5s 一次足够） */
function beatActivity(force = false) {
  const now = Date.now();
  AUTH.lastActive = now;
  if (!force && now - lastBeatAt < 5000) return;
  lastBeatAt = now;
  try { localStorage.setItem(LS_ACTIVE_KEY, String(now)); } catch { /* 隐私模式/file:// 下不可用：退化为本页判定 */ }
}

/** 全局最近活跃时刻：本页时间戳与共享心跳取新（读不到/异常 → 退化为本页时间戳） */
function globalLastActive() {
  try {
    const t = Number(localStorage.getItem(LS_ACTIVE_KEY));
    if (Number.isFinite(t) && t > 0) return Math.max(AUTH.lastActive, t);
  } catch { /* 同上 */ }
  return AUTH.lastActive;
}

const minsText = (m) => (m >= 60 ? `${m / 60} 小时` : `${m} 分钟`);
const svg = (inner, s = 15) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const IC_SETTINGS = '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>';
const IC_LOCK = '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
const IC_KEY = '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>';
const IC_ROTATE = '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>';

let onUnlockCb = null;

/** 锁屏：盖遮罩 + 吊销服务端会话（内网他人不能借已解锁 cookie 直调 API） */
export function lockPage() {
  const hadSession = AUTH.everUnlocked;
  AUTH.unlocked = false;
  AUTH.enteredPwd = '';
  $('#lockPwd').value = '';
  $('#lockErr').textContent = '';
  $('#lockMask').hidden = false;
  $('#lockBtn').hidden = true;
  $('#settingsBtn').hidden = true;
  if (hadSession) api('POST', '/api/auth/logout').catch(() => { /* 离线：无所谓 */ });
  setTimeout(() => $('#lockPwd').focus(), 60);
}

/** 无操作超时判定 + 锁屏：供活跃事件/看门狗 tick/页面回前台共用。
 * 返回是否已触发锁屏。核心修复：判定必须在「刷新 lastActive」之前做——
 * 否则后台标签页/睡眠唤醒后回来的第一个交互会先把 lastActive 刷成「刚刚」，
 * 看门狗永远判不超时 → 遮罩不出现，而服务端会话早已过期 → 僵尸态（页面正常但数据全 401）。
 * 判定基线是全局活跃（globalLastActive 跨标签页）：其他标签页正在用 ⇒ 本页不锁、不吊销会话 */
function checkIdle() {
  if (!AUTH.unlocked || !AUTH.lockMinutes) return false;
  if (Date.now() - globalLastActive() <= AUTH.lockMinutes * 60000) return false;
  lockPage();
  toast('已因长时间无操作自动锁屏，请重新输入密码', true);
  return true;
}

/** 解锁成功后的统一入口：via='password'（输密码登录，仍默认密码时弹引导）| 'session'（会话恢复免密） */
async function finishUnlock(meta, via) {
  AUTH.unlocked = true;
  AUTH.everUnlocked = true;
  AUTH.isDefault = !!meta.isDefault;
  AUTH.lockMinutes = Number(meta.lockMinutes) || 0;
  beatActivity(true); // 解锁即全局活跃（force 越过节流）：其他标签页的看门狗立即知晓
  $('#lockMask').hidden = true;
  $('#lockBtn').hidden = false;
  $('#settingsBtn').hidden = false;
  await onUnlockCb?.();
  // 改密引导只在「输密码登录」时弹：会话恢复的刷新不重复打扰（主人反馈：免密本就是为了少打扰）
  if (AUTH.isDefault && via === 'password') openPwdModal(true);
}

async function tryUnlock() {
  const pwd = $('#lockPwd').value;
  if (!pwd) { $('#lockErr').textContent = '请输入密码'; return; }
  const btn = $('#lockUnlock');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/auth/verify', { password: pwd });
    AUTH.enteredPwd = pwd;
    $('#lockPwd').value = '';
    await finishUnlock(r, 'password');
  } catch (e) {
    // 旧进程（页面新、API 旧）：/api/auth/* 不存在 → 404「未知端点」，锁死前先讲清楚
    $('#lockErr').textContent = /未知端点/.test(e.message)
      ? '页面已更新但配置页进程是旧版本：请重启桥接器（lcb start）后刷新本页'
      : e.message;
    const card = $('#lockCard');
    card.classList.remove('shake');
    void card.offsetWidth; // 重启动画
    card.classList.add('shake');
  } finally {
    btn.disabled = false;
    $('#lockPwd').focus();
  }
}

/** 修改密码弹窗（guided=true：仍为默认密码时的登录引导；当前密码用本次解锁所输的 123456） */
export function openPwdModal(guided) {
  openModal({
    title: guided ? '安全提示：请修改默认密码' : '修改配置页密码',
    width: 'min(440px,92vw)',
    closeOnMask: !guided,
    bodyHtml: `
      ${guided ? '<div class="banner warn" style="margin-bottom:12px"><span>当前仍在使用默认密码 <b>123456</b>。同一内网的其他人可能通过「你的内网 IP + 端口」直接打开配置页查看信息，请立即修改密码。</span></div>' : ''}
      ${guided ? '' : '<label class="fld">当前密码</label><input type="password" id="pwOld" autocomplete="off">'}
      <label class="fld">新密码（≥6 位，不能是 123456）</label><input type="password" id="pwNew" autocomplete="off">
      <label class="fld">确认新密码</label><input type="password" id="pwNew2" autocomplete="off">
      <div class="lock-err" id="pwErr" style="margin-top:6px"></div>
      <div class="mini-note">密码用于保护本机配置页（含会话页）。服务端只保存加盐哈希（webauth.json），不存明文；修改后其他已打开的配置页需重新输入密码。</div>`,
    footHtml: `${guided ? '<button class="btn" id="pwSkip">暂不修改</button>' : ''}<span class="sp"></span><button class="btn primary" id="pwOk">确认修改</button>`,
  });
  const sk = $('#pwSkip');
  if (sk) sk.onclick = () => { closeModal(); toast('已跳过。下次仍用默认密码进入时会再次提醒', true); };
  $('#pwOk').onclick = async () => {
    const oldv = guided ? AUTH.enteredPwd : ($('#pwOld')?.value ?? '');
    const n1 = $('#pwNew').value;
    const n2 = $('#pwNew2').value;
    const err = $('#pwErr');
    const bad = (m) => { err.textContent = m; };
    if (!guided && !oldv) return bad('请输入当前密码');
    if (n1.length < 6) return bad('新密码至少 6 位');
    if (n1 === '123456') return bad('新密码不能是默认密码 123456');
    if (n1 !== n2) return bad('两次输入的新密码不一致');
    try {
      await api('POST', '/api/auth/change', { old: oldv, next: n1 });
      closeModal();
      AUTH.isDefault = false;
      toast('✅ 密码已修改，下次登录请使用新密码');
    } catch (e) { bad(e.message); }
  };
  (guided ? $('#pwNew') : $('#pwOld'))?.focus();
}

/** 恢复初始密码 123456：验当前密码后重置（防止锁屏状态下被内网他人一键重置） */
function openResetModal() {
  openModal({
    title: '恢复初始密码',
    width: 'min(420px,92vw)',
    bodyHtml: `
      <div class="banner warn" style="margin-bottom:12px"><span>恢复后配置页密码回到初始密码 <b>123456</b>，下次登录会再次引导修改；其他已打开的配置页将被登出。</span></div>
      <label class="fld">当前密码</label><input type="password" id="pwRsOld" autocomplete="off">
      <div class="lock-err" id="pwRsErr" style="margin-top:6px"></div>
      <div class="mini-note">忘记当前密码？在本机终端执行 <code>lcb reset-password</code> 可免密恢复。</div>`,
    footHtml: `<span class="sp"></span><button class="btn" id="pwRsCancel">取消</button><button class="btn primary" id="pwRsOk">恢复初始密码</button>`,
  });
  $('#pwRsCancel').onclick = closeModal;
  $('#pwRsOk').onclick = async () => {
    try {
      await api('POST', '/api/auth/reset-default', { old: $('#pwRsOld').value });
      closeModal();
      AUTH.isDefault = true;
      toast('✅ 已恢复初始密码 123456，下次登录将引导修改');
    } catch (e) { $('#pwRsErr').textContent = e.message; }
  };
  $('#pwRsOld').focus();
}

/** 设置弹窗（顶栏右上角 ⚙）：配置页密码 + 自动锁屏时长 */
export async function openSettingsModal() {
  let meta;
  try {
    meta = await api('GET', '/api/auth/meta');
  } catch (e) { toast(e.message, true); return; }
  AUTH.isDefault = !!meta.isDefault;
  AUTH.lockMinutes = Number(meta.lockMinutes);
  const opts = [[30, '30 分钟'], [60, '1 小时'], [240, '4 小时'], [1440, '24 小时'], [1800, '30 小时'], [0, '永不']];
  openModal({
    title: '设置',
    width: 'min(460px,92vw)',
    bodyHtml: `
      <div class="sub-title">配置页密码</div>
      <div class="mut" style="font-size:12px;margin-bottom:10px">防止同一内网其他用户通过「IP + 端口」查看你的配置信息；每次进入配置页都需要输入密码${AUTH.isDefault ? '。<b style="color:var(--warn-tx)">当前仍为默认密码 123456，建议立即修改。</b>' : '。'}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="stPwd">${svg(IC_KEY, 13)} 修改密码</button>
        <button class="btn" id="stReset">${svg(IC_ROTATE, 13)} 恢复初始密码</button>
      </div>
      <div class="mini-note" style="margin-top:8px">忘记密码时，也可在运行 LCB 的机器上执行 <code>lcb reset-password</code> 免密恢复初始密码 123456。</div>
      <hr>
      <div class="sub-title" style="margin-top:4px">自动锁屏</div>
      <label class="fld">长时间无操作后锁屏（再次使用需输入密码）</label>
      <select id="stMins">${opts.map(([v, l]) => `<option value="${v}" ${AUTH.lockMinutes === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="mini-note" style="margin-top:8px">当前设定：${AUTH.lockMinutes ? `无操作 ${minsText(AUTH.lockMinutes)} 后自动锁屏` : '不自动锁屏'}。也可点顶栏 🔒 立即锁屏体验。</div>`,
    footHtml: `<span class="sp"></span><button class="btn" id="stCancel">关闭</button><button class="btn primary" id="stSave">保存</button>`,
  });
  $('#stCancel').onclick = closeModal;
  $('#stPwd').onclick = () => openPwdModal(false);
  $('#stReset').onclick = async () => {
    if (await confirmDialog({ title: '恢复初始密码', message: '确认把配置页密码恢复为初始密码 123456？\n恢复后下次登录会引导你重新设置。', danger: true, confirmText: '继续' })) openResetModal();
  };
  $('#stSave').onclick = async () => {
    const v = Number($('#stMins').value);
    try {
      await api('PUT', '/api/auth/settings', { lockMinutes: v });
      AUTH.lockMinutes = v;
      beatActivity(true); // 改完设置重置计时（force 越过节流，全标签页同步）
      closeModal();
      toast(v ? `✅ 已设置：无操作 ${minsText(v)} 后自动锁屏` : '✅ 已关闭自动锁屏');
    } catch (e) { toast(e.message, true); }
  };
}

/** main.js 启动时调用一次：绑锁屏交互 + 无操作看门狗 + 会话恢复（免密） */
export function initAuth({ onUnlock }) {
  onUnlockCb = onUnlock || null;
  $('#lockUnlock').onclick = () => void tryUnlock();
  $('#lockPwd').onkeydown = (e) => { if (e.key === 'Enter') void tryUnlock(); };
  $('#lockPwd').oninput = () => { $('#lockErr').textContent = ''; };
  $('#settingsBtn').innerHTML = svg(IC_SETTINGS);
  $('#lockBtn').innerHTML = svg(IC_LOCK, 14);
  $('#settingsBtn').onclick = () => void openSettingsModal();
  $('#lockBtn').onclick = () => { lockPage(); toast('已锁定，输入密码可重新进入'); };
  // 无操作看门狗：任意交互先判超时（超时即锁屏，且本次不记活跃），否则记一次全局活跃。
  // 「先判后记」是关键：睡眠/后台标签页节流期间 tick 停摆，回来第一个交互必须先补一次判定
  ['mousemove', 'keydown', 'click', 'wheel', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, () => { if (!checkIdle()) beatActivity(); }, { passive: true }));
  // API 活动也计入「使用」：页面自动轮询/数据自动刷新（概览 5s、设备 2s 等）说明用户正盯着
  // 页面工作——只认鼠标键盘会误伤「看板模式」（放着看进度 30 分钟即被锁，主人 2026-11-01 反馈）。
  // 此语义与服务端滑动续期（任何 /api/* 都续会话）完全一致，双端不再有「会话还活着、页面却锁了」
  // 的错位。代价：人走开但轮询页挂着时锁屏不触发——手动 🔒 与「永不」档位仍在，且内网他人
  // 新开页面仍要密码（主威胁模型不变）。仅本页已解锁时记：锁屏中的 401/重试不算活跃
  hooks.onApiActivity = () => { if (AUTH.unlocked) beatActivity(); };
  // 切回标签页 / 窗口聚焦时立即判定：不等被浏览器节流的 tick（后台页定时器可迟至 1 次/分钟）
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkIdle(); });
  window.addEventListener('focus', checkIdle);
  // 兜底联动：解锁状态下任何 API 401（会话已过期/被吊销）→ 立即拉回锁屏遮罩，
  // 杜绝「页面正常显示但点菜单/切 tab 全部 401 无数据」的僵尸态。
  // 锁屏上「密码错误」的 401 因 AUTH.unlocked=false 天然跳过，互不干扰
  hooks.onAuthExpired = () => {
    if (!AUTH.unlocked) return;
    lockPage();
    toast('会话已过期，请重新输入密码', true);
  };
  setInterval(checkIdle, 30000); // 兜底轮询（与服务端会话 TTL 同步过期）；主判定已前置到交互/回前台时刻
  // 先盖锁屏（防内容闪烁），再静默恢复会话：服务端会话有效（未超时/未锁屏吊销）→ 直接进入免密；
  // 无效（首次 / 自动锁屏后 / 手动锁屏后）→ 留在锁屏等输入。锁屏遮罩先出后撤，闪屏可忽略
  lockPage();
  void (async () => {
    try {
      const meta = await api('GET', '/api/auth/meta');
      await finishUnlock(meta, 'session');
    } catch { /* 无会话：留在锁屏（正常路径） */ }
  })();
}
