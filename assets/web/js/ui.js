// ============ 公共 UI 组件：保存条 / 目录选择弹层 / 右侧抽屉 ============
import { S, $, esc, toast, api, saveDoc, refresh, hooks } from './core.js';

/** 卡级保存行（页内表单卡通用）：保存 = saveDoc 落盘；还原 = 重拉磁盘配置 */
export const saveBarHtml = (id) => `<div class="savebar" id="bar-${id}" style="display:none"><span class="state">有未保存的修改</span><span style="flex:1"></span><button class="btn" data-discard="${id}">还原</button><button class="btn primary" data-save="${id}">保存</button></div>`;
export const dirtyDotHtml = (id) => `<span class="dirty-dot" id="dirty-${id}">· 未保存</span>`;
export function bindSaveBar(el, id) {
  el.querySelector(`[data-save="${id}"]`)?.addEventListener('click', () => void saveDoc());
  el.querySelector(`[data-discard="${id}"]`)?.addEventListener('click', async () => {
    await refresh();
    toast('已还原为磁盘配置');
  });
}

// ============ 目录选择弹层（工作区路径等；数据源 GET /api/fs/dirs） ============
/** 后端返回的绝对路径 + 子目录名拼完整路径（Windows 反斜杠 / posix 正斜杠，按 base 自带分隔符判断） */
const joinPath = (base, name) => {
  if (!base) return name;
  const sepCh = base.includes('\\') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sepCh + name;
};
/**
 * 打开目录浏览弹层：盘符/根层 → 逐级进入 → 「选择此目录」确定。
 * resolve(选中的绝对路径) / resolve(null)（取消）。手输路径可直接跳转，
 * 路径不存在等错误在弹层内联提示（不关层、可改可回退）。
 */
export function pickDirectory(initialPath) {
  return new Promise((resolveP) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3 style="margin:0 0 10px">选择目录</h3>
      <div class="row">
        <input type="text" class="pd-jump" placeholder="输入或粘贴路径，回车前往">
        <button class="btn pd-go" title="跳转到输入的路径">前往</button>
        <button class="btn pd-up" title="返回上一级">⬆ 上级</button>
      </div>
      <div class="hint pd-cur" style="margin:8px 0 0;word-break:break-all"></div>
      <div class="dir-list"><div class="empty">加载中…</div></div>
      <div class="savebar">
        <span class="hint pd-note"></span><span style="flex:1"></span>
        <button class="btn pd-cancel">取消</button>
        <button class="btn primary pd-ok">选择此目录</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const list = mask.querySelector('.dir-list');
    const cur = mask.querySelector('.pd-cur');
    const upBtn = mask.querySelector('.pd-up');
    const okBtn = mask.querySelector('.pd-ok');
    const note = mask.querySelector('.pd-note');
    const jumpInput = mask.querySelector('.pd-jump');
    let current = '';      // '' = 盘符/根层（此层不可作为选择结果）
    let currentParent = null;
    const close = (val) => { mask.remove(); resolveP(val); };
    const render = (r) => {
      current = r.path || '';
      currentParent = r.parent;
      cur.textContent = r.drives ? '此电脑（选择一个盘符）' : (r.path || '');
      upBtn.hidden = !r.parent;
      okBtn.disabled = !current;
      note.textContent = r.error || '';
      const items = r.drives
        ? r.drives.map((d) => ({ label: d, next: d }))
        : (r.dirs || []).map((d) => ({ label: d, next: joinPath(current, d) }));
      list.innerHTML = items.length
        ? items.map((it) => `<button data-next="${esc(it.next)}">📁 ${esc(it.label)}</button>`).join('')
        : `<div class="empty">${r.error ? '（上述路径无法列出子目录）' : '（没有子目录）'}</div>`;
      list.querySelectorAll('button[data-next]').forEach((b) => b.onclick = () => go(b.dataset.next));
    };
    const go = async (p) => {
      list.innerHTML = '<div class="empty">加载中…</div>';
      try { render(await api('GET', `/api/fs/dirs?p=${encodeURIComponent(p)}`)); }
      catch (e) { list.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
    };
    const jump = () => { const v = jumpInput.value.trim(); if (v) go(v); };
    mask.querySelector('.pd-go').onclick = jump;
    jumpInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(); } };
    upBtn.onclick = () => { if (currentParent) go(currentParent); };
    okBtn.onclick = () => { if (current) close(current); };
    mask.querySelector('.pd-cancel').onclick = () => close(null);
    mask.onclick = (e) => { if (e.target === mask) close(null); };
    // 初始位置：现值路径存在则从它开始，否则停在盘符/根层（跳转框预填现值方便改错）
    jumpInput.value = initialPath || '';
    go(initialPath || '');
  });
}

// ============ 通用右侧抽屉（应用编辑 / 斜杆命令编辑 / 档案编辑共用） ============
let drawerOnMount = null;
let drawerSnap = null; // 抽屉打开前的 doc 快照（取消回滚用；远端 CRUD 抽屉不传 snap 则不回滚）
/** 打开抽屉：snap = 调用方在 mutate doc 之前拍的快照；onMount({body, foot}) 里绑定事件 */
export function openDrawer({ title, bodyHtml, footHtml, onMount, snap }) {
  $('#drawerTitle').textContent = title;
  $('#drawerBody').innerHTML = bodyHtml;
  $('#drawerFoot').innerHTML = footHtml || '';
  $('#drawerMask').hidden = false;
  drawerSnap = snap ?? null;
  drawerOnMount = onMount || null;
  drawerOnMount?.({ body: $('#drawerBody'), foot: $('#drawerFoot') });
}
export function closeDrawer() {
  if ($('#drawerMask').hidden) return;
  $('#drawerMask').hidden = true;
  drawerOnMount = null;
  drawerSnap = null;
}
export const isDrawerOpen = () => !$('#drawerMask').hidden;
/** 抽屉取消：回滚到打开前快照（含「新增未保存」行一并撤销）并重渲染 */
export function cancelDrawer() {
  if (drawerSnap) S.doc = JSON.parse(JSON.stringify(drawerSnap));
  closeDrawer();
  hooks.rerender();
}
// X / ESC / 点遮罩 = 取消：本地编辑抽屉（有快照）回滚未保存修改；远端 CRUD 抽屉直接关闭
const dismissDrawer = () => (drawerSnap ? cancelDrawer() : closeDrawer());
/** 抽屉全局监听一次性注册（main.js 启动时调用；模块顶层零副作用） */
export function initDrawer() {
  $('#drawerClose').onclick = dismissDrawer;
  $('#drawerMask').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) dismissDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissDrawer(); });
}
