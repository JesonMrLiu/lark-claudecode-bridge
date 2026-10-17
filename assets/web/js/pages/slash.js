// ============ 斜杠命令（远端直操作飞书 API；本页与 config.yaml / 保存按钮无关） ============
import { S, $, esc, toast, api } from '../core.js';
import { openDrawer, closeDrawer, confirmDialog } from '../ui.js';

const IC_INFO = '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M12 12v4"/>';
const svg = (inner, s = 13) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

function renderSlash(el) {
  el.innerHTML = `
  <div class="panel">
    <header class="panel-head"><h3>已注册命令</h3>
      <div class="panel-actions">
        <select id="scApp" style="width:auto;padding:4px 10px;font-size:12.5px"></select>
        <button class="btn sm" id="scReload">刷新</button>
        <button class="btn sm" id="scBuiltins">补齐内置</button>
      </div></header>
    <div class="panel-body">
      <table><thead><tr><th style="width:170px">命令</th><th>描述</th><th style="width:130px">图标</th><th style="width:150px">操作</th></tr></thead>
      <tbody id="scBody"><tr><td colspan="4" style="padding:36px 0"><div class="br-spin-sm"></div><div class="hint" style="text-align:center">正在从飞书拉取斜杆命令…</div></td></tr></tbody></table>
      <pre class="report" id="scReport" style="display:none;margin-top:12px"></pre>
    </div>
    <footer class="panel-foot">${svg(IC_INFO)} 直接读写飞书开放平台（需 application:app_slash_command 权限并发布版本），改动约 5 分钟生效（PC 端 7.70+）；<b>本页操作即时提交飞书，与「保存」按钮无关</b>。聊天输入 <code>/</code> 弹出指令面板。</footer>
  </div>`;
  const appSel = $('#scApp');
  (S.status?.apps || []).forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = `${a.name}（${a.appId}）`;
    appSel.appendChild(opt);
  });
  const showReport = (title, content) => {
    $('#scReport').style.display = '';
    $('#scReport').textContent = `${title}\n${content}`;
  };
  const loadRemote = async () => {
    if (!appSel.value) { $('#scBody').innerHTML = '<tr><td colspan="4" class="hint">无可用应用（先到「飞书应用」页配置并保存）</td></tr>'; return; }
    $('#scBody').innerHTML = '<tr><td colspan="4" style="padding:36px 0"><div class="br-spin-sm"></div><div class="hint" style="text-align:center">正在从飞书拉取斜杆命令…</div></td></tr>';
    try {
      const r = await api('GET', `/api/slash-commands/remote?app=${encodeURIComponent(appSel.value)}`);
      $('#scBody').innerHTML = r.remote.map((x) => `
        <tr data-cid="${esc(x.command_id)}" data-cmd="${esc(x.command)}">
          <td><code>/${esc(x.command)}</code></td>
          <td>${esc(x.description?.default_value || '')}</td>
          <td class="hint">${esc(x.description?.icon?.icon_key || '—')}</td>
          <td class="ops">
            <button class="btn sm" data-op="edit">编辑</button>
            <button class="btn sm danger" data-op="del">删除</button>
          </td>
        </tr>`).join('') || '<tr class="empty"><td colspan="4">远端暂无命令；点「补齐内置」一键注册 bridge 内置指令</td></tr>';
      $('#scBody').querySelectorAll('button[data-op]').forEach((b) => b.onclick = () => {
        const tr = b.closest('tr');
        if (b.dataset.op === 'del') return delRemote(tr.dataset.cid, tr.dataset.cmd);
        openSlashDrawer({
          commandId: tr.dataset.cid,
          command: tr.dataset.cmd,
          description: tr.children[1].textContent,
          icon: tr.children[2].textContent === '—' ? '' : tr.children[2].textContent,
        });
      });
    } catch (e) {
      $('#scBody').innerHTML = `<tr><td colspan="4" class="hint">加载失败：${esc(e.message)}（确认已开通斜杠命令权限后点「刷新」重试）</td></tr>`;
    }
  };
  const delRemote = async (cid, cmd) => {
    if (!(await confirmDialog({
      title: '删除斜杠命令',
      message: `确认删除远端命令 <code>/${esc(cmd)}</code>？约 5 分钟后从飞书面板消失，不可恢复。`,
      danger: true,
      confirmText: '删除',
    }))) return;
    try {
      await api('POST', '/api/slash-commands/action', { op: 'delete', app: appSel.value, commandId: cid });
      toast(`已删除 /${cmd}`);
      loadRemote();
    } catch (e) { toast(e.message, true); }
  };
  const openSlashDrawer = ({ commandId, command, description, icon }) => {
    const isCreate = !commandId;
    openDrawer({
      title: isCreate ? '新增命令' : `编辑 /${command}`,
      narrow: true,
      bodyHtml: `
        <label class="fld">命令（不带 /${isCreate ? '' : '；飞书侧命令名不可修改，如需改名请删除后重建'}）</label>
        <input type="text" id="dcCmd" ${isCreate ? '' : 'disabled title="飞书侧命令名不可修改（如需改名请删除后重建）"'} value="${esc(command || '')}" placeholder="produce">
        <label class="fld">描述（指令面板展示）</label>
        <input type="text" id="dcDesc" value="${esc(description || '')}" placeholder="内容生产流程">
        <label class="fld">图标 icon_key（可空，取值见飞书开放平台图标列表）</label>
        <input type="text" id="dcIcon" value="${esc(icon || '')}" placeholder="skill_outlined">`,
      footHtml: `<span class="sp"></span><button class="btn" id="dcCancel">取消</button><button class="btn primary" id="dcSave">${isCreate ? '创建' : '保存'}</button>`,
      onMount: ({ foot }) => {
        foot.querySelector('#dcCancel').onclick = closeDrawer;
        foot.querySelector('#dcSave').onclick = async () => {
          const cmd = document.getElementById('dcCmd').value.trim();
          const desc = document.getElementById('dcDesc').value.trim();
          const ic = document.getElementById('dcIcon').value.trim();
          if (!desc) return toast('描述不能为空', true);
          try {
            if (isCreate) {
              if (!cmd) return toast('命令名不能为空', true);
              await api('POST', '/api/slash-commands/action', { op: 'create', app: appSel.value, command: cmd, description: desc, icon: ic });
            } else {
              await api('POST', '/api/slash-commands/action', { op: 'update', app: appSel.value, commandId, description: desc, icon: ic });
            }
            toast(`${isCreate ? `已创建 /${cmd}` : '已保存'}（即时提交飞书，约 5 分钟生效）`);
            closeDrawer();
            loadRemote();
          } catch (e) { toast(e.message, true); }
        };
      },
    });
  };
  appSel.onchange = loadRemote;
  $('#scReload').onclick = loadRemote;
  $('#pageActions').innerHTML = '<button class="btn primary" id="scAdd">新增命令</button>';
  $('#scAdd').onclick = () => openSlashDrawer({ command: '', description: '', icon: '' });
  $('#scBuiltins').onclick = async () => {
    if (!appSel.value) return;
    $('#scBuiltins').disabled = true;
    try {
      const r = await api('POST', '/api/slash-commands/sync', { app: appSel.value, mode: 'builtins-only' });
      const lines = [
        r.created.length ? `✅ 新建 ${r.created.length}：${r.created.join('、')}` : '· 内置命令已齐全（无新建）',
        ...(r.errors.length ? [`⚠️ 失败 ${r.errors.length}：`, ...r.errors.map((e) => `  ${e.command}: ${e.error}`)] : []),
        '（只补缺失的内置命令，不会删除或修改远端已有命令）',
      ];
      showReport('补齐内置命令完成（约 5 分钟后飞书生效）', lines.join('\n'));
      toast(r.errors.length ? `补齐完成，但 ${r.errors.length} 条失败（详见报告）` : '✅ 内置命令已补齐，约 5 分钟后生效');
      loadRemote();
    } catch (e) { showReport('补齐失败', e.message); toast(e.message, true); }
    $('#scBuiltins').disabled = false;
  };
  loadRemote();
}

export const page = {
  id: 'slash',
  title: '斜杠命令',
  desc: '注册到飞书开放平台的指令面板，聊天框输入 / 触发',
  legend: false,
  icon: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  render: renderSlash,
};
