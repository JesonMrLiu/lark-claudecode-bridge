// ============ 公共 UI 组件：保存条 / 目录选择弹层 / 右侧抽屉 / 风格化确认弹窗 ============
import { S, $, esc, toast, api, saveDoc, refresh, hooks } from './core.js';

// ============ 风格化弹窗（替代浏览器原生 confirm / prompt） ============
let openDialogs = 0; // 打开中的弹窗计数：ESC 只关最上层弹窗，不误触抽屉
/** 挂载弹窗遮罩（.modal-mask + .dlg）；返回卸载函数 */
export function mountDialog(innerHTML) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = innerHTML;
  document.body.appendChild(mask);
  openDialogs++;
  return { mask, unmount() { openDialogs--; mask.remove(); } };
}
/** 捕获阶段拦截 ESC / Enter（先于抽屉的冒泡监听），弹窗关闭后自动解绑 */
export function bindDialogKeys(onKey) {
  const handler = (e) => {
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    e.stopPropagation();
    onKey(e.key);
  };
  document.addEventListener('keydown', handler, true);
  return () => document.removeEventListener('keydown', handler, true);
}
/**
 * 二次确认弹窗（替代 window.confirm）→ Promise<boolean>。
 * message 支持 HTML（调用方负责 esc 用户数据）；danger=true 时确认键为红色实心。
 */
export function confirmDialog({ title = '确认操作', message = '', confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const { mask, unmount } = mountDialog(`
      <div class="modal dlg" role="alertdialog" aria-modal="true">
        <h3 class="dlg-title${danger ? ' danger' : ''}">${danger ? '<span class="dlg-ico" aria-hidden="true">!</span>' : ''}${title}</h3>
        <div class="dlg-msg">${message}</div>
        <div class="dlg-foot">
          <button class="btn" data-dlg="cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-dlg="ok">${esc(confirmText)}</button>
        </div>
      </div>`);
    const done = (v) => { unbind(); unmount(); resolve(v); };
    const unbind = bindDialogKeys((key) => done(key === 'Enter'));
    mask.querySelector('[data-dlg="ok"]').onclick = () => done(true);
    mask.querySelector('[data-dlg="cancel"]').onclick = () => done(false);
    mask.onclick = (e) => { if (e.target === mask) done(false); };
    mask.querySelector('[data-dlg="ok"]').focus();
  });
}
/**
 * 输入弹窗（替代 window.prompt）→ Promise<string|null>（null = 取消）。
 */
export function promptDialog({ title = '请输入', message = '', placeholder = '', value = '', confirmText = '确定', cancelText = '取消' }) {
  return new Promise((resolve) => {
    const { mask, unmount } = mountDialog(`
      <div class="modal dlg" role="dialog" aria-modal="true">
        <h3 class="dlg-title">${title}</h3>
        <div class="dlg-msg">${message}</div>
        <input type="text" class="dlg-input" placeholder="${esc(placeholder)}" value="${esc(value)}">
        <div class="dlg-foot">
          <button class="btn" data-dlg="cancel">${esc(cancelText)}</button>
          <button class="btn primary" data-dlg="ok">${esc(confirmText)}</button>
        </div>
      </div>`);
    const input = mask.querySelector('.dlg-input');
    const done = (v) => { unbind(); unmount(); resolve(v); };
    const unbind = bindDialogKeys((key) => done(key === 'Enter' ? input.value : null));
    mask.querySelector('[data-dlg="ok"]').onclick = () => done(input.value);
    mask.querySelector('[data-dlg="cancel"]').onclick = () => done(null);
    mask.onclick = (e) => { if (e.target === mask) done(null); };
    input.focus();
    input.select();
  });
}

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
        <button class="btn pd-up" title="返回上一级">上级目录</button>
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
        ? items.map((it) => `<button data-next="${esc(it.next)}">${esc(it.label)}</button>`).join('')
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

