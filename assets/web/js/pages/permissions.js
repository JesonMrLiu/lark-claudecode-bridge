// ============ 权限（页内一级 tab：免确认工具 / 危险命令黑名单） ============
import { S, $, esc, toast, saveDoc } from '../core.js';
import { confirmDialog } from '../ui.js';

let permTab = 'allow'; // tab 状态：切换 / 重渲染保持
function renderPermissions(el) {
  const p = S.doc.permissions || (S.doc.permissions = {});
  p.allow_tools = p.allow_tools || [];
  p.dangerous_commands = p.dangerous_commands || [];
  el.innerHTML = `
  <div class="tabs">
    <button data-t="allow" class="${permTab === 'allow' ? 'active' : ''}">免确认工具</button>
    <button data-t="danger" class="${permTab === 'danger' ? 'active' : ''}">危险命令黑名单</button>
  </div>
  <div id="permPanel"></div>`;
  el.querySelectorAll('.tabs button').forEach((b) =>
    b.onclick = () => { permTab = b.dataset.t; renderPermissions(el); });
  const panel = $('#permPanel');
  if (permTab === 'danger') renderDangerTab(panel, p);
  else renderAllowTab(panel, p);
}

function renderAllowTab(panel, p) {
  const defaults = S.status?.permissionDefaults?.allowTools || [];
  const isDefault = defaults.length > 0 && JSON.stringify(p.allow_tools) === JSON.stringify(defaults);
  panel.innerHTML = `
  <div class="card">
    <h3>免确认工具</h3>
    <div class="desc">名单内工具直接放行不弹确认卡（配置即整体替换内置默认）。Bash 仍受危险命令黑名单约束。</div>
    <div class="list-toolbar">
      <input type="text" id="newTool" placeholder="工具名，如 Write" style="max-width:320px">
      <button class="btn" id="addTool">添加</button>
      <button class="btn" id="resetTools" ${defaults.length ? '' : 'disabled title="status 不可用，无法取默认值"'}>恢复默认</button>
    </div>
    ${p.allow_tools.length === 0 ? '<div style="background:var(--warn-bg);color:var(--warn-tx);border-radius:7px;padding:7px 12px;margin:8px 0">⚠️ 名单为空：所有工具（含 Write/Edit）都会弹确认卡</div>' : ''}
    ${isDefault ? '<div class="hint" style="margin:8px 0"><span class="tag off">与内置默认一致</span></div>' : ''}
    <table><tbody id="toolBody"></tbody></table>
    <div class="footer-note">权限改动即时保存并热生效（已有会话的下一个工具调用即用新名单）。plan 模式下写操作仍会经此判定：白名单命中直通，未命中弹确认卡。</div>
  </div>`;
  $('#toolBody').innerHTML = p.allow_tools.map((t, i) =>
    `<tr><td><code>${esc(t)}</code></td><td style="width:80px"><button class="btn sm danger" data-i="${i}">删除</button></td></tr>`).join('')
    || '<tr><td colspan="2" class="hint">（空）</td></tr>';
  // 即时保存：低风险高频操作，免去「改完再点保存」两步；失败回滚内存保持一致
  $('#toolBody').querySelectorAll('button').forEach((b) =>
    b.onclick = async () => {
      const i = Number(b.dataset.i);
      if (!(await confirmDialog({
        title: '移出免确认名单',
        message: `确定将工具 <code>${esc(p.allow_tools[i])}</code> 移出免确认名单？移出后该工具的调用将恢复弹确认卡。`,
        confirmText: '移出',
      }))) return;
      const old = [...p.allow_tools];
      p.allow_tools.splice(i, 1);
      if (!await saveDoc()) p.allow_tools = old;
    });
  $('#addTool').onclick = async () => {
    const v = $('#newTool').value.trim();
    if (!v || p.allow_tools.includes(v)) return;
    p.allow_tools.push(v);
    if (!await saveDoc()) p.allow_tools.splice(p.allow_tools.indexOf(v), 1);
    else if ($('#newTool')) $('#newTool').value = '';
  };
  $('#resetTools').onclick = async () => {
    if (!defaults.length) return;
    if (!(await confirmDialog({
      title: '恢复默认名单',
      message: '恢复为内置默认名单？当前自定义项将被覆盖（立即保存生效）。',
      confirmText: '恢复默认',
    }))) return;
    const old = [...p.allow_tools];
    p.allow_tools = [...defaults];
    if (!await saveDoc()) p.allow_tools = old;
  };
}

