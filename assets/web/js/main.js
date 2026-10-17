// ============ 入口：分组导航注册表 + hash 路由 + 锁屏门 + 启动 ============
// 新增配置页：js/pages/ 下新建模块（export const page = { id, title, desc, icon, render(el) }）
// 并在下方 import + PAGES 数组各加一行即可；后端 /js/* 静态服务自动覆盖新文件
import { S, $, esc, hooks, refresh } from './core.js';
import { initDrawer, isDrawerOpen, cancelDrawer, confirmDialog } from './ui.js';
import { initTheme } from './theme.js';
import { initAuth, AUTH } from './auth.js';
import { renderBootstrap } from './bootstrap.js';
import { page as pOverview } from './pages/overview.js';
import { page as pApps } from './pages/apps.js';
import { page as pWorkspaces } from './pages/workspaces.js';
import { page as pChats } from './pages/chats.js';
import { page as pClaude } from './pages/claude.js';
import { page as pPermissions } from './pages/permissions.js';
import { page as pSlash } from './pages/slash.js';
import { page as pPlugins } from './pages/plugins.js';
import { page as pSkills } from './pages/skills.js';
import { page as pMcp } from './pages/mcp.js';
import { page as pMemory } from './pages/memory.js';

const PAGES = [pOverview, pChats, pApps, pWorkspaces, pSlash, pClaude, pPlugins, pSkills, pMcp, pPermissions, pMemory];
const pageById = new Map(PAGES.map((p) => [p.id, p]));
const DEFAULT_TAB = 'overview';

/** 侧边栏分组（原型同款）：同一功能聚在一组，跨组动线从上到下 = 部署 → 接入 → 扩展 → 安全 */
const NAV = [
  { group: '总览', items: ['overview', 'chats'] },
  { group: '机器人接入', items: ['apps', 'workspaces', 'slash'] },
  { group: '模型与扩展', items: ['claude', 'plugins', 'skills', 'mcp'] },
  { group: '安全与记忆', items: ['permissions', 'memory'] },
];

// 菜单图标包装：页面自带 icon（Lucide 风格线性 SVG 内串），此处只包一层跟随选中态配色
const ico = (inner) => `<span class="ico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg></span>`;
const icoSearch = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg>';
const LEGEND = '<span class="tag warn">需重启</span> 标记的配置保存后需重启桥接器生效；其余改动下一条消息自动生效。';

// ---- hash 路由：#claude 等；刷新 / 分享链接 / 前进后退均可定位 ----
const tabFromHash = () => { const id = location.hash.slice(1); return pageById.has(id) ? id : DEFAULT_TAB; };
let activeTab = tabFromHash(); // 首载即定位（首次 render 前）
let restoring = false;         // 拒绝导航后回写 hash 触发的 hashchange 自抑制标志

/** 切页保护：抽屉编辑中 / 页内表单卡有未保存改动 → 确认后才切换（切走即丢弃） */
async function confirmLeave() {
  if (isDrawerOpen()) {
    if (!(await confirmDialog({ title: '放弃未保存的修改？', message: '编辑抽屉尚未保存，切换页面将丢弃这些修改。', danger: true, confirmText: '放弃修改' }))) return false;
    cancelDrawer(); // 回滚抽屉编辑（内部 rerender 旧页），再由调用方 render 新页
  } else if (S.dirtyCards.size) {
    if (!(await confirmDialog({ title: '放弃未保存的修改？', message: `有 ${S.dirtyCards.size} 处未保存的修改，切换页面将丢弃。`, danger: true, confirmText: '放弃修改' }))) return false;
    S.dirtyCards.clear();
  }
  return true;
}

