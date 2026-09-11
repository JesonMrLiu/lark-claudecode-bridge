// ============ 主题切换：跟随系统 / 亮色 / 暗色（顶栏分段控件，localStorage 持久化） ============
// data-theme 写在 <html> 上：auto = 不设属性（CSS 媒体查询接管）；light/dark = 手动覆盖
const KEY = 'lcb-theme';
const mq = window.matchMedia('(prefers-color-scheme: dark)');
let current = 'auto';

const apply = (mode) => {
  current = mode;
  try { localStorage.setItem(KEY, mode); } catch { /* 隐私模式等写入失败可容忍 */ }
  const root = document.documentElement;
  if (mode === 'auto') delete root.dataset.theme;
  else root.dataset.theme = mode;
  document.querySelectorAll('#themeSwitch button').forEach((b) =>
    b.classList.toggle('active', b.dataset.opt === mode));
};

/** main.js 启动时调用一次：恢复上次选择 + 绑定切换 + auto 模式跟随系统变化 */
export function initTheme() {
  apply(localStorage.getItem(KEY) || 'auto');
  mq.addEventListener('change', () => { if (current === 'auto') apply('auto'); }); // 仅为刷新 active 态展示
  document.querySelectorAll('#themeSwitch button').forEach((b) =>
    b.onclick = () => apply(b.dataset.opt));
}