// ============ 抽屉宽度拖拽（localStorage 记忆；双击手柄恢复默认 min(980px,94vw)） ============
const DRAWER_WIDTH_KEY = 'lcb-drawer-width';
export const DRAWER_MIN_WIDTH = 420;
/** 纯函数（可测）：期望宽度钳进 [420, 94vw] */
export function clampDrawerWidth(px, vw) {
  const max = Math.floor(vw * 0.94);
  return Math.max(DRAWER_MIN_WIDTH, Math.min(Math.round(px), max));
}
const drawerEl = () => document.querySelector('.drawer');
/** min() 包裹：窗口变窄后自动回落到 94vw，不会出现横向溢出 */
const applyDrawerWidth = (px) => { drawerEl().style.width = `min(${px}px, 94vw)`; };
const resetDrawerWidth = () => {
  try { localStorage.removeItem(DRAWER_WIDTH_KEY); } catch { /* 隐私模式等：可容忍 */ }
  drawerEl().style.width = ''; // 清内联样式 → 回落 CSS 默认 min(980px,94vw)
};
function initDrawerResize() {
  let saved = NaN;
  try { saved = Number(localStorage.getItem(DRAWER_WIDTH_KEY)); } catch { /* 读失败视同无记忆 */ }
  if (Number.isFinite(saved) && saved >= DRAWER_MIN_WIDTH) applyDrawerWidth(saved);
  const handle = $('#drawerResize');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // 捕获后 move/up 均派发给手柄：指针移出窗口/抽屉不丢事件
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('drawer-resizing');
    const startWidth = drawerEl().getBoundingClientRect().width;
    const startX = e.clientX;
    const move = (ev) => applyDrawerWidth(clampDrawerWidth(startWidth + (startX - ev.clientX), window.innerWidth));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.classList.remove('dragging');
      document.body.classList.remove('drawer-resizing');
      const w = clampDrawerWidth(drawerEl().getBoundingClientRect().width, window.innerWidth);
      try { localStorage.setItem(DRAWER_WIDTH_KEY, String(w)); } catch { /* 写失败可容忍（同 theme.js） */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', resetDrawerWidth);
}

/** 抽屉全局监听一次性注册（main.js 启动时调用；模块顶层零副作用） */
export function initDrawer() {
  $('#drawerClose').onclick = dismissDrawer;
  $('#drawerMask').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) dismissDrawer(); });
  // ESC 有风格化弹窗打开时归弹窗（其自身在捕获阶段拦截并 stopPropagation，此处计数兜底）
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !openDialogs) dismissDrawer(); });
  initDrawerResize();
}

// ============ 长耗时单请求的进度弹窗 ============
/**
 * 进度弹窗（时间缓动模拟，完成前不可关闭）。
 *
 * 观感与 plugins.js 的 runOpDialog 一致，但那个与插件页的 busyText / report / update-all 的
 * 真实 i/N 推进深度耦合，泛化它等于改一个正在工作的界面（`main.css` 明确要求向后兼容）。
 * 这里单独实现语义单一的版本，重复记为可接受代价。
 *
 * @param {number} [opts.reportMaxHeight] 输出区最大高度（px）。默认 220 适合几行总结；
 *   要展示成片清单（如 SKILL 名单）的调用方传更大的值。
 */