function renderDangerTab(panel, p) {
  const defaults = S.status?.permissionDefaults?.dangerousCommands || [];
  const isDefault = defaults.length > 0 && JSON.stringify(p.dangerous_commands) === JSON.stringify(defaults);
  panel.innerHTML = `
  <div class="card">
    <h3>危险命令黑名单</h3>
    <div class="desc">正则源串（不区分大小写），命中即弹确认卡。删除正则 = 放宽对应命令为直通，请谨慎。</div>
    <div class="list-toolbar">
      <input type="text" id="newDc" placeholder="正则源串，如 \\bgit\\s+push\\b.*--force" style="max-width:480px">
      <button class="btn" id="addDc">添加</button>
      <button class="btn" id="resetDc" ${defaults.length ? '' : 'disabled title="status 不可用，无法取默认值"'}>恢复默认</button>
    </div>
    ${p.dangerous_commands.length === 0 ? '<div style="background:var(--err-bg);color:var(--err-tx);border-radius:7px;padding:7px 12px;margin:8px 0">⚠️ 黑名单为空：所有 Bash 命令（含 rm -rf、sudo）将免确认直通，请确认有意为之</div>' : ''}
    ${isDefault ? '<div class="hint" style="margin:8px 0"><span class="tag off">与内置默认一致</span></div>' : ''}
    <table><tbody id="dcBody"></tbody></table>
    <div class="footer-note">权限改动即时保存并热生效（已有会话的下一个工具调用即用新名单）。plan 模式下写操作仍会经此判定：白名单命中直通，未命中弹确认卡。</div>
  </div>`;
  $('#dcBody').innerHTML = p.dangerous_commands.map((s, i) =>
    `<tr><td style="width:90%"><code>${esc(s)}</code></td><td><button class="btn sm danger" data-i="${i}">删除</button></td></tr>`).join('')
    || '<tr><td colspan="2" class="hint">（空）</td></tr>';
  $('#dcBody').querySelectorAll('button').forEach((b) =>
    b.onclick = async () => {
      const i = Number(b.dataset.i);
      if (!(await confirmDialog({
        title: '删除黑名单正则',
        message: `确定删除正则 <code>${esc(p.dangerous_commands[i])}</code>？删除后对应命令将免确认直通，请确认有意为之。`,
        danger: true,
        confirmText: '删除',
      }))) return;
      const old = [...p.dangerous_commands];
      p.dangerous_commands.splice(i, 1);
      if (!await saveDoc()) p.dangerous_commands = old;
    });
  $('#addDc').onclick = async () => {
    const v = $('#newDc').value.trim();
    if (!v) return;
    try { new RegExp(v, 'i'); } catch (e) { return toast(`正则无效：${e.message}`, true); }
    p.dangerous_commands.push(v);
    if (!await saveDoc()) p.dangerous_commands.splice(p.dangerous_commands.indexOf(v), 1);
    else if ($('#newDc')) $('#newDc').value = '';
  };
  $('#resetDc').onclick = async () => {
    if (!defaults.length) return;
    if (!(await confirmDialog({
      title: '恢复默认黑名单',
      message: '恢复为内置默认黑名单？当前自定义项将被覆盖（立即保存生效）。',
      confirmText: '恢复默认',
    }))) return;
    const old = [...p.dangerous_commands];
    p.dangerous_commands = [...defaults];
    if (!await saveDoc()) p.dangerous_commands = old;
  };
}

export const page = {
  id: 'permissions',
  title: '权限',
  icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  render: renderPermissions,
};
