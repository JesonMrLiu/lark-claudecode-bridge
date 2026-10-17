// ============ 工作区（卡片列表 + 两步选目录弹窗 + 全局默认；卡级保存，热生效） ============
// 列表行内「设为默认」改 defaults.workspace；添加/修改走弹窗：第一步选文件夹，第二步填名称。
import { S, $, esc, toast, cardDirty, applyDirty } from '../core.js';
import { saveBarHtml, dirtyDotHtml, bindSaveBar, pickDirectory, confirmDialog, openModal, closeModal } from '../ui.js';

const svg = (inner, s = 16) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const IC = {
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M12 12v4"/>',
};

/** 两步式工作区弹窗：选目录（pickDirectory）→ 已选路径卡 + 名称输入 → 确认写回 doc */
function wsFolderModal(doc, idx, el) {
  const isNew = idx < 0;
  const old = isNew ? { name: '', path: '' } : doc.workspaces[idx];
  const w = { name: old.name || '', path: old.path || '' };
  const paint = () => {
    openModal({
      title: isNew ? '添加工作区' : '修改工作区',
      width: 'min(460px,92vw)',
      bodyHtml: `
        <div class="mut" style="font-size:12.5px;margin:-4px 0 12px">第一步选择文件夹，接着填写名称。</div>
        ${w.path
          ? `<div class="picked-path"><span class="ws-ico">${svg(IC.folderOpen)}</span>
              <div style="min-width:0"><b>${esc(w.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop())}</b><div class="hint mono" style="word-break:break-all">${esc(w.path)}</div></div></div>
            <button class="btn primary" id="wsPick" style="margin-top:8px">${svg(IC.folder, 14)} 重新选择文件夹</button>`
          : `<button class="btn primary" id="wsPick" style="width:100%;justify-content:center">${svg(IC.folder, 14)} 选择文件夹</button>`}
        <label class="fld" style="margin-top:16px">工作区名称</label>
        <input type="text" id="wsName" value="${esc(w.name)}" placeholder="如 电商项目">
        <div class="mini-note" style="margin-top:6px">名称用于在工作区列表中识别，可随时修改。</div>
        ${w.path ? '' : '<div class="mini-note" style="margin-top:10px">如需更换目录，请点击上方按钮重新选择。</div>'}`,
      footHtml: `<span class="sp"></span><button class="btn" id="wsMCancel">取消</button><button class="btn primary" id="wsMOk">${isNew ? '确认添加' : '保存'}</button>`,
    });
    $('#wsPick').onclick = async () => {
      const picked = await pickDirectory(w.path || '');
      if (picked == null) return; // 取消选择：留在弹窗，原路径不动
      w.path = picked;
      if (!w.name) w.name = picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
      paint();
      $('#wsName').value = w.name;
    };
    $('#wsMCancel').onclick = closeModal;
    $('#wsMOk').onclick = () => {
      if (!w.path) return toast('请先选择文件夹', true);
      w.name = $('#wsName').value.trim();
      if (!w.name) return toast('请填写工作区名称', true);
      if (isNew) doc.workspaces.push({ ...w });
      else doc.workspaces[idx] = { ...w };
      // 改名联动：全局默认指向旧名时同步，否则保存会因 defaults.workspace 不在工作区列表报错
      if (!isNew && doc.defaults?.workspace && doc.defaults.workspace === old.name) {
        doc.defaults = { ...(doc.defaults || {}), workspace: w.name };
        cardDirty('def', true);
      }
      closeModal();
      cardDirty('ws', true);
      renderWorkspaces(el);
    };
  };
  paint();
}

