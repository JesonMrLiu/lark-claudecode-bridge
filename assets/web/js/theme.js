// ============ 主题切换：亮 / 暗单按钮（原型同款），localStorage 持久化 ============
import { $ } from './core.js';

const KEY = 'lcb-theme';

const IC_SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.3 11.3 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.3-11.3 1.4-1.4"/>';
const IC_MOON = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
const svg = (inner) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#themeBtn');
  if (btn) btn.innerHTML = svg(theme === 'dark' ? IC_SUN : IC_MOON); // 暗色时显示「切回亮色」的太阳
}

/** main.js 启动时调用一次：恢复上次选择 + 绑定切换 */
export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* 隐私模式等：读失败按默认 */ }
  apply(saved === 'dark' ? 'dark' : 'light');
  $('#themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem(KEY, next); } catch { /* 写失败可容忍 */ }
  };
}
