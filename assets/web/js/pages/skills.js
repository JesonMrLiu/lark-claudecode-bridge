// ============ Skills 管理 ============
// 后端：GET /api/skills · POST /api/skills/action（create/delete）· POST /api/skills/import（zip）
// 四来源：用户级·本机（~/.claude/skills）/ 用户级·bridge（managed 生效目录）/ 项目级（工作区 .claude/skills）/
// 已装插件内（<plugin-installPath>/skills；plugin 只读，未启用时标「（未启用）」）。
// 搜索只匹配「名称 + 说明」两列；过滤只切换行显隐不重建 DOM（兼容中文输入法组合输入）。
// 远端 CRUD：改动即时落盘，无页内保存条。
import { $, esc, toast, api } from '../core.js';
import { openDrawer, closeDrawer, confirmDialog, promptDialog } from '../ui.js';
import { renderMarkdown } from '../markdown.js';

/** 来源标签（function：plugin 来源需要拼插件名与启用状态） */
const SOURCE_TAG = {
  'machine-user': '用户级 · 本机',
  bridge: '用户级 · bridge',
  project: '项目级',
};
const sourceTag = (s) => {
  if (s.source === 'project') return `项目级 · ${esc(s.workspaceName || '?')}`;
  if (s.source === 'plugin') return `插件 · ${esc(s.pluginName || '?')}${s.pluginEnabled ? '' : '（未启用）'}`;
  return SOURCE_TAG[s.source] || s.source;
};
const sourceTagClass = (s) => (s.source === 'bridge' ? 'info' : s.source === 'plugin' ? (s.pluginEnabled ? 'off' : 'warn') : 'ghost');
/** 来源是否可删（project / plugin 只读；其他用户级可删） */
const isDeletable = (s) => s.source !== 'project' && s.source !== 'plugin';

function renderSkills(el) {
  el.innerHTML = `
  <div class="panel">
    <header class="panel-head"><h3>技能列表</h3>
      <div class="panel-actions">
        <input type="search" id="skillSearch" placeholder="过滤：名称 / 说明…" style="width:210px;padding:4px 10px;font-size:12.5px">
        <button class="btn sm" id="skillImport">导入 zip</button>
        <button class="btn primary sm" id="skillAdd">＋ 新建</button>
      </div></header>
    <div class="panel-body">
      <input type="file" id="skillZipFile" accept=".zip" style="display:none">
      <table><thead><tr>
        <th style="width:220px">名字</th><th>说明</th><th style="width:190px">来源</th><th style="width:130px">操作</th>
      </tr></thead>
        <tbody id="skillBody"><tr><td colspan="4" class="hint">加载中…</td></tr></tbody>
      </table>
      <div class="mini-note" id="skillEffective" style="margin-top:10px"></div>
    </div>
    <footer class="panel-foot">新增 / 导入统一落盘用户级生效目录；项目级与插件内来源只读。改动即时生效。</footer>
  </div>`;
  $('#skillAdd').onclick = addSkill;
  bindSearch();
  bindZipImport();
  void loadSkills();
}

/** 搜索过滤：只匹配名称+说明；只切换 tr 显隐不重建 DOM；组合输入（中文 IME）期间暂停 */
function bindSearch() {
  const inp = $('#skillSearch');
  let composing = false;
  inp.addEventListener('compositionstart', () => { composing = true; });
  inp.addEventListener('compositionend', () => { composing = false; filterSkillRows(); });
  inp.oninput = () => { if (!composing) filterSkillRows(); };
}

/** 搜索过滤：遍历 tr.dataset.searchText 切换 hidden（关键词只命中名称与说明） */
function filterSkillRows() {
  const q = ($('#skillSearch').value || '').trim().toLowerCase();
  const body = $('#skillBody');
  if (!body) return;
  let shown = 0;
  for (const tr of body.querySelectorAll('tr[data-search-text]')) {
    const hit = !q || (tr.dataset.searchText || '').includes(q);
    tr.hidden = !hit;
    if (hit) shown++;
  }
  // 空状态行（无 data-search-text）展示原始文案
  const total = body.querySelectorAll('tr[data-search-text]').length;
  const empty = body.querySelector('tr.empty-row');
  if (empty) empty.hidden = q && shown > 0 ? true : false;
  // 实时同步计数到有效目录那行末尾
  const eff = $('#skillEffective');
  if (eff && eff.dataset.base) eff.textContent = `${eff.dataset.base} · 搜索结果 ${shown}/${total}`;
}

