// ============ 工作区（行内编辑 + 卡级保存；改动落盘后热生效） ============
import { S, $, esc, toast, cardDirty, applyDirty } from '../core.js';
import { saveBarHtml, dirtyDotHtml, bindSaveBar, pickDirectory } from '../ui.js';

function renderWorkspaces(el) {
  const doc = S.doc;
  doc.workspaces = doc.workspaces || [];
  el.innerHTML = `
  <div class="card">
    <h3>工作区${dirtyDotHtml('ws')}</h3>
    <div class="desc">Claude 的工作目录白名单。「开发工作流（code-dev）」类型：先出计划（飞书批准）+ 收尾汇总 diff。</div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn sm" id="wsAdd">+ 添加工作区</button>
    </div>
    <table><thead><tr><th style="width:180px">名字</th><th>路径</th><th style="width:170px">类型</th><th style="width:50px"></th></tr></thead>
    <tbody id="wsBody"></tbody></table>
    ${saveBarHtml('ws')}
    <div class="footer-note">运行中的桥接器下一条消息自动生效，无需重启。</div>
  </div>
  <div class="card">
    <h3>全局默认${dirtyDotHtml('def')}</h3>
    <div class="row">
      <div><label>默认工作区（defaults.workspace）</label><select id="defWs"></select></div>
      <div><label>全局并发（concurrency）</label><input type="number" id="globalCc" min="1" max="100"></div>
    </div>
    ${saveBarHtml('def')}
  </div>`;
  bindSaveBar(el, 'ws');
  bindSaveBar(el, 'def');
  /** 重建默认工作区下拉选项：保留当前选中；现值不在工作区列表（手工编辑过的脏配置）时注入该值本身，防静默丢数据 */
  const syncDefWsOptions = () => {
    const sel = $('#defWs');
    if (!sel) return;
    const cur = doc.defaults?.workspace || '';
    const names = doc.workspaces.map((w) => w.name || '').filter(Boolean);
    const extra = cur && !names.includes(cur) ? [cur] : [];
    sel.innerHTML = ['', ...names, ...extra].map((n) =>
      `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${n === '' ? '（未设置）' : esc(n)}${extra.includes(n) ? '（配置中不存在）' : ''}</option>`).join('');
  };
  const body = $('#wsBody');
  const renderRow = (ws, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" data-f="name" value="${esc(ws.name || '')}"></td>
      <td><div class="input-btn">
        <input type="text" data-f="path" value="${esc(ws.path || '')}">
        <button class="btn sm" data-browse="path" title="浏览选择目录">浏览</button>
      </div></td>
      <td><select data-f="type">
        <option value="generic" ${ws.type !== 'code-dev' ? 'selected' : ''}>通用（generic）</option>
        <option value="code-dev" ${ws.type === 'code-dev' ? 'selected' : ''}>开发工作流（code-dev）</option>
      </select></td>
      <td><button class="btn sm danger">删</button></td>`;
    tr.querySelectorAll('[data-f]').forEach((input) => {
      input.oninput = input.onchange = () => {
        const f = input.dataset.f;
        if (f === 'type') { if (input.value === 'code-dev') ws.type = 'code-dev'; else delete ws.type; }
        else if (f === 'name') {
          // 改名联动：全局默认指向旧名时同步，否则保存会因 defaults.workspace 不在工作区列表报错
          if (doc.defaults?.workspace && doc.defaults.workspace === ws.name) {
            doc.defaults = { ...(doc.defaults || {}), workspace: input.value };
          }
          ws.name = input.value;
          syncDefWsOptions();
        }
        else ws[f] = input.value;
        cardDirty('ws', true);
      };
    });
    tr.querySelector('.btn').onclick = () => {
      if (doc.workspaces.length <= 1) return toast('至少保留一个工作区', true);
      doc.workspaces.splice(idx, 1);
      cardDirty('ws', true);
      renderWorkspaces(el);
    };
    // 浏览选目录：回填后手动同步 ws.path（直接改 input.value 不触发 oninput）
    tr.querySelector('[data-browse]').onclick = async () => {
      const picked = await pickDirectory(ws.path || '');
      if (picked == null) return;
      ws.path = picked;
      tr.querySelector('input[data-f=path]').value = picked;
      cardDirty('ws', true);
    };
    body.appendChild(tr);
  };
  doc.workspaces.forEach(renderRow);
  $('#wsAdd').onclick = () => { doc.workspaces.push({ name: '', path: '' }); cardDirty('ws', true); renderWorkspaces(el); };
  syncDefWsOptions();
  $('#defWs').onchange = () => { doc.defaults = { ...(doc.defaults || {}), workspace: $('#defWs').value }; cardDirty('def', true); };
  $('#globalCc').value = doc.concurrency ?? 3;
  $('#globalCc').oninput = () => { doc.concurrency = Number($('#globalCc').value) || 3; cardDirty('def', true); };
  applyDirty(); // 增删行等操作先 cardDirty 再整卡重渲染：回放防止保存条/圆点随重建丢失
}

export const page = {
  id: 'workspaces',
  title: '工作区',
  icon: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  render: renderWorkspaces,
};
