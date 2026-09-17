// ============ 飞书配置应用 / 扫码授权：页面内二维码弹窗 ============
// 与「拉终端」并列的第二条路径——把 lark-cli 的 config init 与 device flow 都搬到配置页里，
// 用户直接扫码完成，不用切窗口。它不经过终端探测，因此无桌面 / SSH 环境同样可用
// （那条路上「去终端」原本是无出口的死路）。
//
// 同一个弹窗里两个阶段（phase），因为它们是**一条连续的路**：
//   config：应用还没配置时，先扫码创建/绑定飞书应用（后端 spawn `config init --new` 并
//           从其输出里流式解析授权链接——官方 README 与内置 skill 规定的用法）
//   auth  ：再扫码授权（设备流，三段式见 src/lark-cli-manager.ts 的设备流一节）
// 配置完成后**自动接续**授权，用户不需要关掉弹窗再来一次（后端配置会话置 done 前
// 已用 checkAuth() 复检过「确实配上了」，所以接续时设备流的前置守卫必然放行）。
//
// **device_code 全程只存后端内存，从不下发到浏览器。**
//
// 约束：本模块顶层零 DOM 访问——纯函数要能被单测直接 import（见 tests/web/larkcli-device.test.ts）。
import { esc, toast, api } from '../core.js';
import { bindDialogKeys, mountDialog } from '../ui.js';

const POLL_MS = 2000; // 状态轮询：后端是纯内存查询，零成本（对比终端弹窗的 5s，那是真跑 auth status）
const TICK_MS = 1000; // 倒计时重绘

