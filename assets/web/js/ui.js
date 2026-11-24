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
 * 打开目录浏览弹层（文件管理器风格）：盘符/根层 → 逐级进入 → 「选择此目录」确定。
 * resolve(选中的绝对路径) / resolve(null)（取消）。手输路径可直接跳转，
 * 路径不存在等错误在弹层内联提示（不关层、可改可回退）。
 */
export function pickDirectory(initialPath) {
  return new Promise((resolveP) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
    <div class="modal dp" role="dialog" aria-modal="true" style = "padding:30px;">
      <div class="dp-head">
        <b>选择目录</b>
        <span class="dp-path mono" title=""></span>
      </div>
      <div class="dp-toolbar">
        <input type="text" class="dp-jump" placeholder="输入或粘贴路径，回车前往">
        <button class="btn sm dp-go" title="跳转到输入的路径">前往</button>
        <button class="btn sm dp-up" title="返回上一级">上级</button>
      </div>
      <div class="dp-grid"><div class="dp-empty">加载中…</div></div>
      <div class="dp-foot">
        <span class="hint dp-note"></span>
        <span style="flex:1"></span>
        <button class="btn dp-cancel">取消</button>
        <button class="btn primary dp-ok">选择此目录</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const grid = mask.querySelector('.dp-grid');
    const pathEl = mask.querySelector('.dp-path');
    const upBtn = mask.querySelector('.dp-up');
    const okBtn = mask.querySelector('.dp-ok');
    const note = mask.querySelector('.dp-note');
    const jumpInput = mask.querySelector('.dp-jump');
    const FOLDER_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
    let current = '';      // '' = 盘符/根层（此层不可作为选择结果）
    let currentParent = null;
    const close = (val) => { mask.remove(); resolveP(val); };
    const render = (r) => {
      current = r.path || '';
      currentParent = r.parent;
      const curText = r.drives ? '此电脑（选择一个盘符）' : (r.path || '');
      pathEl.textContent = curText;
      pathEl.title = curText;
      upBtn.hidden = !r.parent;
      okBtn.disabled = !current;
      note.textContent = r.error || '';
      const items = r.drives
        ? r.drives.map((d) => ({ label: d, next: d }))
        : (r.dirs || []).map((d) => ({ label: d, next: joinPath(current, d) }));
      grid.innerHTML = items.length
        ? items.map((it) => `<button type="button" class="dp-item" data-next="${esc(it.next)}" title="${esc(it.next)}">${FOLDER_SVG}<span>${esc(it.label)}</span></button>`).join('')
        : `<div class="dp-empty">${r.error ? '（上述路径无法列出子目录）' : '（没有子目录）'}</div>`;
      grid.querySelectorAll('.dp-item').forEach((b) => b.onclick = () => go(b.dataset.next));
    };
    const go = async (p) => {
      grid.innerHTML = '<div class="dp-empty">加载中…</div>';
      try { render(await api('GET', `/api/fs/dirs?p=${encodeURIComponent(p)}`)); }
      catch (e) { grid.innerHTML = `<div class="dp-empty">加载失败：${esc(e.message)}</div>`; }
    };
    const jump = () => { const v = jumpInput.value.trim(); if (v) go(v); };
    mask.querySelector('.dp-go').onclick = jump;
    jumpInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(); } };
    upBtn.onclick = () => { if (currentParent) go(currentParent); };
    // 关闭统一走 closeWithUnbind：弹层销毁时解绑捕获段按键监听
    const unbind = bindDialogKeys((k) => { if (k === 'Escape') close(null); });
    const closeWithUnbind = (val) => { unbind(); close(val); };
    okBtn.onclick = () => { if (current) closeWithUnbind(current); };
    mask.querySelector('.dp-cancel').onclick = () => closeWithUnbind(null);
    mask.onclick = (e) => { if (e.target === mask) closeWithUnbind(null); };
    // 初始位置：现值路径存在则从它开始，否则停在盘符/根层（跳转框预填现值方便改错）
    jumpInput.value = initialPath || '';
    go(initialPath || '');
    jumpInput.focus();
  });
}

