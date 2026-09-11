// ============ 概览 ============
// 桥接器启停 / 版本更新（宿主进程管理：embedded 页面随进程生死，独立页面经 PID 跨进程操作）
import { S, $, esc, toast, api, refresh } from '../core.js';
import { confirmDialog } from '../ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UPD = { checkedAt: 0, data: null };

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
  if (!(await confirmDialog({ title: '一键更新', message: `将通过 npm 安装最新版本${extra}，可能需要 1-2 分钟。`, confirmText: '开始更新' }))) return;
  const btn = $('#btnUpdRun');
  if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }
  try {
    await api('POST', '/api/update/run');
    UPD.checkedAt = 0;
    if (running) await restartFlow();
    else toast('✅ 更新完成，下次启动生效');
    await refresh();
  } catch (e) {
    toast(`更新失败：${e.message}`, true);
    renderUpdateResult(); // 恢复按钮
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
    // 启停按钮 + 版本更新；自动检查 30s 节流（切回概览 tab 不重复打 npm）
    const bind = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    bind('#btnBrStart', startFlow); bind('#btnBrStop', stopFlow); bind('#btnBrRestart', restartFlow);
    bind('#btnUpdCheck', doCheckUpdate);
    if (UPD.data && Date.now() - UPD.checkedAt < 30000) renderUpdateResult();
    else doCheckUpdate();
  },
};