function renderWorkspaces(el) {
  const doc = S.doc;
  doc.workspaces = doc.workspaces || [];
  const defWs = doc.defaults?.workspace || '';
  el.innerHTML = `
  <div class="panel">
    <header class="panel-head"><h3>工作区目录${dirtyDotHtml('ws')}</h3>
      <span class="panel-sub">选择本机文件夹并设置一个便于识别的名称</span>
      <div class="panel-actions"><button class="btn primary sm" id="wsAdd">＋ 添加工作区</button></div>
    </header>
    <div class="panel-body"><div class="ws-list" id="wsList"></div></div>
    ${saveBarHtml('ws')}
    <footer class="panel-foot">${svg(IC.info, 13)} git 仓库工作区的任务收尾会自动发送汇总 diff 卡片；运行中的桥接器下一条消息自动生效，无需重启。</footer>
  </div>
  <div class="panel">
    <header class="panel-head"><h3>全局默认${dirtyDotHtml('def')}</h3>
      <span class="panel-sub">用于新会话的默认行为；默认工作区在上方列表行内「设为默认」</span></header>
    <div class="panel-body">
      <div class="grid3">
        <div><label class="fld">全局并发（concurrency）</label><input type="number" id="globalCc" min="1" max="100"></div>
        <div><label class="fld">上下文提醒阈值（session.context_remind_tokens；0=关闭）</label><input type="number" id="defCtxRemind" min="0" max="10000000"></div>
        <div><label class="fld">飞书卡片宽度（card.width）</label>
          <select id="cardWidth">
            <option value="default">默认（飞书默认）</option>
            <option value="fill">撑满聊天窗口</option>
          </select>
        </div>
      </div>
    </div>
    ${saveBarHtml('def')}
  </div>`;
  bindSaveBar(el, 'ws');
  bindSaveBar(el, 'def');
  const drawRows = () => {
    $('#wsList').innerHTML = doc.workspaces.map((w, i) => `
      <div class="ws-item">
        <span class="ws-ico">${svg(IC.folder)}</span>
        <div class="ws-main">
          <div class="ws-name">${esc(w.name) || '<span class="mut">（未命名）</span>'} ${defWs === w.name ? '<span class="tag ok">默认</span>' : ''}</div>
          <div class="ws-path">${esc(w.path) || '（未选择目录）'}</div>
        </div>
        <div class="ws-ops">
          ${defWs === w.name ? '' : `<button class="btn sm" data-wdef="${i}">设为默认</button>`}
          <button class="btn sm" data-wedit="${i}">修改</button>
          <button class="btn sm danger" data-wdel="${i}">删除</button>
        </div>
      </div>`).join('') || '<div class="empty">暂无工作区，点右上「＋ 添加工作区」开始</div>';
    $('#wsList').querySelectorAll('[data-wdef]').forEach((b) => b.onclick = () => {
      doc.defaults = { ...(doc.defaults || {}), workspace: doc.workspaces[Number(b.dataset.wdef)].name };
      cardDirty('def', true);
      renderWorkspaces(el);
    });
    $('#wsList').querySelectorAll('[data-wedit]').forEach((b) => b.onclick = () => wsFolderModal(doc, Number(b.dataset.wedit), el));
    $('#wsList').querySelectorAll('[data-wdel]').forEach((b) => b.onclick = async () => {
      if (doc.workspaces.length <= 1) return toast('至少保留一个工作区', true);
      const idx = Number(b.dataset.wdel);
      const w = doc.workspaces[idx];
      if (!(await confirmDialog({
        title: '删除工作区',
        message: `确定删除工作区「${esc(w.name || '未命名')}」？随本卡「保存」生效，保存前可点「还原」撤销。`,
        danger: true,
        confirmText: '删除',
      }))) return;
      doc.workspaces.splice(idx, 1);
      // 删除的是默认工作区：默认顺移到剩余第一个，避免保存时 defaults.workspace 悬空报错
      if (doc.defaults?.workspace === w.name) {
        doc.defaults = { ...(doc.defaults || {}), workspace: doc.workspaces[0]?.name || '' };
        cardDirty('def', true);
        toast('已同步切换全局默认工作区，请一并保存', true);
      }
      cardDirty('ws', true);
      renderWorkspaces(el);
    });
  };
  drawRows();
  $('#wsAdd').onclick = () => wsFolderModal(doc, -1, el);
  $('#globalCc').value = doc.concurrency ?? 3;
  $('#globalCc').oninput = () => { doc.concurrency = Number($('#globalCc').value) || 3; cardDirty('def', true); };
  // 上下文提醒阈值：空值 = 移除 session 段（PUT 跳过 = 磁盘原值未变，等价回滚）；合法数字 = 写 session 段
  const ctxInput = $('#defCtxRemind');
  ctxInput.value = doc.session?.context_remind_tokens ?? 150000;
  ctxInput.oninput = () => {
    const v = ctxInput.value.trim();
    if (v === '') delete doc.session;
    else doc.session = { context_remind_tokens: Number(v) };
    cardDirty('def', true);
  };
  // 卡片宽度：写 card.width；空/未设回 'default'
  const cw = $('#cardWidth');
  cw.value = doc.card?.width ?? 'default';
  cw.onchange = () => { doc.card = { width: cw.value }; cardDirty('def', true); };
  applyDirty(); // 增删行等操作先 cardDirty 再整卡重渲染：回放防止保存条/圆点随重建丢失
}

export const page = {
  id: 'workspaces',
  title: '工作区',
  desc: 'Claude 的工作目录白名单与全局默认',
  icon: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  render: renderWorkspaces,
};