export function progressDialog({ title = '执行中', note = '请稍候…', reportMaxHeight = 220 } = {}) {
  const { mask, unmount } = mountDialog(`
    <div class="modal" role="dialog" aria-modal="true" style="width:min(640px,94vw)">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="br-spin" style="margin:0"></div>
        <b class="pd-title">${esc(title)}</b>
      </div>
      <div class="prog"><div class="prog-bar"></div></div>
      <pre class="report" style="margin-top:12px;max-height:${Number(reportMaxHeight) || 220}px"></pre>
      <div class="savebar" style="justify-content:flex-end">
        <button class="btn primary" hidden>关闭</button>
      </div>
    </div>`);
  const bar = mask.querySelector('.prog-bar');
  const log = mask.querySelector('pre.report');
  const spin = mask.querySelector('.br-spin');
  const titleEl = mask.querySelector('.pd-title');
  const closeBtn = mask.querySelector('button');
  log.textContent = note;
  let done = false;
  let onCloseFn = null;
  // 单请求拿不到内部进度：前 2s 线性到 70%，之后渐缓封顶 90%，完成跳 100%（同 runOpDialog 曲线）
  let pct = 0;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    pct = elapsed < 2000 ? Math.min(70, (elapsed / 2000) * 70) : Math.min(90, pct + 1);
    bar.style.width = `${pct}%`;
  }, 300);
  const close = () => {
    if (!done) return; // 完成前没有关闭途径，避免把进行中的操作关成「不知道跑没跑」
    unbind();
    unmount();
    onCloseFn?.();
  };
  const unbind = bindDialogKeys((k) => { if (k === 'Escape') close(); });
  closeBtn.onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };
  return {
    setNote(t) { log.textContent = t; },
    appendLog(line) { log.textContent += `\n${line}`; log.scrollTop = log.scrollHeight; },
    finish(ok, text) {
      done = true;
      clearInterval(timer);
      bar.style.width = '100%';
      if (ok) bar.classList.add('done');
      spin.style.display = 'none';
      titleEl.textContent = text || (ok ? `✅ ${title}` : `❌ ${title}`);
      closeBtn.hidden = false;
      closeBtn.focus();
    },
    onClose(fn) { onCloseFn = fn; },
    unmount() { clearInterval(timer); unbind(); unmount(); },
  };
}

// ============ 可搜索多选字段（分身白名单等；仅限候选内选择，遗留值保留可删） ============
/** 纯函数（可测）：候选过滤——大小写不敏感子串匹配 value+label+desc；>50 项截断（面板尾行提示） */
export function filterMselOptions(options, query) {
  const q = String(query || '').trim().toLowerCase();
  const hit = q
    ? options.filter((o) => `${o.value}\n${o.label || ''}\n${o.desc || ''}`.toLowerCase().includes(q))
    : options.slice();
  const MAX = 50;
  return hit.length > MAX ? { list: hit.slice(0, MAX), truncated: true } : { list: hit, truncated: false };
}

// 活跃实例登记 + 单一全局监听：抽屉 closeDrawer 只隐藏不清 innerHTML、组件没有 teardown
// 钩子——外点 handler 内以 root.isConnected 懒剪枝，离场实例自动出清，监听器全程只注册一次
const mselLive = new Set();
let mselDocBound = false;
function ensureMselDocListener() {
  if (mselDocBound) return;
  mselDocBound = true;
  document.addEventListener('click', (e) => {
    for (const inst of [...mselLive]) {
      if (!inst.root.isConnected) { mselLive.delete(inst); continue; } // 抽屉被替换：僵尸实例出清
      if (!inst.root.contains(e.target)) inst.hidePanel();
    }
  });
}

/**
 * 可搜索多选字段：chips 展示已选（.chip + × 删除），输入框过滤候选，面板点选切换
 * （再点已选项 = 取消）。值只能来自候选 options；初始 value 里不在候选中的遗留值
 * （如技能已卸载）以虚线 chip 保留展示、可删，不进候选面板。
 *
 * 事件边界：候选用 mousedown+preventDefault（沿 plugins.js 先例，输入框不失焦，无 blur
 * 竞态）；ESC 分层——面板开时仅关面板（stopPropagation 防误关抽屉），面板已关放行关抽屉；
 * Enter/方向键在过滤结果内导航并切换（面板保持开，支持连续选取）。
 *
 * @returns {{root: Element, setValue(v: string[]): void, setOptions(list: Array, emptyText?: string): void, destroy(): void}}
 */
