// ============ 入口：页面注册表 + hash 路由 + 启动 ============
// 新增配置页：js/pages/ 下新建模块（export const page = { id, title, icon, render(el) }）
// 并在下方 import + PAGES 数组各加一行即可；后端 /js/* 静态服务自动覆盖新文件
import { S, $, esc, hooks, refresh } from './core.js';
import { initDrawer, isDrawerOpen, cancelDrawer, confirmDialog } from './ui.js';
import { initTheme } from './theme.js';
import { renderBootstrap } from './bootstrap.js';
import { page as pOverview } from './pages/overview.js';
import { page as pApps } from './pages/apps.js';
import { page as pWorkspaces } from './pages/workspaces.js';
import { page as pClaude } from './pages/claude.js';
import { page as pPermissions } from './pages/permissions.js';
import { page as pSlash } from './pages/slash.js';
import { page as pPlugins } from './pages/plugins.js';
import { page as pSkills } from './pages/skills.js';
import { page as pMcp } from './pages/mcp.js';

const PAGES = [pOverview, pApps, pWorkspaces, pClaude, pPermissions, pSlash, pPlugins, pSkills, pMcp];
const pageById = new Map(PAGES.map((p) => [p.id, p]));
const DEFAULT_TAB = 'overview';

// 菜单图标包装：内联 SVG 线性图标（Lucide 风格，stroke:currentColor 自动跟随选中态配色）
const ico = (inner) => `<span class="ico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg></span>`;

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

/** 页头（图标徽章 + 标题）：注入到 #main 顶部，页面本体渲染进 #pageBody */
const pageHeadHtml = (p) => `<div class="page-head"><span class="ico"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p.icon}</svg></span><h2>${p.title}</h2></div><div id="pageBody"></div>`;

function render() {
  renderNav();
  if (S.firstRun) return renderBootstrap($('#main')); // 首装向导：无论 hash 是什么都渲染向导
  const page = pageById.get(activeTab);
  $('#main').innerHTML = pageHeadHtml(page);
  void page.render($('#pageBody'));                  // fire-and-forget（plugins 页为 async，同旧版）
}

function renderNav() {
  $('#nav').innerHTML = PAGES.map((p) =>
    `<button data-k="${p.id}" class="${p.id === activeTab ? 'active' : ''}">${ico(p.icon)}<span>${p.title}</span></button>`).join('');
  $('#nav').querySelectorAll('button').forEach((b) =>
    b.onclick = () => void tryActivate(b.dataset.k));
}

/** nav 点击与 hashchange 的唯一汇聚点：确认 → 更新 activeTab + 同步 hash → 渲染 */
async function tryActivate(tab) {
  if (tab === activeTab) return; // nav 点击后写 hash 引发的 hashchange 在此早退（无双重渲染）
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
initTheme();               // 主题切换（跟随系统 / 亮色 / 暗色）
initDrawer();              // 抽屉全局监听（X / ESC / 点遮罩）一次性注册
refresh().catch((e) => { $('#main').innerHTML = `<div class="card"><h3>加载失败</h3><div class="desc">${esc(e.message)}</div></div>`; });
