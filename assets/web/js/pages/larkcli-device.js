// ============ 飞书扫码授权（设备流）：页面内二维码弹窗 ============
// 与「拉终端」并列的第二条授权路径——把 lark-cli 的 device flow 搬到配置页里，用户直接
// 扫码完成，不用切窗口。它不经过终端探测，因此无桌面 / SSH 环境同样可用（那条路上
// 「去终端授权」原本是无出口的死路）。
//
// 三段式（后端编排，见 src/lark-cli-manager.ts 的设备流一节）：
//   ① POST /device/start → 拿 verification_url + 二维码（base64 PNG）
//   ② 用户用飞书扫码
//   ③ 后端后台跑 `auth login --device-code` 收尾，前端只轮询零成本的内存态端点
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

/** 纯函数（可测）：终态 → 给用户看的一句话 */
export function deviceStateHint(state, error) {
  if (state === 'done') return '✅ 授权完成，可以关闭本弹窗了。';
  if (state === 'expired') return error || '二维码已过期，请重新生成。';
  if (state === 'failed') return error || '授权未完成，可重新生成二维码再试。';
  // 桥接器重启会冲掉后端的会话内存，但 token 可能已经落盘——提示里要点出这个可能
  if (state === 'none') return '授权会话已失效（桥接器可能已重启），请重新生成二维码。';
  return '';
}

/**
 * 打开扫码授权弹窗。
 * @param {object} opts
 * @param {(r:any)=>void} [opts.onChange]   收到最新 /api/lark-cli 结果时回调，用于同步刷新概览行
 * @param {()=>void}      [opts.onTerminal] 用户选「改用终端窗口」时回调，接回既有终端链路
 * @param {boolean}       [opts.wasAuthorized] 打开时的授权态快照：区分「本来就好」与「本次扫码完成」
 */
export function openLarkCliDeviceDialog({ onChange, onTerminal, wasAuthorized = false } = {}) {
  const { mask, unmount } = mountDialog(`
    <div class="modal dlg" role="dialog" aria-modal="true" style="width:min(520px,94vw)">
      <h3 class="dlg-title">飞书授权（扫码完成）</h3>
      <div class="dlg-msg">用飞书 App 扫描下方二维码，按提示确认授权。授权成功后本页会自动更新。</div>
      <div id="lqdBody"><div class="hint">正在向飞书申请授权二维码…</div></div>
      <div class="dlg-foot">
        <button class="btn" data-lqd="terminal">改用终端窗口</button>
        <button class="btn" data-lqd="copy" hidden>复制链接</button>
        <button class="btn" data-lqd="regen" hidden>重新生成二维码</button>
        <button class="btn primary" data-lqd="close">关闭</button>
      </div>
    </div>`);

  const body = mask.querySelector('#lqdBody');
  const btnCopy = mask.querySelector('[data-lqd="copy"]');
  const btnRegen = mask.querySelector('[data-lqd="regen"]');
  let session = null;   // 最近一次 start 的响应（存链接与二维码）
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

  const paintReady = (s) => {
    const qr = s.qrDataUrl
      ? `<div class="qr-box"><img src="${esc(s.qrDataUrl)}" alt="飞书授权二维码" width="220" height="220"></div>`
      : '<div class="hint" style="margin-top:8px">二维码生成失败，请复制下方链接在飞书中打开。</div>';
    body.innerHTML = qr
      + `<div class="hint" style="margin-top:8px">二维码 <b id="lqdLeft">${fmtRemain(remainNow())}</b> 后失效`
      + (s.userCode ? ` · 授权码 <span class="chip">${esc(s.userCode)}</span>` : '')
      + '</div>'
      + `<div class="hint qr-url">${esc(s.verificationUrl || '')}</div>`;
    btnCopy.hidden = false;
    btnRegen.hidden = false;
  };

  const paintDone = (state, { identity, error } = {}) => {
    const tag = state === 'done' ? 'ok' : 'warn';
    const label = state === 'done' ? '已授权' : state === 'expired' ? '已过期' : '未完成';
    body.innerHTML = `<div><span class="tag ${tag}">${label}</span>`
      + (identity ? ` <span class="chip">${esc(identity)}</span>` : '')
      + '</div>'
      + `<div class="hint" style="margin-top:8px">${esc(deviceStateHint(state, error))}</div>`;
    btnCopy.hidden = true;
    btnRegen.hidden = state === 'done';
  };

  /** 拉一次概览数据同步行内状态（拿不到就算了，别让弹窗崩） */
  const syncRow = async () => {
    if (!onChange) return;
    const cur = await api('GET', '/api/lark-cli').catch(() => null);
    if (cur) onChange(cur);
    return cur;
  };

  const doPoll = async () => {
    if (closed) return;
    let r;
    try {
      r = await api('GET', '/api/lark-cli/device/status');
    } catch {
      return; // 静默重试：桥接器重启时会短暂失联，弹错反而吓人
    }
    if (closed) return;
    if (r.state === 'pending') {
      // 以服务端时间为准校正倒计时基准（每次轮询都对一次表）
      baseLeft = r.expiresInSec ?? remainNow();
      baseAt = Date.now();
      return;
    }
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

  const doStart = async (regenerate) => {
    stopTimers();
    body.innerHTML = '<div class="hint">正在向飞书申请授权二维码…</div>';
    btnCopy.hidden = true;
    btnRegen.hidden = true;
    try {
      session = await api('POST', '/api/lark-cli/device/start', { regenerate: !!regenerate });
    } catch (e) {
      // 后端把「未安装」「应用未配置」等前置问题写成了可照做的文案，直接透出
      body.innerHTML = `<div><span class="tag warn">无法发起</span></div>`
        + `<div class="hint" style="margin-top:8px">${esc(e.message)}</div>`;
      toast(e.message, true);
      return;
    }
    if (closed) return;
    baseLeft = session.expiresInSec ?? 0;
    baseAt = Date.now();
    paintReady(session);
    poll = setInterval(doPoll, POLL_MS);
    tick = setInterval(() => {
      const el = body.querySelector('#lqdLeft');
      if (el) el.textContent = fmtRemain(remainNow());
    }, TICK_MS);
  };

  const close = () => {
    closed = true;
    stopTimers();
    unbind();
    unmount();
  };
  const unbind = bindDialogKeys((k) => { if (k === 'Escape') close(); });

  mask.querySelector('[data-lqd="close"]').onclick = close;
  mask.querySelector('[data-lqd="regen"]').onclick = () => void doStart(true);
  // 关弹窗**不动后端会话**（沿用终端弹窗「关弹窗不中断流程」的既有理念）：
  // 重新打开时 start 不带 regenerate → 后端幂等复用同一个 device code，二维码原样回来
  mask.querySelector('[data-lqd="terminal"]').onclick = () => { close(); onTerminal?.(); };
  btnCopy.onclick = async () => {
    const url = session?.verificationUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast('授权链接已复制');
    } catch {
      toast('复制失败，请手动选中链接复制', true);
    }
  };
  mask.onclick = (e) => { if (e.target === mask) close(); };

  void doStart(false);
  return { close };
}