function renderNav() {
  const q = ($('#navQ')?.value || '').trim();
  $('#nav').innerHTML = `
    <div class="nav-search">${icoSearch}<input id="navQ" placeholder="搜索页面…" value="${esc(q)}"></div>` +
    NAV.map((g) => {
      const items = g.items.filter((id) => pageById.has(id));
      if (!items.length) return '';
      return `<div class="nav-group"><div class="nav-group-label">${g.group}</div>` +
        items.map((id) => {
          const p = pageById.get(id);
          const badge = p.badge ? p.badge() : '';
          return `<button class="nav-item ${id === activeTab ? 'active' : ''}" data-k="${id}" data-label="${esc(p.title)}">${ico(p.icon)}<span>${esc(p.title)}</span>${badge}</button>`;
        }).join('') + '</div>';
    }).join('');
  $('#nav').querySelectorAll('.nav-item').forEach((b) =>
    b.onclick = () => void tryActivate(b.dataset.k));
  // 搜索过滤：只切换菜单项显隐、不重建 DOM；组合输入（中文 IME）期间暂停，选词结束再过滤
  const inp = $('#navQ');
  const applyFilter = () => {
    const kw = (inp.value || '').trim().toLowerCase();
    $('#nav').querySelectorAll('.nav-item').forEach((b) =>
      b.classList.toggle('nav-hide', !!kw && !b.dataset.label.toLowerCase().includes(kw)));
    $('#nav').querySelectorAll('.nav-group').forEach((g) => {
      const vis = [...g.querySelectorAll('.nav-item')].some((b) => !b.classList.contains('nav-hide'));
      g.style.display = vis ? '' : 'none';
    });
  };
  let composing = false;
  inp.addEventListener('compositionstart', () => { composing = true; });
  inp.addEventListener('compositionend', () => { composing = false; applyFilter(); });
  inp.oninput = () => { if (!composing) applyFilter(); };
  applyFilter();
}

function render() {
  renderNav();
  if (S.firstRun) {
    // 首装向导：隐藏页头与图例，无论 hash 是什么都渲染向导
    $('#pageHead').hidden = true;
    $('#pageLegend').hidden = true;
    $('#view').innerHTML = '';
    renderBootstrap($('#view'));
    return;
  }
  const page = pageById.get(activeTab);
  $('#pageHead').hidden = false;
  $('#pageHead').innerHTML = `
    <span class="ico"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${page.icon}</svg></span>
    <div><h2>${esc(page.title)}</h2><div class="page-desc">${esc(page.desc || '')}</div></div>
    <div class="page-actions" id="pageActions"></div>`;
  $('#pageLegend').hidden = page.legend === false;
  $('#pageLegend').innerHTML = page.legend === false ? '' : LEGEND;
  $('#view').innerHTML = '';
  void page.render($('#view')); // fire-and-forget（async 页面同旧版）
}

/** nav 点击与 hashchange 的唯一汇聚点：确认 → 更新 activeTab + 同步 hash → 渲染 */
async function tryActivate(tab) {
  if (!AUTH.unlocked) return;      // 锁屏期间不渲染页面（解锁后 refresh() 统一触发）
  if (tab === activeTab) return;   // nav 点击后写 hash 引发的 hashchange 在此早退（无双重渲染）
  if (!(await confirmLeave())) {
    // 拒绝导航：把 hash 回滚到当前页；回写引发的 hashchange 用 restoring 吞掉
    if (location.hash.slice(1) !== activeTab) { restoring = true; location.hash = activeTab; }
    return;
  }
  activeTab = tab;
  if (location.hash.slice(1) !== tab) location.hash = tab;
  render();
}

window.addEventListener('hashchange', () => {
  if (restoring) { restoring = false; return; }
  void tryActivate(tabFromHash()); // 覆盖手改地址栏 / 分享链接 / 前进后退
});

// ---- 启动 ----
window.__lcbBooted = true; // index.html 兜底脚本标志：module 加载成功
hooks.rerender = render;   // 破环注入：core 的 refresh/cancelDrawer 经 hooks 触发重渲染
initTheme();               // 亮/暗切换（单按钮，localStorage 持久化）
initDrawer();              // 抽屉 + 通用弹窗全局监听（ESC 分层：确认框 > 弹窗 > 抽屉）
// 进页即锁：锁屏通过后才拉数据并渲染（onUnlock → refresh → hooks.rerender）
initAuth({
  onUnlock: async () => {
    try { await refresh(); }
    catch (e) {
      $('#view').innerHTML = `<div class="panel"><div class="panel-body"><h3>加载失败</h3><div class="desc">${esc(e.message)}</div></div></div>`;
    }
  },
});