// ============ 通用居中弹窗（挂壳层 #modalMask；CLI 授权 / 设置 / 改密 / 工作区选目录用） ============
let modalOnClose = null;
/** 打开通用居中弹窗。width 例：'min(460px,92vw)'；closeOnMask=false 时点遮罩不关（强制引导类） */
export function openModal({ title, bodyHtml, footHtml, width = '', onClose = null, closeOnMask = true }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalFoot').innerHTML = footHtml || '';
  $('#modalBox').style.width = width || '';
  modalOnClose = onClose || null;
  $('#modalMask').dataset.closeOnMask = closeOnMask ? '1' : '';
  $('#modalMask').hidden = false;
  return $('#modalBody');
}
export function closeModal() {
  if ($('#modalMask').hidden) return;
  $('#modalMask').hidden = true;
  $('#modalBox').style.width = '';
  const f = modalOnClose;
  modalOnClose = null;
  f?.();
}
export const isModalOpen = () => !$('#modalMask').hidden;

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
  $('#drawerBody').classList.remove('dw-fill'); // skill 浏览的撑满布局是按抽屉叠加的，关抽屉时还原
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
  // 通用弹窗关闭路径：X / 点遮罩（closeOnMask 才关）/ ESC；层级 = 确认框 > 弹窗 > 抽屉
  $('#modalClose').onclick = closeModal;
  $('#modalMask').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget && $('#modalMask').dataset.closeOnMask) closeModal();
  });
  // ESC 分层：风格化弹窗（确认/输入/进度）自己在捕获段拦截；其次通用弹窗；最后抽屉
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (openDialogs) return;
    if (isModalOpen()) { closeModal(); return; }
    dismissDrawer();
  });
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
  // 三段式结构（.modal 本体无 padding，内边距由 modal-head/body/foot 提供；
  // 关闭按钮放 .modal-foot——savebar 是 fixed 悬浮条，弹窗内复用会脱离文档流漂到屏幕底部）
  const { mask, unmount } = mountDialog(`
    <div class="modal" role="dialog" aria-modal="true" style="width:min(640px,94vw)">
      <div class="modal-head">
        <div class="br-spin" style="margin:0;flex:0 0 auto"></div>
        <b class="pd-title" style="font-size:14.5px">${esc(title)}</b>
      </div>
      <div class="modal-body">
        <div class="prog" style="margin-top:0"><div class="prog-bar"></div></div>
        <pre class="report" style="margin-top:12px;max-height:${Number(reportMaxHeight) || 220}px"></pre>
      </div>
      <div class="modal-foot" data-pd="foot" hidden>
        <button class="btn primary">关闭</button>
      </div>
    </div>`);
  const bar = mask.querySelector('.prog-bar');
  const log = mask.querySelector('pre.report');
  const spin = mask.querySelector('.br-spin');
  const titleEl = mask.querySelector('.pd-title');
  const closeBtn = mask.querySelector('button');
  const footEl = mask.querySelector('[data-pd="foot"]');
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
      footEl.hidden = false;
      closeBtn.focus();
    },
    onClose(fn) { onCloseFn = fn; },
    unmount() { clearInterval(timer); unbind(); unmount(); },
  };
}

// ============ 分步进度弹窗（重启流程等真实状态驱动的串行步骤展示） ============
/**
 * 分步进度弹窗：步骤状态由调用方按**真实探测结果**驱动（区别于 progressDialog 的时间缓动
 * 假进度），适合「LCB 重启 → 记忆增强启动」这类前后步骤状态源不同的流程。
 * 视觉沿用记忆页安装流水线 stepper 的 badge 语言（✓/✗/spinner/序号圆），纵向排布。
 *
 * 可随时关闭是刻意设计：重启是幂等操作、记忆自举在桥接器进程内后台进行，关弹窗只是
 * 停止**观看**，不影响流程本身——所以这里不做 progressDialog 那种「完成前禁关」。
 *
 * @param {string} opts.title 弹窗标题
 * @param {Array<{title: string, detail?: string, status?: 'pending'|'running'|'done'|'failed'|'warn'|'skipped'}>} opts.steps 初始步骤
 * @returns {{ setSteps(steps): void, setHint(html): void, onClose(fn): void, unmount(): void }}
 *   setSteps 整体替换步骤并重绘；setHint 设置底部提示区（放「手动刷新」等动作）；
 *   onClose 注册关闭回调（调用方停轮询/刷新状态）；unmount 直接销毁。
 */
