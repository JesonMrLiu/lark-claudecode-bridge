// ============ 公共底座：状态 / fetch / 保存 / 刷新 ============
// 所有页面模块与 ui 模块的公共依赖；依赖方向：core ← ui ← {pages, bootstrap} ← main（无环）
// 一步保存：无全局 savebar。抽屉编辑自带「保存/取消」（打开前拍快照）；页内表单卡各自带
// 保存按钮（dirtyCards 跟踪未保存卡）；行内低风险操作（权限增删）直接落盘
export const S = { status: null, doc: null, firstRun: false, dirtyCards: new Set() };
export const $ = (sel, el = document) => el.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = ''; }, isErr ? 6000 : 3200);
}
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // 401 联动：服务端说会话无效（静默过期/手动锁屏吊销/重启吊销）→ 通知 auth 层盖锁屏遮罩，
  // 由 onAuthExpired 自行判重（锁屏上的「密码错误」401 不会走到这里之外的误触发）
  if (res.status === 401) hooks.onAuthExpired?.(path);
  // 成功响应上报「API 活动」给 auth 层计入「使用中」：与服务端滑动续期（任何 /api/* 都续会话）
  // 完全同语义——页面还在自动轮询/刷新数据 = 正被使用，前端锁屏判定不再比服务端更严
  if (res.ok) hooks.onApiActivity?.(path);
  // 把响应体一并挂到 Error 上（message 不变，向后兼容）：调用方常需要 error 之外的结构化字段，
  // 如扫码授权的 hint:'install'|'config'——丢了它前端就只能干瞪眼
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), data);
  return data;
}
/** doc 深拷贝快照（抽屉取消回滚 / 打开前留存） */
export const snapDoc = () => JSON.parse(JSON.stringify(S.doc));
/** 页内表单卡未保存标记：cardDirty('ws', true) 显示卡头「未保存」小标 + 卡底保存行，并记入集合 */
export function cardDirty(id, on) {
  if (on) S.dirtyCards.add(id); else S.dirtyCards.delete(id);
  const dot = $(`#dirty-${id}`);
  if (dot) dot.style.display = on ? 'inline' : 'none'; // '' 会回落到 CSS 默认 display:none，圆点永不显示
  const bar = $(`#bar-${id}`);
  if (bar) bar.style.display = on ? 'flex' : 'none';
}
/** 整卡重渲染（innerHTML 重建）后回放各卡 dirty 可见性：集合是真相源，新建的 bar/dot 默认隐藏 */
export function applyDirty() { for (const id of S.dirtyCards) cardDirty(id, true); }
/** 全量 PUT 落盘（所有保存路径共用）；返回是否成功（失败保持当前编辑态） */
export async function saveDoc() {
  if (S.firstRun) return false;
  try {
    const r = await api('PUT', '/api/config', S.doc);
    if (r.restartRequired?.length) toast(`已保存。注意：${r.restartRequired.join('、')} 段改动需重启 lcb start 后生效`, true);
    else toast('已保存（运行中的桥接器下一条消息自动生效）');
    S.dirtyCards.clear();
    await refresh();
    return true;
  } catch (e) { toast(`保存失败：${e.message}`, true); return false; }
}

/** 视图刷新回调：main.js 启动时注入 render（core 不感知页面注册表，破 core→pages 依赖环）。
 * onAuthExpired：api() 收到 401（会话过期/被吊销）时触发，auth.js 注入——把页面拉回锁屏遮罩，
 * 避免停留在「看似正常但数据全空」的僵尸态。
 * onApiActivity：api() 收到成功响应时触发，auth.js 注入——计入「使用中」（刷新活跃心跳），
 * 让「页面在自动轮询/自动刷新」也被视为正在使用（2026-11-01 使用中被锁屏修复） */
export const hooks = { rerender: () => {}, onAuthExpired: () => {}, onApiActivity: () => {} };

export async function refresh() {
  S.status = await api('GET', '/api/status').catch(() => null);
  try {
    S.doc = await api('GET', '/api/config');
    S.firstRun = false;
  } catch (e) {
    if (String(e.message).includes('bootstrap')) {
      S.firstRun = true;
      S.doc = null;
    } else { throw e; }
  }
  const st = S.status || {};
  const hv = $('#hVer');
  const hh = $('#hHost');
  if (hv) { hv.textContent = `v${st.version || '?'}`; hv.hidden = false; }
  if (hh) { hh.textContent = S.firstRun ? `${location.host} · 首次安装向导` : location.host; hh.hidden = false; }
  // 版本错位检测：静态页每次现读磁盘（新），API 属于运行中进程（旧）——status 无 bridge
  // 字段说明进程早于「页面托管启停」功能，提示重启而非让用户撞「未知端点」
  $('#staleBar').hidden = !(S.status && S.status.bridge === undefined);
  hooks.rerender();
}