/** 纯函数（可测）：秒 → mm:ss（负数与脏值都收敛到 00:00） */
export function fmtRemain(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 纯函数（可测）：与后端 needsLarkCliConfig 同源——detail 含 not_configured 即「未配置应用」 */
export function larkNotConfigured(r) {
  return r?.auth?.state === 'unauthorized' && /not_configured/i.test(r?.auth?.detail || '');
}

/** 纯函数（可测）：授权阶段终态 → 给用户看的一句话 */
export function deviceStateHint(state, error) {
  if (state === 'done') return '✅ 授权完成，可以关闭本弹窗了。';
  if (state === 'expired') return error || '二维码已过期，请重新生成。';
  if (state === 'failed') return error || '授权未完成，可重新生成二维码再试。';
  // 桥接器重启会冲掉后端的会话内存，但 token 可能已经落盘——提示里要点出这个可能
  if (state === 'none') return '授权会话已失效（桥接器可能已重启），请重新生成二维码。';
  return '';
}

/** 纯函数（可测）：配置阶段终态 → 给用户看的一句话 */
export function configStateHint(state, error) {
  if (state === 'done') return '✅ 飞书应用已配置，接着申请授权二维码。';
  if (state === 'expired') return error || '配置链接已失效，请重新生成二维码。';
  // 配置这条路每一步都在浏览器里，失败原因多半是「没走完」——把两个出口都点出来
  if (state === 'failed') return error || '配置未完成，可重新生成二维码再试，或改用终端窗口。';
  if (state === 'none') return error || '配置会话已失效（桥接器可能已重启），请重新生成二维码。';
  return '';
}

const STATE_TAG = { done: 'ok', expired: 'warn', failed: 'warn', none: 'warn' };
const STATE_LABEL = {
  config: { done: '已配置', expired: '已过期', failed: '未完成', none: '未完成' },
  auth: { done: '已授权', expired: '已过期', failed: '未完成', none: '未完成' },
};

/**
 * 打开飞书配置 / 扫码授权弹窗。未配置应用时自动进入 config 阶段，配完接续 auth 阶段。
 * @param {object} opts
 * @param {(r:any)=>void} [opts.onChange]   收到最新 /api/lark-cli 结果时回调，用于同步刷新概览行
 * @param {()=>void}      [opts.onTerminal] 授权阶段选「改用终端窗口」时回调
 * @param {()=>void}      [opts.onConfigTerminal] 配置阶段选「改用终端窗口」时回调
 * @param {boolean}       [opts.wasAuthorized] 打开时的授权态快照：区分「本来就好」与「本次扫码完成」
 * @param {boolean}       [opts.notConfigured] 应用未配置（not_configured）：先走 config 阶段
 */
export function openLarkCliDeviceDialog({
  onChange, onTerminal, onConfigTerminal, wasAuthorized = false, notConfigured = false,
} = {}) {
  const { mask, unmount } = mountDialog(`
    <div class="modal dlg" role="dialog" aria-modal="true" style="width:min(520px,94vw)">
      <h3 class="dlg-title" id="lqdTitle">飞书授权（扫码完成）</h3>
      <div class="dlg-msg" id="lqdLead"></div>
      <div id="lqdBody"><div class="hint">正在向飞书申请二维码…</div></div>
      <div class="dlg-foot">
        <button class="btn" data-lqd="terminal">改用终端窗口</button>
        <button class="btn" data-lqd="copy" hidden>复制链接</button>
        <button class="btn" data-lqd="regen" hidden>重新生成二维码</button>
        <button class="btn primary" data-lqd="close">关闭</button>
      </div>
    </div>`);

  const titleEl = mask.querySelector('#lqdTitle');
  const leadEl = mask.querySelector('#lqdLead');
  const body = mask.querySelector('#lqdBody');
  const btnCopy = mask.querySelector('[data-lqd="copy"]');
  const btnRegen = mask.querySelector('[data-lqd="regen"]');
  const btnTerminal = mask.querySelector('[data-lqd="terminal"]');
  const btnClose = mask.querySelector('[data-lqd="close"]');

  // needConfig 必须是可变绑定：配置完成后就地翻掉，doStart 才能接着走授权
  let needConfig = !!notConfigured;
  let phase = needConfig ? 'config' : 'auth';
  let session = null;   // 最近一次 start 的响应（存链接与二维码）
  let painted = {};     // 已画出去的内容：相同内容不重画，免得二维码每隔 2s 闪一下
  let baseLeft = 0;     // 服务端给的剩余秒数
  let baseAt = 0;       // 收到该秒数时的本地时刻
  let poll = null;
  let tick = null;
  let closed = false;

  const stopTimers = () => {
    if (poll) { clearInterval(poll); poll = null; }
    if (tick) { clearInterval(tick); tick = null; }
  };

  // 用「服务端剩余秒 + 本地流逝」的差分量：直接拿服务端绝对时间戳会被浏览器时钟差搞出
  // 一个一打开就已过期的二维码
  const remainNow = () => Math.max(0, baseLeft - (Date.now() - baseAt) / 1000);

  const setLead = (text) => { leadEl.textContent = text; };
  const setTitle = (text) => { titleEl.textContent = text; };

  const hideActions = () => { btnCopy.hidden = true; btnRegen.hidden = true; };

  const paintQr = (s) => {
    const qr = s.qrDataUrl
      ? `<div class="qr-box"><img src="${esc(s.qrDataUrl)}" alt="飞书二维码" width="220" height="220"></div>`
      : '<div class="hint" style="margin-top:8px">二维码生成失败，请复制下方链接在飞书中打开。</div>';
    // 倒计时只在服务端给了有效期时才显示：配置流拿不到有效期，编一个数字只会误导用户
    const life = typeof s.expiresInSec === 'number'
      ? `二维码 <b id="lqdLeft">${fmtRemain(remainNow())}</b> 后失效`
      : '若二维码失效，点「重新生成二维码」即可';
    body.innerHTML = qr
      + `<div class="hint" style="margin-top:8px">${life}`
      + (s.userCode ? ` · 授权码 <span class="chip">${esc(s.userCode)}</span>` : '')
      + '</div>'
      + `<div class="hint qr-url">${esc(s.verificationUrl || '')}</div>`;
    btnCopy.hidden = false;
    btnRegen.hidden = false;
    painted = { url: s.verificationUrl, qr: s.qrDataUrl };
  };

  const paintDone = (state, { identity, error } = {}) => {
    const label = (STATE_LABEL[phase] || STATE_LABEL.auth)[state] || '未完成';
    const hint = phase === 'config' ? configStateHint(state, error) : deviceStateHint(state, error);
    body.innerHTML = `<div><span class="tag ${STATE_TAG[state] || 'warn'}">${label}</span>`
      + (identity ? ` <span class="chip">${esc(identity)}</span>` : '')
      + '</div>'
      + `<div class="hint" style="margin-top:8px">${esc(hint)}</div>`;
    btnCopy.hidden = true;
    btnRegen.hidden = state === 'done';
  };

  /** 后端把前置问题写成了可照做的文案（未安装 / 探测不出 / 已配置），直接透出 */
  const paintFail = (msg) => {
    body.innerHTML = '<div><span class="tag warn">无法发起</span></div>'
      + `<div class="hint" style="margin-top:8px">${esc(msg)}</div>`;
    btnCopy.hidden = true;
    btnRegen.hidden = false; // 给出路：失败也要能重来，不留死胡同
  };

  /** 拉一次概览数据同步行内状态（拿不到就算了，别让弹窗崩） */
  const syncRow = async () => {
    if (!onChange) return null;
    const cur = await api('GET', '/api/lark-cli').catch(() => null);
    if (cur) onChange(cur);
    return cur;
  };

  const startPolling = () => {
    poll = setInterval(doPoll, POLL_MS);
    tick = setInterval(() => {
      const el = body.querySelector('#lqdLeft');
      if (el) el.textContent = fmtRemain(remainNow());
    }, TICK_MS);
  };

  const doPoll = async () => {
    if (closed) return;
    const endpoint = phase === 'config' ? '/api/lark-cli/config/status' : '/api/lark-cli/device/status';
    let r;
    try {
      r = await api('GET', endpoint);
    } catch {
      return; // 静默重试：桥接器重启时会短暂失联，弹错反而吓人
    }
    if (closed) return;
    if (r.state === 'pending') {
      if (phase === 'auth') {
        // 以服务端时间为准校正倒计时基准（每次轮询都对一次表）
        baseLeft = r.expiresInSec ?? remainNow();
        baseAt = Date.now();
        return;
      }
      // 配置流：链接与二维码要等子进程吐出来。start 若没等到就返回了，这里补画
      // （内容没变就不重画——每 2s 重建一次 <img> 会让二维码闪）
      if (r.verificationUrl && (painted.url !== r.verificationUrl || painted.qr !== r.qrDataUrl)) {
        session = { ...(session || {}), ...r };
        paintQr(session);
      }
      return;
    }
    if (phase === 'config') return finishConfigPhase(r);
    stopTimers();
    if (r.state === 'none') {
      // 内存态被冲（桥接器重启），但用户可能已经扫完了：回查授权态兜底，
      // 否则会把一次成功的授权报成失败
      const cur = await syncRow();
      const authed = cur?.auth?.state === 'authorized';
      return paintDone(authed && !wasAuthorized ? 'done' : 'none',
        { identity: cur?.auth?.identity });
    }
    await syncRow();
    paintDone(r.state, { identity: r.identity, error: r.error });
  };

  /**
   * 配置完成 → 同一个弹窗里就地接续授权，兑现「完成后自动接着走授权登录」的承诺。
   * 后端置 done 之前已用 checkAuth() 复检确认应用真的配上了，所以设备流的前置守卫必然放行。
   */
  const continueToAuth = async () => {
    phase = 'auth';
    needConfig = false;
    await syncRow(); // 概览行先翻成「已配置」
    if (closed) return;
    toast('✅ 飞书应用已配置，接着申请授权二维码');
    await startAuth(false);
  };

  const finishConfigPhase = async (r) => {
    stopTimers();
    if (r.state === 'done') return continueToAuth();
    if (r.state === 'none') {
      // 内存态被冲（桥接器重启），但用户可能已经在浏览器里配完了：回查兜底
      const cur = await syncRow();
      if (cur && !larkNotConfigured(cur)) return continueToAuth();
    }
    return paintDone(r.state, { error: r.error });
  };

  const startAuth = async (regenerate) => {
    stopTimers();
    setTitle('飞书授权（扫码完成）');
    setLead('用飞书 App 扫描下方二维码，按提示确认授权。授权成功后本页会自动更新。');
    body.innerHTML = '<div class="hint">正在向飞书申请授权二维码…</div>';
    hideActions();
    try {
      session = await api('POST', '/api/lark-cli/device/start', { regenerate: !!regenerate });
    } catch (e) {
      // 后端把「未安装」「应用未配置」等前置问题写成了可照做的文案，直接透出
      paintFail(e.message);
      return;
    }
    if (closed) return;
    baseLeft = session.expiresInSec ?? 0;
    baseAt = Date.now();
    painted = {};
    paintQr(session);
    startPolling();
  };

  const startConfig = async (regenerate) => {
    stopTimers();
    setTitle('飞书配置（扫码完成）');
    setLead('用飞书 App 扫描下方二维码，按提示创建或绑定飞书应用。'
      + '完成后会自动接着申请授权二维码，不用回到本页重来。');
    body.innerHTML = '<div class="hint">正在向飞书申请配置二维码…</div>';
    hideActions();
    try {
      session = await api('POST', '/api/lark-cli/config/start', { regenerate: !!regenerate });
    } catch (e) {
      // 打开弹窗时的 notConfigured 快照可能已经过期（用户刚在别处配好了，后端据此拒绝）。
      // 回查一次，确实已配置就直接接续授权，而不是把一个已经过时的错误甩给用户。
      const cur = await syncRow();
      if (cur && !larkNotConfigured(cur)) return continueToAuth();
      paintFail(e.message);
      return;
    }
    if (closed) return;
    painted = {};
    if (session.state === 'pending') {
      if (session.verificationUrl) paintQr(session);
      else paintWait(); // 链接要等子进程输出，交给轮询补画
      startPolling();
      return;
    }
    return paintDone(session.state, { error: session.error });
  };

  /** 配置链接还没吐出来时的过渡态（仍然给「重新生成」这条出路，不让人干等） */
  const paintWait = () => {
    body.innerHTML = '<div class="hint">正在向飞书申请配置二维码…（通常几秒内出现）</div>';
    btnCopy.hidden = true;
    btnRegen.hidden = false;
  };

  const doStart = (regenerate) => (phase === 'config' ? startConfig(regenerate) : startAuth(regenerate));

  const close = () => {
    closed = true;
    stopTimers();
    unbind();
    unmount();
  };
  const unbind = bindDialogKeys((k) => { if (k === 'Escape') close(); });

  btnClose.onclick = close;
  btnRegen.onclick = () => void doStart(true);
  // 关弹窗**不动后端会话**（沿用终端弹窗「关弹窗不中断流程」的既有理念）：
  // 重新打开时 start 不带 regenerate → 后端幂等复用同一个会话，二维码原样回来
  btnTerminal.onclick = () => {
    const cb = phase === 'config' ? onConfigTerminal : onTerminal;
    close();
    cb?.();
  };
  btnCopy.onclick = async () => {
    const url = session?.verificationUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制');
    } catch {
      toast('复制失败，请手动选中链接复制', true);
    }
  };
  mask.onclick = (e) => { if (e.target === mask) close(); };

  void doStart(false);
  return { close };
}