async function loadSkills() {
  const body = $('#skillBody');
  let data;
  try {
    data = await api('GET', '/api/skills');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" class="hint">加载失败：${esc(e.message)}</td></tr>`;
    return;
  }
  const eff = $('#skillEffective');
  // 诊断行：插件目录扫到 N 个已装插件，其中 M 个含 skill 定义（含 plugin 未启用）
  const stats = data.pluginStats;
  const diag = stats && stats.total > 0 ? ` · 插件目录扫到 ${stats.total} 个已装插件，其中 ${stats.withSkills} 个含 skill 定义` : '';
  if (eff) {
    eff.dataset.base = `新增 / 导入落盘目录（用户级生效目录）：${data.effectiveDir || ''}${diag}`;
    eff.textContent = eff.dataset.base;
  }
  const skills = data.skills || [];
  if (skills.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="4" class="empty">暂无 skill（四个来源均未发现 SKILL.md）<br><span class="mini-note">可点右上「＋ 新建」或「导入 zip」。</span></td></tr>`;
    return;
  }
  body.innerHTML = '';
  for (const s of skills) {
    const tr = document.createElement('tr');
    // 搜索只匹配名称 + 说明两列（路径/来源不参与，避免全字段模糊误命中）
    tr.dataset.searchText = `${s.name} ${s.description || ''}`.toLowerCase();
    tr.innerHTML = `
      <td><b>${esc(s.name)}</b>${s.path ? `<div class="mini-note" style="margin-top:2px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="完整目录：${esc(s.path)}"><code>${esc(s.path)}</code></div>` : ''}</td>
      <td>${esc(s.description) || '<span class="mut">（无说明）</span>'}</td>
      <td><span class="tag ${sourceTagClass(s)}">${sourceTag(s)}</span></td>
      <td class="ops">
        <button class="btn sm" data-browse="${esc(s.name)}">查看</button>
        ${isDeletable(s) ? `<button class="btn sm danger" data-del="${esc(s.name)}">删除</button>` : '<span class="dim" style="font-size:11.5px">只读</span>'}
      </td>`;
    tr.querySelector('[data-browse]').onclick = () => browseSkill(s);
    const delBtn = tr.querySelector('[data-del]');
    if (delBtn) delBtn.onclick = () => delSkill(s);
    body.appendChild(tr);
  }
  // 保留搜索框当前过滤（如刷新列表后保留关键字）
  filterSkillRows();
}

async function delSkill(s) {
  if (!(await confirmDialog({
    title: '删除 skill',
    message: `确定删除 skill <b>${esc(s.name)}</b>（${sourceTag(s)}）？该目录会被整体移除（不可恢复）。`,
    danger: true,
    confirmText: '删除',
  }))) return;
  api('POST', '/api/skills/action', { op: 'delete', name: s.name, source: s.source, workspaceName: s.workspaceName })
    .then(() => { toast('已删除'); void loadSkills(); })
    .catch((e) => toast(e.message, true));
}

// ---------- skill 文件浏览：目录树 + 原文/视图/双栏三种查看模式 ----------
// markdown 渲染走公共模块 ../markdown.js（与会话页 AI 气泡同源，含表格支持）

/** 浏览抽屉：左侧文件树（目录懒加载展开），右侧查看区（markdown 文件支持 原文/视图/两者 三模式） */
function browseSkill(s) {
  openDrawer({
    title: `${s.name} · ${sourceTag(s)}`,
    bodyHtml: `
      <div class="hint" style="margin:0 0 10px"><code>${esc(s.path)}</code></div>
      <div class="dw-layout fill">
        <nav class="dw-nav" id="sbTree" style="width:250px;min-height:0;border:1px solid var(--border);border-radius:10px;padding:8px;overflow:auto;font-size:13px">
          <span class="hint">目录加载中…</span>
        </nav>
        <div class="dw-pane">
          <div id="sbModes" style="display:none;gap:8px;margin-bottom:8px" class="subtabs">
            <button data-mode="view" class="active">只看视图</button>
            <button data-mode="raw">只看原文</button>
            <button data-mode="both">两者都看</button>
          </div>
          <div id="sbFileName" class="mini-note" style="margin-bottom:6px">点击左侧文件查看内容</div>
          <div id="sbView" style="display:none;flex:1;min-height:0;border:1px solid var(--border);border-radius:10px;padding:12px;overflow:auto;font-size:13px;line-height:1.6;background:var(--sunk)"></div>
          <textarea id="sbRaw" readonly style="display:none;width:100%;flex:1;min-height:0;font-family:var(--mono);font-size:12px"></textarea>
        </div>
      </div>`,
    footHtml: `<span class="sp"></span><button class="btn" data-act="close">关闭</button>`,
    onMount({ body, foot }) {
      foot.querySelector('[data-act="close"]').onclick = () => closeDrawer();
      body.classList.add('dw-fill'); // 抽屉体变纵向 flex：布局区撑满到底（closeDrawer 里清理）
      const tree = body.querySelector('#sbTree');
      const modes = body.querySelector('#sbModes');
      const fileName = body.querySelector('#sbFileName');
      const viewPane = body.querySelector('#sbView');
      const rawPane = body.querySelector('#sbRaw');
      let mode = 'view'; // 默认只看视图；同抽屉内连续查看文件时保留用户切换过的模式
      const isMd = (p) => /\.(md|markdown)$/i.test(p);
      const applyMode = () => {
        modes.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
        viewPane.style.display = mode === 'raw' ? 'none' : '';
        rawPane.style.display = mode === 'view' ? 'none' : '';
      };
      modes.querySelectorAll('[data-mode]').forEach((b) => {
        b.onclick = () => { mode = b.dataset.mode; applyMode(); };
      });
      const openFile = async (fp) => {
        fileName.textContent = `加载中：${fp}`;
        try {
          const r = await api('GET', `/api/skills/raw?path=${encodeURIComponent(fp)}`);
          fileName.innerHTML = `<b>${esc(r.name)}</b> <span class="dim">· ${(r.size / 1024).toFixed(1)}KB</span>`;
          rawPane.value = r.content;
          if (isMd(r.name)) {
            viewPane.innerHTML = renderMarkdown(r.content);
            modes.style.display = 'flex';
            applyMode(); // md：按当前模式（默认只看视图）
          } else {
            viewPane.innerHTML = `<pre style="margin:0;white-space:pre-wrap;font-size:12px">${esc(r.content)}</pre>`;
            modes.style.display = 'none';
            viewPane.style.display = '';
            rawPane.style.display = 'none'; // 非 md：格式化视图即原文等宽展示
          }
        } catch (e) {
          fileName.textContent = '';
          toast(e.message, true);
        }
      };
      const renderDir = async (dir, container) => {
        container.innerHTML = '<div class="hint" style="padding:2px 6px">加载中…</div>';
        let files;
        try {
          const r = await api('GET', `/api/skills/files?path=${encodeURIComponent(dir)}`);
          files = r.files || [];
        } catch (e) {
          container.innerHTML = `<div class="hint" style="padding:2px 6px;color:var(--err-tx)">${esc(e.message)}</div>`;
          return;
        }
        container.innerHTML = '';
        if (files.length === 0) {
          container.innerHTML = '<div class="hint" style="padding:2px 6px">（空目录）</div>';
          return;
        }
        for (const f of files) {
          const row = document.createElement('button');
          row.style.cssText = 'display:block;width:100%;text-align:left;border:0;background:none;font:inherit;line-height:1.5;cursor:pointer;padding:5px 9px;border-radius:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
          row.onmouseenter = () => { row.style.background = 'var(--pri-w)'; };
          row.onmouseleave = () => { if (!row.dataset.active) row.style.background = ''; };
          const childPath = `${dir.replace(/[\\/]+$/, '')}/${f.name}`;
          if (f.isDir) {
            row.textContent = `▸ 📁 ${f.name}`;
            let expanded = false;
            let childBox = null;
            row.onclick = async () => {
              expanded = !expanded;
              row.textContent = `${expanded ? '▾' : '▸'} 📁 ${f.name}`;
              if (expanded && !childBox) {
                childBox = document.createElement('div');
                childBox.style.marginLeft = '14px';
                row.after(childBox);
                await renderDir(childPath, childBox);
              } else if (childBox) {
                childBox.style.display = expanded ? '' : 'none';
              }
            };
          } else {
            row.textContent = `📄 ${f.name}`;
            row.title = `${f.name}（${(f.size / 1024).toFixed(1)}KB）`;
            row.onclick = () => {
              tree.querySelectorAll('[data-active]').forEach((x) => { delete x.dataset.active; x.style.background = ''; x.style.fontWeight = ''; });
              row.dataset.active = '1';
              row.style.background = 'var(--pri-w)';
              row.style.fontWeight = '600';
              void openFile(childPath);
            };
          }
          container.appendChild(row);
        }
      };
      void renderDir(s.path, tree);
    },
  });
}

function addSkill() {
  openDrawer({
    title: '新建 skill（用户级）',
    narrow: true,
    bodyHtml: `
      <label class="fld">名字（字母/数字/下划线/连字符，1-64 位）</label>
      <input type="text" id="nskName" placeholder="my-skill">
      <label class="fld">说明（frontmatter description）</label>
      <input type="text" id="nskDesc" placeholder="这个 skill 做什么、什么时候用">
      <div class="mini-note" style="margin-top:10px">创建后生成目录与 SKILL.md 模板，请到目录中补充正文与脚本。</div>`,
    footHtml: `<span class="sp"></span><button class="btn" data-act="cancel">取消</button><button class="btn primary" data-act="save">创建</button>`,
    onMount({ foot }) {
      foot.querySelector('[data-act="cancel"]').onclick = () => closeDrawer();
      foot.querySelector('[data-act="save"]').onclick = async () => {
        const name = $('#nskName').value.trim();
        const description = $('#nskDesc').value.trim();
        if (!name) return toast('请填写名字', true);
        try {
          await api('POST', '/api/skills/action', { op: 'create', name, description });
          toast('已创建（含默认 SKILL.md 模板）');
          closeDrawer();
          void loadSkills();
        } catch (e) { toast(e.message, true); }
      };
    },
  });
}

/** 导入 zip：兼容「根即 skill 目录」与「单层子目录」两种打包结构；根打包时弹名字输入 */
function bindZipImport() {
  const fileInput = $('#skillZipFile');
  $('#skillImport').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // 允许连续导入同名文件
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast('zip 超过 10MB 上限', true);
    const buf = await file.arrayBuffer();
    const zipBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    // 根打包（无子目录层级）时后端拿不到名字，先问一次；目录打包可留空由后端取名
    const guess = file.name.replace(/\.zip$/i, '');
    const name = (await promptDialog({
      title: '导入 skill',
      message: `zip 内含目录结构时可留空（将取目录名）；根打包时必填。建议：${esc(guess)}`,
      placeholder: 'skill 名（可留空）',
      confirmText: '导入',
    })) ?? '';
    try {
      const r = await api('POST', '/api/skills/import', { zipBase64, name: name.trim() || undefined });
      toast(`已导入 "${r.name}"（${r.files} 个文件）`);
      void loadSkills();
    } catch (e) { toast(`导入失败：${e.message}`, true); }
  };
}

export const page = {
  id: 'skills',
  title: 'Skills',
  desc: '四个来源的技能聚合：本机 / bridge / 项目 / 插件（只读）',
  legend: false,
  icon: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  render: renderSkills,
};
