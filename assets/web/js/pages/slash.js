// ============ 斜杠命令（远端直操作飞书 API；本页与 config.yaml / 保存按钮无关） ============
import { S, $, esc, toast, api } from '../core.js';
import { openDrawer, closeDrawer } from '../ui.js';

function renderSlash(el) {
  el.innerHTML = `
  <div class="card">
    <h3>飞书斜杠命令（远端管理）</h3>
    <div class="desc">直接读写飞书开放平台已注册的斜杠命令；聊天输入 <code>/</code> 弹出指令面板，选中后可继续输入描述再发送。需给应用开通 <code>application:app_slash_command</code> 读写权限并发布版本；改动约 5 分钟后生效（PC 端 7.70+）。<b>本页操作即时提交飞书，与底部「保存」按钮无关。</b></div>
    <div class="row" style="align-items:end">
      <div style="max-width:320px"><label>目标应用</label><select id="scApp"></select></div>
      <button class="btn" id="scReload">刷新列表</button>
      <button class="btn primary" id="scAdd">+ 新增命令</button>
      <button class="btn" id="scBuiltins">补齐内置命令</button>
    </div>
    <table style="margin-top:12px"><thead><tr><th style="width:170px">命令</th><th>描述</th><th style="width:150px">图标</th><th style="width:130px">操作</th></tr></thead>
    <tbody id="scBody"><tr><td colspan="4" style="padding:36px 0"><div class="br-spin-sm"></div><div class="hint" style="text-align:center">正在从飞书拉取斜杆命令…</div></td></tr></tbody></table>
    <pre class="report" id="scReport" style="display:none;margin-top:12px"></pre>
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
          <td>
            <button class="btn sm" data-op="edit">编辑</button>
            <button class="btn sm danger" data-op="del">删除</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="4" class="hint">远端暂无命令；点「补齐内置命令」一键注册 bridge 内置指令</td></tr>';
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
      $('#scBody').innerHTML = `<tr><td colspan="4" class="hint">加载失败：${esc(e.message)}（确认已开通斜杠命令权限后点「刷新列表」重试）</td></tr>`;
    }
  };
  const delRemote = async (cid, cmd) => {
    if (!window.confirm(`确认删除远端命令 /${cmd}？（约 5 分钟后从飞书面板消失，不可恢复）`)) return;
    try {
      await api('POST', '/api/slash-commands/action', { op: 'delete', app: appSel.value, commandId: cid });
      toast(`已删除 /${cmd}`);
      loadRemote();
    } catch (e) { toast(e.message, true); }
  };
  const openSlashDrawer = ({ commandId, command, description, icon }) => {
    const isCreate = !commandId;
    openDrawer({
      title: isCreate ? '新增斜杠命令' : `编辑 /${command}`,
      bodyHtml: `
        <label>命令（不带 /）</label>
        <input type="text" id="dcCmd" ${isCreate ? '' : 'disabled title="飞书侧命令名不可修改（如需改名请删除后重建）"'} value="${esc(command || '')}" placeholder="produce">
        <label>描述（指令面板展示）</label>
        <input type="text" id="dcDesc" value="${esc(description || '')}" placeholder="内容生产流程">
        <label>图标 icon_key（可空，取值见飞书开放平台图标列表）</label>
        <input type="text" id="dcIcon" value="${esc(icon || '')}" placeholder="skill_outlined">`,
      footHtml: `<button class="btn primary" id="dcSave">${isCreate ? '创建（即时提交飞书）' : '保存（即时提交飞书）'}</button>`,
      onMount: () => {
        document.getElementById('dcSave').onclick = async () => {
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
            toast(isCreate ? `已创建 /${cmd}` : '已保存');
            closeDrawer();
            loadRemote();
          } catch (e) { toast(e.message, true); }
        };
      },
    });
  };
  appSel.onchange = loadRemote;
  $('#scReload').onclick = loadRemote;
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
  icon: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  render: renderSlash,
};