export function stepsDialog({ title = '执行进度', steps = [] } = {}) {
  const { mask, unmount } = mountDialog(`
    <div class="modal dlg" role="dialog" aria-modal="true" style="width:min(520px,94vw)">
      <div style="display:flex;align-items:center;gap:10px">
        <b class="dlg-title" style="margin:0;flex:1">${esc(title)}</b>
        <button class="btn sm" data-sd="close">后台运行</button>
      </div>
      <div data-sd="steps" style="display:flex;flex-direction:column;gap:6px;margin-top:14px"></div>
      <div class="hint" data-sd="hint" style="margin-top:10px"></div>
    </div>`);
  const stepsEl = mask.querySelector('[data-sd="steps"]');
  const hintEl = mask.querySelector('[data-sd="hint"]');
  let onCloseFn = null;
  // badge 视觉与 memory.js installStepsHtml 同源：done=绿✓ failed=红✗ running=spinner
  // pending=序号圈；warn（黄!）为本组件扩展——「未就绪但不构成失败」（记忆增强不阻断语义）
  const BADGE = {
    done: '<span style="width:20px;height:20px;border-radius:50%;background:var(--ok-tx);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto">✓</span>',
    failed: '<span style="width:20px;height:20px;border-radius:50%;background:var(--err-tx);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto">✗</span>',
    warn: '<span style="width:20px;height:20px;border-radius:50%;background:var(--warn-tx);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto">!</span>',
    running: '<span class="br-spin-sm" style="margin:0;flex:0 0 auto"></span>',
    skipped: '<span style="width:20px;height:20px;border-radius:50%;background:var(--muted);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto">–</span>',
  };
  const paint = (list) => {
    stepsEl.innerHTML = list.map((s) => {
      const status = s.status || 'pending';
      const badge = BADGE[status]
        || `<span style="width:20px;height:20px;border-radius:50%;border:1.5px solid var(--muted);color:var(--muted);display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto">${list.indexOf(s) + 1}</span>`;
      return `<div style="background:var(--off-bg);border-radius:10px;padding:10px 12px">
        <div style="display:flex;align-items:center;gap:8px">${badge}<b style="font-size:12.5px">${esc(s.title)}</b></div>
        <div class="hint" style="margin-top:5px;font-size:11px;line-height:1.55;word-break:break-all">${s.detail ? esc(s.detail) : '&nbsp;'}</div>
      </div>`;
    }).join('');
  };
  paint(steps);
  const close = () => { unbind(); unmount(); onCloseFn?.(); };
  const unbind = bindDialogKeys((k) => { if (k === 'Escape') close(); });
  mask.querySelector('[data-sd="close"]').onclick = close;
  return {
    setSteps(list) { steps = list; paint(list); },
    setHint(html) { hintEl.innerHTML = html || ''; },
    onClose(fn) { onCloseFn = fn; },
    unmount() { unbind(); unmount(); },
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

/**
 * 可搜索单选字段（应用抽屉「档案模型」等，Select2 单选形态）：收起态当前值直接显示在
 * 输入框内；聚焦即进入过滤态（清空输入露出 placeholder、面板全量展开，选中项以 ✓ 标记
 * ——单选不做"已选值额外加 chip"，避免与面板 ✓ 重复展示）。清除手势 = 聚焦后空输入退格。
 * 值只能来自候选 options；初始 value 不在候选中的遗留值以虚线 ghost chip 展示（chip 是
 * 遗留值唯一展示处）、可点 × 清除。事件边界与 multiSelectField 同款：
 * mousedown+preventDefault 防失焦竞态、ESC 面板开时仅关面板（stopPropagation 防误关抽屉）、
 * Enter/方向键在过滤结果内导航（Enter 选中即收起——单选无连续选取场景）。
 *
 * @returns {{root: Element, setValue(v: string): void, setOptions(list: Array, emptyText?: string): void, destroy(): void}}
 */
export function singleSelectField({ mount, options = [], value = '', placeholder = '', emptyText = '暂无可选项', onChange = () => {} }) {
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
  let selected = String(value || '');
  let highlight = 0;
  let inputAsFilter = false; // false = input 显示的是选中值（展示态）；true = 用户输入的过滤词

  // 展示态渲染：非 ghost 已选值不渲染 chip（面板 ✓ 是唯一选中标记），值回显进输入框；
  // ghost 遗留值（不在候选）以虚线 chip 展示——那是它唯一展示处。过滤中不动输入框。
  const renderDisplay = () => {
    const ghost = !!selected && !opts.some((o) => o.value === selected);
    if (ghost) {
      chipsBox.innerHTML = `<span class="chip ghost" title="已不在候选列表，可点击 × 清除">${esc(selected)}<button type="button" aria-label="清除">×</button></span>`;
      chipsBox.querySelector('button').onclick = () => { selected = ''; emit(); };
    } else chipsBox.innerHTML = '';
    if (!inputAsFilter) input.value = ghost ? '' : (selected ? (opts.find((o) => o.value === selected)?.label || selected) : '');
  };
  const paintPanel = () => {
    if (!opts.length) { panel.innerHTML = `<div class="combo-empty">${esc(emptyTextCur)}</div>`; return; }
    const { list, truncated } = filterMselOptions(opts, input.value);
    if (!list.length) { panel.innerHTML = '<div class="combo-empty">无匹配项</div>'; return; }
    panel.innerHTML = list.map((o, i) => `
      <div class="combo-item${i === highlight ? ' active' : ''}" data-val="${esc(o.value)}">
        <b>${esc(o.label || o.value)}</b>${o.tag ? ` <span class="tag off"${o.tagTitle ? ` title="${esc(o.tagTitle)}"` : ''}>${esc(o.tag)}</span>` : ''}${o.value === selected ? '<span class="msel-check">✓</span>' : ''}
        ${o.desc ? `<div class="hint">${esc(o.desc)}</div>` : ''}
      </div>`).join('')
      + (truncated ? '<div class="combo-empty">仅显示前 50 项，继续输入缩小范围</div>' : '');
    panel.querySelectorAll('.combo-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(el.dataset.val); });
    });
  };
  const showPanel = () => { if (panel.hidden) panel.hidden = false; paintPanel(); };
  // 统一收口：ESC / pick / 外点三路关面板都在此恢复展示态（回显选中值、丢掉未确认的过滤词）
  const hidePanel = () => { panel.hidden = true; inputAsFilter = false; renderDisplay(); };
  const pick = (v) => { selected = v; hidePanel(); emit(); };
  const emit = () => { renderDisplay(); if (!panel.hidden) paintPanel(); onChange(selected); };

  input.addEventListener('focus', () => {
    inputAsFilter = false;
    input.value = ''; // 程序化清空不触发 input 事件，placeholder 露出作搜索提示
    highlight = 0;    // 过滤列表将由收窄变全量，残留索引会让 Enter 选错项
    showPanel();
  });
  // pick/ESC 收起后焦点仍留在 input 上，再点击不触发 focus——补一条重开路径（与 focus 幂等同款）
  input.addEventListener('click', () => {
    if (panel.hidden) { inputAsFilter = false; input.value = ''; highlight = 0; showPanel(); }
  });
  input.addEventListener('input', () => { inputAsFilter = true; highlight = 0; showPanel(); });
  input.addEventListener('keydown', (e) => {
    // 面板开时 ESC 只关面板：阻止冒泡到 document 的抽屉关闭监听（面板已关则放行，符合直觉）
    if (e.key === 'Escape' && !panel.hidden) { e.stopPropagation(); hidePanel(); return; }
    // 空输入框退格 = 清除已选（回空 = 跟随默认），与多选「删最后一个 chip」同直觉
    if (e.key === 'Backspace' && !input.value && selected) { e.preventDefault(); selected = ''; emit(); return; }
    if (!opts.length) return;
    const { list } = filterMselOptions(opts, input.value);
    if (!list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      highlight = panel.hidden ? 0 : (highlight + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      showPanel();
      panel.querySelector('.combo-item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !panel.hidden) {
      e.preventDefault();
      pick(list[highlight]?.value ?? list[0].value); // 选中即收起：单选无连续选取
    }
  });

  const inst = { root, hidePanel };
  mselLive.add(inst);
  renderDisplay();
  return {
    root,
    // 静默设值：不触发 onChange（切档案联动清空等程序化操作用，用户交互才走 onChange）
    setValue(v) { selected = String(v || ''); renderDisplay(); },
    setOptions(list, nextEmptyText) {
      opts = list.slice();
      if (nextEmptyText !== undefined) emptyTextCur = nextEmptyText;
      renderDisplay(); // ghost 态随候选变化
      if (!panel.hidden) paintPanel();
    },
    destroy() { mselLive.delete(inst); root.remove(); },
  };
}