export function multiSelectField({ mount, options = [], value = [], placeholder = '', emptyText = '暂无可选项', onChange = () => {} }) {
  ensureMselDocListener();
  const root = document.createElement('div');
  root.className = 'msel';
  root.innerHTML = `
    <div class="chips msel-chips"></div>
    <input type="text" class="msel-input" placeholder="${esc(placeholder)}" autocomplete="off">
    <div class="combo-panel msel-panel" hidden></div>`;
  mount.appendChild(root);
  const chipsBox = root.querySelector('.msel-chips');
  const input = root.querySelector('.msel-input');
  const panel = root.querySelector('.msel-panel');
  let opts = options.slice();
  let emptyTextCur = emptyText;
  let selected = [...new Set(value)]; // 添加序保持；遗留值（不在候选）随初始序保留
  let highlight = 0;

  const renderChips = () => {
    chipsBox.innerHTML = selected.map((v) => {
      const ghost = !opts.some((o) => o.value === v);
      return `<span class="chip${ghost ? ' ghost' : ''}"${ghost ? ' title="已不在候选列表（可能已卸载），可删除"' : ''}>${esc(v)}<button type="button" aria-label="删除">×</button></span>`;
    }).join('');
    chipsBox.querySelectorAll('button').forEach((b, i) => {
      b.onclick = () => { selected.splice(i, 1); emit(); };
    });
  };
  const paintPanel = () => {
    if (!opts.length) { panel.innerHTML = `<div class="combo-empty">${esc(emptyTextCur)}</div>`; return; }
    const { list, truncated } = filterMselOptions(opts, input.value);
    if (!list.length) { panel.innerHTML = '<div class="combo-empty">无匹配项</div>'; return; }
    panel.innerHTML = list.map((o, i) => `
      <div class="combo-item${i === highlight ? ' active' : ''}" data-val="${esc(o.value)}">
        <b>${esc(o.label || o.value)}</b>${o.tag ? ` <span class="tag off"${o.tagTitle ? ` title="${esc(o.tagTitle)}"` : ''}>${esc(o.tag)}</span>` : ''}${selected.includes(o.value) ? '<span class="msel-check">✓</span>' : ''}
        ${o.desc ? `<div class="hint">${esc(o.desc)}</div>` : ''}
      </div>`).join('')
      + (truncated ? '<div class="combo-empty">仅显示前 50 项，继续输入缩小范围</div>' : '');
    panel.querySelectorAll('.combo-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); toggle(el.dataset.val); });
    });
  };
  const showPanel = () => { if (panel.hidden) { panel.hidden = false; } paintPanel(); };
  const hidePanel = () => { panel.hidden = true; };
  const toggle = (v) => {
    const i = selected.indexOf(v);
    if (i >= 0) selected.splice(i, 1); else selected.push(v);
    emit();
  };
  const emit = () => { renderChips(); paintPanel(); onChange([...selected]); };

  input.addEventListener('focus', showPanel);
  input.addEventListener('input', () => { highlight = 0; showPanel(); });
  input.addEventListener('keydown', (e) => {
    // 面板开时 ESC 只关面板：阻止冒泡到 document 的抽屉关闭监听（面板已关则放行，符合直觉）
    if (e.key === 'Escape' && !panel.hidden) { e.stopPropagation(); hidePanel(); return; }
    if (!opts.length) return;
    if (e.key === 'Backspace' && !input.value && selected.length) { e.preventDefault(); selected.pop(); emit(); return; }
    const { list } = filterMselOptions(opts, input.value);
    if (!list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      highlight = panel.hidden ? 0 : (highlight + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      showPanel();
      panel.querySelector('.combo-item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !panel.hidden) {
      e.preventDefault();
      toggle(list[highlight]?.value ?? list[0].value); // 面板保持开：连续选取，焦点留输入框
    }
  });

  const inst = { root, hidePanel };
  mselLive.add(inst);
  renderChips();
  return {
    root,
    setValue(v) { selected = [...new Set(v)]; renderChips(); },
    setOptions(list, nextEmptyText) {
      opts = list.slice();
      if (nextEmptyText !== undefined) emptyTextCur = nextEmptyText;
      renderChips(); // ghost 态随候选变化（如遗留值重新出现在候选里则转实线）
      if (!panel.hidden) paintPanel();
    },
    destroy() { mselLive.delete(inst); root.remove(); },
  };
}
