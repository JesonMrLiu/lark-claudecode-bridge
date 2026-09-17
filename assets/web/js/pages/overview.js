// ============ 概览 ============
// 桥接器启停 / 版本更新（宿主进程管理：embedded 页面随进程生死，独立页面经 PID 跨进程操作）
import { S, $, esc, toast, api, refresh } from '../core.js';
import { bindDialogKeys, confirmDialog, mountDialog, progressDialog } from '../ui.js';
import { openLarkCliDeviceDialog } from './larkcli-device.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UPD = { checkedAt: 0, data: null };
const LARKCLI = { checkedAt: 0, data: null }; // 飞书官方 CLI 状态缓存（30s 节流，同 UPD）

function showMask(inner) {
  let m = $('#brMask');
  if (!m) {
    m = document.createElement('div');
    m.id = 'brMask'; m.className = 'br-mask';
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="br-mask-card">${inner}</div>`;
  m.style.display = 'flex';
}
function hideMask() { const m = $('#brMask'); if (m) m.style.display = 'none'; }

/** 启停请求的容错：embedded 停止/重启时进程退出可能先于响应到达，网络断开视为已受理 */
async function bridgeActionSafe(op) {
  try { return await api('POST', '/api/bridge/action', { op }); }
  catch (e) {
    if (/fetch|network|load failed/i.test(e.message)) return { ok: true, message: '已提交（连接关闭属预期）' };
    throw e;
  }
}

/** 等配置页服务恢复（重启轮询）：连续两次成功才确认，排除旧进程残影 */
async function waitServerBack(timeoutMs = 45000) {
  const t0 = Date.now();
  await sleep(2500); // 留给旧进程退场：立刻探测可能命中尚未退出的旧 server
  while (Date.now() - t0 < timeoutMs) {
    try {
      await api('GET', '/api/status');
      await sleep(1000);
      await api('GET', '/api/status');
      return;
    } catch {}
    await sleep(1500);
  }
  throw new Error('重启超时：请手动刷新页面查看状态');
}

async function startFlow() {
  try {
    const r = await bridgeActionSafe('start');
    toast(r.message || '✅ 已在后台启动');
    setTimeout(() => refresh(), 2500); // 后台进程写 PID / 起长连接需数秒
    setTimeout(() => refresh(), 7000);
  } catch (e) { toast(e.message, true); }
}

async function stopFlow() {
  const embedded = !!S.status?.embedded;
  const msg = embedded
    ? '停止后本配置页将随桥接器进程一同关闭。\n之后可运行 lcb ui 重开配置页（并在其中重新启动桥接器）。'
    : '停止后机器人将不再响应消息。';
  if (!(await confirmDialog({ title: '停止桥接器', message: msg, danger: true, confirmText: '停止' }))) return;
  try {
    const r = await bridgeActionSafe('stop');
    if (embedded) {
      toast(r.message || '正在停止…');
      await sleep(2500);
      try { await api('GET', '/api/status'); await refresh(); } // 进程仍在（异常场景）：正常刷新
      catch { showMask('<b>桥接器已停止</b><div class="hint" style="margin-top:8px">本配置页已随进程离线。重新打开请运行 lcb ui；启动桥接器请运行 lcb start。</div>'); }
    } else {
      toast(r.message || '已发送停止信号');
      setTimeout(() => refresh(), 1500); // 硬终止无 PID 清理：陈旧文件由探活兜底删除
      setTimeout(() => refresh(), 4000);
    }
  } catch (e) { toast(e.message, true); }
}

async function restartFlow() {
  if (S.status?.embedded) {
    showMask('<div class="br-spin"></div>正在重启桥接器，页面将自动恢复…');
    try { await bridgeActionSafe('restart'); } catch (e) { hideMask(); toast(e.message, true); return; }
    try { await waitServerBack(); hideMask(); toast('✅ 桥接器已重启'); await refresh(); }
    catch (e) { hideMask(); toast(e.message, true); }
  } else {
    try { const r = await bridgeActionSafe('restart'); toast(r.message || '正在重启…'); }
    catch (e) { toast(e.message, true); return; }
    setTimeout(() => refresh(), 4000);
    setTimeout(() => refresh(), 10000);
  }
}

function renderUpdateResult() {
  const el = $('#updLatest');
  const r = UPD.data;
  if (!el) return;
  if (!r) { el.innerHTML = '<span class="hint">未检查</span>'; return; }
  el.innerHTML = r.hasUpdate
    ? `<span class="tag warn">有新版本</span> <span class="chip">v${esc(r.latest)}</span>`
    : `<span class="tag ok">已是最新</span> <span class="chip">v${esc(r.latest)}</span>`;
  const area = $('#updArea');
  if (!area) return;
  if (r.hasUpdate && r.mode === 'global') {
    area.innerHTML = '<button class="btn primary" id="btnUpdRun">一键更新</button>';
    $('#btnUpdRun').onclick = runUpdateFlow;
  } else if (r.hasUpdate) {
    area.innerHTML = '<span class="hint">当前非 npm 全局安装运行，请手动更新</span>';
  } else area.innerHTML = '';
}

async function doCheckUpdate() {
  const el = $('#updLatest'); if (!el) return;
  el.innerHTML = '<span class="hint">检查中…</span>';
  try {
    UPD.data = await api('GET', '/api/update/check');
    UPD.checkedAt = Date.now();
    renderUpdateResult();
  } catch (e) {
    el.innerHTML = `<span class="hint">检查失败：${esc(e.message)}</span>`;
  }
}

async function runUpdateFlow() {
  const running = S.status?.embedded || S.status?.bridge?.running;
  const extra = running ? '，完成后自动重启桥接器（页面将短暂失联后自动恢复）' : '（桥接器未在运行，下次启动生效）';
  if (!(await confirmDialog({ title: '一键更新', message: `将通过 npm 安装桥接器最新版本${extra}，可能需要 1-2 分钟。`, confirmText: '开始更新' }))) return;
  const btn = $('#btnUpdRun');
  if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }
  try {
    // 只更新桥接器自身：飞书 CLI 的更新在它自己那一行点「更新」，两条更新各自独立
    await api('POST', '/api/update/run');
    UPD.checkedAt = 0; LARKCLI.checkedAt = 0;
    if (running) await restartFlow();
    else toast('✅ 更新完成，下次启动生效');
    await refresh();
  } catch (e) {
    toast(`更新失败：${e.message}`, true);
    renderUpdateResult(); // 恢复按钮
  }
}

/** 纯函数（可测）：与后端 needsLarkCliConfig 同源——detail 含 not_configured 即「未配置应用」 */
function larkCliNotConfigured(r) {
  return r?.auth?.state === 'unauthorized' && /not_configured/i.test(r?.auth?.detail || '');
}

/** 纯函数（可测）：概览表格行里「飞书 CLI」的状态 HTML（不含操作按钮，按钮由 render 按需挂） */
export function larkCliStatHtml(r) {
  if (!r) return '<span class="hint">未检查</span>';
  if (!r.installed) return '<span class="tag off">未安装</span>';
  // authorized 之外一律呈现为「未授权」（含探测不出的 unknown）：UI 不留没有出口的状态，
  // 两种情况都能点授权按钮。detail 悬浮可见（unknown 现已带诊断线索），便于自查。
  const authTag = r.auth?.state === 'authorized'
    ? '<span class="tag ok">已授权</span>'
    : `<span class="tag warn"${r.auth?.detail ? ` title="${esc(r.auth.detail)}"` : ''}>未授权</span>`;
  // skill 字段为旧后端所无（undefined 时不显示），与 auth 解耦展示
  const skillTag = r.skill
    ? (r.skill.installed ? '<span class="tag ok">SKILL</span>' : '<span class="tag warn">SKILL 未装</span>')
    : '';
  return `<span class="tag ok">已安装</span> <span class="chip">${r.version ? `v${esc(r.version)}` : '版本未知'}</span>`
    + (r.hasUpdate ? ' <span class="tag warn">有新版本</span>' : '')
    + (skillTag ? ` ${skillTag}` : '')
    + ` ${authTag}`;
}

/**
 * 扫码授权弹窗（授权主路径）。弹窗里的「改用终端窗口」接回既有终端链路——
 * 那条路一行没改，仍是拉不起无桌面环境时的兜底，也保留了在终端里补跑命令的能力。
 */
function openDeviceDialog() {
  openLarkCliDeviceDialog({
    wasAuthorized: LARKCLI.data?.auth?.state === 'authorized',
    // 未配置应用时 device flow 必然被后端挡下（「请先点配置应用」）：把这个前置条件
    // 交给弹窗直接讲明白，而不是让用户点一次、收一个红色的失败
    notConfigured: larkCliNotConfigured(LARKCLI.data),
    onChange: (r) => { LARKCLI.data = r; LARKCLI.checkedAt = Date.now(); renderLarkCliResult(); },
    onTerminal: () => void larkCliActionFlow('auth'),
    onConfig: () => void larkCliActionFlow('config'),
  });
}

function renderLarkCliResult() {
  const el = $('#larkCliStat');
  const r = LARKCLI.data;
  if (!el) return;
  el.innerHTML = `${larkCliStatHtml(r)} <span id="larkCliArea"></span>`;
  const area = $('#larkCliArea');
  if (!area || !r) return;
  const add = (label, op) => {
    const b = document.createElement('button');
    b.className = 'btn sm';
    b.textContent = label;
    b.onclick = () => (op === 'auth-device' ? openDeviceDialog() : larkCliActionFlow(op));
    area.appendChild(b);
    area.appendChild(document.createTextNode(' '));
  };
  if (!r.installed) { add('安装', 'install'); return; }
  if (r.hasUpdate) add('更新', 'update');
  // 授权入口常驻，且已授权也给（token 会过期，随时可重走一遍 device flow 刷新）。
  // 授权走**页面内二维码**（主路径，无桌面环境同样可用）；终端窗口降级为弹窗里的备选。
  // 应用未配置（not_configured）时**不在这里换按钮**——那会把唯一的授权入口顶掉，
  // 用户看到「配置应用」只会更困惑「那我怎么授权」。改由弹窗先讲清「得先配应用」
  // 并给出向导入口（见 openDeviceDialog 与 larkcli-device.js）。
  if (r.auth?.state === 'authorized') add('重新授权', 'auth-device');
  else add('扫码授权', 'auth-device');
  if (r.skill && !r.skill.installed) add('装 SKILL', 'skill');
}

async function doCheckLarkCli() {
  const el = $('#larkCliStat'); if (!el) return;
  el.innerHTML = '<span class="hint">检测中…</span>';
  try {
    LARKCLI.data = await api('GET', '/api/lark-cli?check=1');
    LARKCLI.checkedAt = Date.now();
    renderLarkCliResult();
  } catch (e) {
    el.innerHTML = `<span class="hint">检测失败：${esc(e.message)}</span>`;
  }
}

/**
 * 终端已拉起后的提示弹窗：终端是 detached 的独立进程，这里的「检测」「关闭」
 * 都只作用于本弹窗，不影响终端里的安装/授权。
 */
function openLarkCliTerminalDialog(op) {
  const taskLabel = op === 'auth' ? '授权' : op === 'config' ? '配置应用' : '安装 / 更新';
  const { mask, unmount } = mountDialog(`
    <div class="modal dlg" role="dialog" aria-modal="true" style="width:min(600px,94vw)">
      <h3 class="dlg-title">飞书 CLI ${taskLabel}</h3>
      <div class="dlg-msg">已拉起<b>终端窗口</b>执行命令，请按窗口里的提示完成${op === 'auth' ? '授权' : op === 'config' ? '应用配置（在浏览器完成创建后终端会自动继续）' : '安装与配置、授权'}。</div>
      <div class="hint" style="margin-top:10px">关闭本弹窗<b>不会中断</b>终端里的进程；终端还在跑时请不要关掉它。</div>
      <div id="lktStat" style="margin-top:12px"><span class="hint">检测中…</span></div>
      <div class="dlg-foot">
        <button class="btn" data-lkt="auth" hidden>去终端授权</button>
        <button class="btn" data-lkt="check">检测</button>
        <button class="btn primary" data-lkt="close">关闭</button>
      </div>
    </div>`);
  const statEl = mask.querySelector('#lktStat');
  const authBtn = mask.querySelector('[data-lkt="auth"]');
  const POLL_MS = 5000;
  const POLL_MAX = 120; // 约 10 分钟：安装 + 走完 device flow 通常远快于此
  let timer = null;
  let polls = 0;
  let busy = false;    // 去重：手动「检测」与自动轮询不叠加
  let stopped = false;
  // 打开弹窗时是否已授权（快照）：重新授权场景靠它区分「本来就好」与「刚跑完」
  const wasAuthorized = LARKCLI.data?.auth?.state === 'authorized';

  const stop = (note) => {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (note) statEl.insertAdjacentHTML('beforeend', `<div class="hint" style="margin-top:6px">${note}</div>`);
  };

  const paint = (r) => {
    const auth = r.auth?.state;
    const tag = !r.installed ? '<span class="tag off">未安装</span>'
      : `<span class="tag ok">已安装</span> <span class="chip">${r.version ? `v${esc(r.version)}` : '版本未知'}</span> `
        + (auth === 'authorized' ? '<span class="tag ok">已授权</span>' : '<span class="tag warn">未授权</span>');
    statEl.innerHTML = tag + (stopped ? '' : ` <span class="hint">（每 ${POLL_MS / 1000} 秒自动检测一次）</span>`);
    // 已安装即给授权入口：未授权可去授权，已授权可重新授权
    authBtn.hidden = !r.installed;
    authBtn.textContent = auth === 'authorized' ? '重新授权' : '去终端授权';
  };

  const refreshBoth = (r) => {
    LARKCLI.data = r;
    LARKCLI.checkedAt = Date.now();
    renderLarkCliResult();
    paint(r);
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // 不带 check=1：纯本地探测（detect + auth status），轮询绝不能把 npm registry 打爆
      refreshBoth(await api('GET', '/api/lark-cli'));
      polls++;
      const ok = LARKCLI.data?.installed && LARKCLI.data?.auth?.state === 'authorized';
      // 重新授权场景（打开弹窗时就已授权）不能一进来就判「完成」——终端的 device flow 还没跑完，
      // 此时只持续刷新状态，由用户看终端结果后自行关闭。
      if (ok && !wasAuthorized) {
        stop(op === 'auth' ? '✅ 授权完成，可以关闭本弹窗了。' : '✅ 安装并授权完成，可以关闭本弹窗了。');
      } else if (polls >= POLL_MAX) {
        stop(ok ? '本次自动检测到此为止，终端流程应已完成。' : '自动检测已停止（超时），可点「检测」手动刷新。');
      }
    } catch {
      // 静默重试：一键更新会重启桥接器，轮询撞上失联窗口属预期，弹错反而吓人
    } finally { busy = false; }
  };

  const doCheck = async () => {
    if (busy) return;
    busy = true;
    statEl.innerHTML = '<span class="hint">检测中…</span>';
    try {
      refreshBoth(await api('GET', '/api/lark-cli'));
    } catch (e) {
      statEl.innerHTML = `<span class="hint">检测失败：${esc(e.message)}</span>`;
    } finally { busy = false; }
  };

  const close = () => {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    unbind();
    unmount();
  };
  const unbind = bindDialogKeys((k) => { if (k === 'Escape') close(); });
  mask.querySelector('[data-lkt="close"]').onclick = close;
  mask.querySelector('[data-lkt="check"]').onclick = () => void doCheck();
  authBtn.onclick = () => { close(); void larkCliActionFlow('auth'); };
  mask.onclick = (e) => { if (e.target === mask) close(); };
  timer = setInterval(tick, POLL_MS);
  void tick(); // 立即给一次现状：安装 / 配置流程下可直接看到「完成」并停止轮询
}

async function larkCliActionFlow(op = 'install') {
  const meta = {
    install: {
      what: '安装',
      msg: '将打开一个终端窗口依次执行：<code>npm install -g @larksuite/cli</code>、官方 SKILL 安装、'
        + '（未配置应用时）<code>lark-cli config init --new</code> 配置向导、<code>lark-cli auth login</code> 授权登录。'
        + '<br><br>若本机没有可用终端（无桌面 / SSH 会话），会自动降级为后台静默安装。',
    },
    update: {
      what: '更新',
      msg: '将打开一个终端窗口更新 lark-cli 并顺势完成官方 SKILL 安装、（未配置应用时）配置向导与授权登录。'
        + '<br><br>若本机没有可用终端（无桌面 / SSH 会话），会自动降级为后台静默安装。',
    },
    auth: {
      what: '授权登录',
      msg: '将打开一个终端窗口执行 <code>lark-cli auth login --recommend</code>：按窗口里的提示在浏览器或飞书中确认即可。'
        + '<br><br>已授权时也可重跑（用于刷新授权、补勾选新权限）。'
        + '<br><br>若本机没有可用终端（无桌面 / SSH 会话），需在服务器上手动执行该命令。',
    },
    config: {
      what: '配置应用',
      msg: '将打开一个终端窗口执行 <code>lark-cli config init --new</code>：按窗口打印的链接在浏览器完成飞书应用创建，'
        + '完成后会自动进入授权登录。'
        + '<br><br>若本机没有可用终端（无桌面 / SSH 会话），需在服务器上手动执行该命令。',
    },
    skill: {
      what: 'SKILL 安装',
      msg: '将后台执行 <code>npx skills add https://open.feishu.cn</code> 安装飞书官方 SKILL（教 AI 工具怎么用 lark-cli）。'
        + '<br><br>安装完成后需<b>重启桥接器</b>，飞书会话才能看到该 SKILL。',
    },
  };
  const { what, msg } = meta[op] || meta.install;
  if (!(await confirmDialog({ title: `飞书 CLI ${what}`, message: msg, confirmText: '开始' }))) return;
  const rowBtn = $('#larkCliArea button');
  if (rowBtn) rowBtn.disabled = true;
  // 先弹进度框再发请求：静默降级那条路最长 5 分钟，没有它页面会静默无反馈
  const dlg = progressDialog({
    title: `飞书 CLI ${what}`,
    note: op === 'skill' ? '正在安装 SKILL…' : '正在探测可用终端…',
    reportMaxHeight: op === 'skill' ? 360 : 220, // SKILL 要列 28 条名单，默认 220px 只够十来行
  });
  try {
    const r = await api('POST', '/api/lark-cli/action', { op });
    if (r.mode === 'terminal') {
      dlg.unmount(); // 交给终端弹窗，两者不叠加
      openLarkCliTerminalDialog(op);
      toast('已拉起终端窗口，请在终端里完成操作');
    } else {
      // SKILL 装完展示扫盘得到的名单，而不是 npx 那段带 ANSI 的进度表原文
      // （名单由后端 listLarkCliSkills 扫 ~/.claude/skills 得出，比解析输出可靠）
      if (op === 'skill' && Array.isArray(r.skills) && r.skills.length) {
        dlg.setNote(`已同步 ${r.skills.length} 个 SKILL\n\n`
          + r.skills.map((s) => `• ${s}`).join('\n'));
      } else {
        dlg.setNote(String(r.output || '').trim().slice(-600) || '完成');
      }
      if (r.reason) dlg.appendLog(`⚠️ 未使用终端：${r.reason}`);
      const done = op === 'skill' ? '✅ SKILL 安装完成，重启桥接器后飞书会话可见' : `✅ 飞书 CLI ${what}完成`;
      dlg.finish(true, done);
      dlg.onClose(() => { void refresh(); });
      toast(done);
    }
    await doCheckLarkCli();
  } catch (e) {
    dlg.appendLog(`❌ ${e.message}`);
    dlg.finish(false, `❌ 飞书 CLI ${what}失败`);
    dlg.onClose(() => renderLarkCliResult());
  } finally {
    if (rowBtn) rowBtn.disabled = false;
  }
}

export const page = {
  id: 'overview',
  title: '概览',
  icon: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  async render(el) {
    const st = S.status || {};
    const claudeTag = st.claude?.hasAuth === null ? '<span class="tag off">未知</span>'
      : st.claude?.hasAuth ? '<span class="tag ok">已就绪</span>' : '<span class="tag err">未认证</span>';
    const stale = !st.bridge; // 旧版本进程（API 无 bridge 字段）：进程托管功能整体不可用
    const br = stale ? { running: st.embedded === true, pid: null, spawnable: false } : st.bridge;
    const ctl = stale
      ? '<div class="hint" style="margin-top:10px">⚠️ 配置页服务进程为旧版本，页面启停 / 重启 / 更新不可用：请重启桥接器（lcb start）后刷新本页。</div>'
      : br.spawnable === false
      ? '<div class="hint" style="margin-top:10px">当前运行方式不支持页面托管启停（如源码运行），请在服务器上手动运行 lcb start。</div>'
      : `<div style="display:flex; gap:10px; margin-top:12px">${
          br.running
            ? '<button class="btn" id="btnBrRestart">重启</button><button class="btn danger" id="btnBrStop">停止</button>'
            : '<button class="btn primary" id="btnBrStart">启动</button>'
        }</div>
        <div class="hint" style="margin-top:8px">${st.embedded
          ? '本页随桥接器进程运行：停止后页面将离线（可运行 lcb ui 重开）；重启会短暂失联后自动恢复。'
          : '本页独立运行（lcb ui）：在此启动的桥接器为后台进程，运行日志见 ~/.lark-claudecode-bridge/bridge.log。'}</div>`;
    el.innerHTML = `
    <div class="card">
      <h3>运行状态</h3>
      <table>
        <tr><td>版本</td><td>v${esc(st.version)}</td></tr>
        <tr><td>模式</td><td>${st.embedded ? '随 lcb start 常驻' : 'lcb ui 独立（桥接器未随本页启动）'}</td></tr>
        <tr><td>桥接器进程</td><td>${stale
          ? (st.embedded ? '<span class="tag warn">运行中（旧版本进程）</span>' : '<span class="tag off">状态未知（旧版本进程）</span>')
          : br.running
            ? `<span class="tag ok">运行中</span> <span class="hint">PID ${esc(br.pid)}</span>`
            : '<span class="tag off">未运行</span>'}</td></tr>
        <tr><td>配置文件</td><td><code>${esc(st.configPath)}</code></td></tr>
        <tr><td>配置页</td><td><code>${esc(location.host)}</code></td></tr>
        <tr><td>Claude 认证</td><td>${claudeTag}（模式：${esc(st.claude?.mode || 'inherit')}）</td></tr>
      </table>
      ${ctl}
      <div class="desc" style="margin-top:10px">${st.claude?.hasAuth === false ? '⚠️ 未检测到认证：到「Claude 认证」页填写，或在配置页所在机器执行 claude login。' : ''}</div>
    </div>
    <div class="card">
      <h3>版本与更新</h3>
      <table>
        <tr><td>当前版本</td><td><span class="chip">v${esc(st.version)}</span></td></tr>
        <tr><td>最新版本</td><td id="updLatest"><span class="hint">未检查</span></td></tr>
        <tr><td>飞书 CLI（lark-cli）</td><td id="larkCliStat"><span class="hint">检测中…</span></td></tr>
      </table>
      <div style="display:flex; gap:10px; margin-top:12px; align-items:center">
        <button class="btn" id="btnUpdCheck">检查更新</button>
        <span id="updArea"></span>
      </div>
    </div>
    <div class="card">
      <h3>机器人应用</h3>
      <table><thead><tr><th>名称</th><th>App ID</th><th>状态</th></tr></thead><tbody>
      ${(st.apps || []).map((a) => `<tr><td>${esc(a.name)}</td><td><code>${esc(a.appId)}</code></td><td>${
        a.started === true ? '<span class="tag ok">运行中</span>' : a.started === false ? '<span class="tag err">启动失败</span>' : '<span class="tag off">未随本页启动</span>'
      }</td></tr>`).join('') || '<tr><td colspan="3" class="hint">无</td></tr>'}
      </tbody></table>
    </div>
    <div class="card">
      <h3>常用命令</h3>
      <div class="desc">在飞书聊天框输入 <code>/</code> 触发；其它 / 开头消息原文透传给 Claude Code。斜杠面板需先到「斜杠命令」页注册（补齐内置命令）。</div>
      <table><thead><tr><th style="width:150px">命令</th><th>说明</th></tr></thead><tbody>
      ${(st.commands || []).map((c) => `<tr><td><code>/${esc(c.command)}</code></td><td>${esc(c.description)}</td></tr>`).join('') || '<tr><td colspan="2" class="hint">无</td></tr>'}
      </tbody></table>
    </div>
    <div class="card">
      <h3>常用指引</h3>
      <div class="desc">飞书端与机器人对话即可使用；<code>/help</code> 查看全部命令。配置修改后：<b>应用 / 认证 / server 段需重启 lcb start</b>，工作区 / 权限 / 触发词下一条消息自动生效。</div>
    </div>`;
    // 启停按钮 + 版本更新 + 飞书 CLI 状态；自动检查 30s 节流（切回概览 tab 不重复打 npm）
    const bind = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    bind('#btnBrStart', startFlow); bind('#btnBrStop', stopFlow); bind('#btnBrRestart', restartFlow);
    bind('#btnUpdCheck', doCheckUpdate);
    if (UPD.data && Date.now() - UPD.checkedAt < 30000) renderUpdateResult();
    else doCheckUpdate();
    if (LARKCLI.data && Date.now() - LARKCLI.checkedAt < 30000) renderLarkCliResult();
    else doCheckLarkCli();
  },
};
