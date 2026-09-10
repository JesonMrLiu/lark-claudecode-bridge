// ============ Skills 管理页（#12）============
// 后端：GET /api/skills · POST /api/skills/action（create/delete）· POST /api/skills/import（zip）
// 四来源：用户级·本机（~/.claude/skills）/ 用户级·bridge（managed 生效目录）/ 项目级（工作区 .claude/skills）/
// 已装插件内（<plugin-installPath>/skills；plugin 只读，未启用时标「（未启用）」）。
// 远端 CRUD：改动即时落盘，无页内保存条
import { $, esc, toast, api } from '../core.js';
import { openDrawer, closeDrawer } from '../ui.js';

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
/** 来源是否可删（project / plugin 只读；其他用户级可删） */
const isDeletable = (s) => s.source !== 'project' && s.source !== 'plugin';

function renderSkills(el) {
  el.innerHTML = `
  <div class="card">
    <h3>Skills</h3>
    <div class="desc">Claude Code 技能（每项一个目录，含 SKILL.md）。列表聚合四个来源：本机用户级、bridge 自管用户级、各工作区项目级、已装插件内的 skills（只读展示）。新增（含 zip 导入）统一进用户级生效目录。</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:10px">
      <button class="btn sm" id="skillImport">📦 导入 zip</button>
      <button class="btn sm" id="skillAdd">+ 新建</button>
    </div>
    <input type="file" id="skillZipFile" accept=".zip" style="display:none">
    <input type="search" id="skillSearch" placeholder="🔍 按名字 / 来源 / 路径过滤…" style="width:100%;padding:7px 10px;margin-bottom:8px;border:1px solid var(--border);border-radius:7px">
    <table><thead><tr>
      <th style="width:170px">名字</th><th>说明</th><th style="width:130px">来源</th><th style="width:240px">路径</th><th style="width:110px"></th>
    </tr></thead>
      <tbody id="skillBody"><tr><td colspan="5" class="desc">加载中…</td></tr></tbody>
    </table>
    <div class="desc" id="skillEffective" style="margin-top:10px"></div>
  </div>`;
  $('#skillAdd').onclick = addSkill;
  $('#skillSearch').oninput = filterSkillRows;
  bindZipImport();
  void loadSkills();
}

/** 搜索过滤：遍历 tr.dataset.searchText 切换 hidden */
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
    body.innerHTML = `<tr><td colspan="5" class="desc">加载失败：${esc(e.message)}</td></tr>`;
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
    body.innerHTML = `<tr class="empty-row"><td colspan="5" class="desc">暂无 skill（四个来源均未发现 SKILL.md）。可点上方「+ 新建」或「📦 导入 zip」。</td></tr>`;
    return;
  }
  body.innerHTML = '';
  for (const s of skills) {
    const tag = sourceTag(s);
    const tr = document.createElement('tr');
    tr.dataset.searchText = `${s.name} ${sourceTag(s)} ${s.path} ${s.description || ''}`.toLowerCase();
    tr.innerHTML = `
      <td><strong>${esc(s.name)}</strong></td>
      <td>${esc(s.description) || '<span class="desc">（无说明）</span>'}</td>
      <td><span class="chip">${tag}</span></td>
      <td><code class="desc">${esc(s.path)}</code></td>
      <td>
        <button class="btn sm" data-browse="${esc(s.name)}">📂 浏览</button>
        ${isDeletable(s) ? `<button class="btn sm danger" data-del="${esc(s.name)}">删</button>` : ''}
      </td>`;
    tr.querySelector('[data-browse]').onclick = () => browseSkill(s);
    const delBtn = tr.querySelector('[data-del]');
    if (delBtn) delBtn.onclick = () => delSkill(s);
    body.appendChild(tr);
  }
  // 保留搜索框当前过滤（如刷新列表后保留关键字）
  filterSkillRows();
}

function delSkill(s) {
  if (!confirm(`删除 skill "${s.name}"（${sourceTag(s)}）？该目录会被整体移除（不可恢复）。`)) return;
  api('POST', '/api/skills/action', { op: 'delete', name: s.name, source: s.source, workspaceName: s.workspaceName })
    .then(() => { toast('已删除'); void loadSkills(); })
    .catch((e) => toast(e.message, true));
}

// ---------- skill 文件浏览（#3）：目录树 + 原文/视图/双栏三种查看模式 ----------

/** 极简 markdown → HTML（先整体转义再还原语法，绝无 XSS 面）：标题/代码块/行内代码/粗斜体/列表/引用/链接/分割线 */
function renderMarkdown(src) {
  const codeBlocks = [];
  let text = String(src).replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    codeBlocks.push(`<pre style="background:#f6f8fa;border:1px solid var(--border);border-radius:8px;padding:10px;overflow:auto;font-size:12px"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `${codeBlocks.length - 1}`;
  });
  const lines = text.split('\n');
  const out = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code style="background:#f6f8fa;padding:1px 5px;border-radius:4px;font-size:12px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--primary)">$1</a>');
  for (const line of lines) {
    const block = /^ (\d+) $/.exec(line);
    if (block) { closeList(); out.push(codeBlocks[Number(block[1])]); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); const lv = h[1].length; out.push(`<h${lv + 1} style="margin:12px 0 6px">${inline(h[2])}</h${lv + 1}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!listOpen) { out.push('<ul style="margin:4px 0;padding-left:22px">'); listOpen = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (!listOpen) { out.push('<ul style="margin:4px 0;padding-left:22px">'); listOpen = true; }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`);
      continue;
    }
    closeList();
    if (/^---+\s*$/.test(line)) { out.push('<hr style="border:none;border-top:1px solid var(--border);margin:10px 0">'); continue; }
    if (/^>\s?/.test(line)) { out.push(`<blockquote style="margin:6px 0;padding:4px 12px;border-left:3px solid var(--border);color:var(--muted,#667)">${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (line.trim() === '') { out.push(''); continue; }
    out.push(`<p style="margin:4px 0">${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

/** 浏览抽屉：左侧文件树（目录懒加载展开），右侧查看区（markdown 文件支持 原文/视图/两者 三模式） */
function browseSkill(s) {
  openDrawer({
    title: `📂 ${s.name} · ${sourceTag(s)}`,
    bodyHtml: `
      <div class="hint" style="margin:0 0 10px"><code class="desc">${esc(s.path)}</code></div>
      <div style="display:flex;gap:14px;align-items:flex-start">
        <div id="sbTree" style="width:250px;flex:none;border:1px solid var(--border);border-radius:8px;padding:8px;max-height:62vh;overflow:auto;font-size:13px">
          <div class="desc">目录加载中…</div>
        </div>
        <div style="flex:1;min-width:0">
          <div id="sbModes" style="display:none;gap:8px;margin-bottom:8px" class="subtabs">
            <button data-mode="both" class="active">两者都看</button>
            <button data-mode="raw">只看原文</button>
            <button data-mode="view">只看视图</button>
          </div>
          <div id="sbFileName" class="desc" style="margin-bottom:6px">点击左侧文件查看内容</div>
          <div id="sbView" style="display:none;border:1px solid var(--border);border-radius:8px;padding:12px;max-height:56vh;overflow:auto;font-size:13px;line-height:1.6"></div>
          <textarea id="sbRaw" readonly style="display:none;width:100%;min-height:56vh;font-family:ui-monospace,Consolas,monospace;font-size:12px"></textarea>
        </div>
      </div>`,
    footHtml: `<button class="btn" data-act="close">关闭</button>`,
    onMount({ body, foot }) {
      foot.querySelector('[data-act="close"]').onclick = () => closeDrawer();
      const tree = body.querySelector('#sbTree');
      const modes = body.querySelector('#sbModes');
      const fileName = body.querySelector('#sbFileName');
      const viewPane = body.querySelector('#sbView');
      const rawPane = body.querySelector('#sbRaw');
      let mode = 'both';
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
          fileName.innerHTML = `<strong>${esc(r.name)}</strong> <span class="desc">· ${(r.size / 1024).toFixed(1)}KB</span>`;
          rawPane.value = r.content;
          if (isMd(r.name)) {
            viewPane.innerHTML = renderMarkdown(r.content);
            modes.style.display = 'flex';
            applyMode(); // md：按当前模式（默认两者都看）
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
        container.innerHTML = '<div class="desc" style="padding:2px 6px">加载中…</div>';
        let files;
        try {
          const r = await api('GET', `/api/skills/files?path=${encodeURIComponent(dir)}`);
          files = r.files || [];
        } catch (e) {
          container.innerHTML = `<div class="desc" style="padding:2px 6px;color:#dc2626">${esc(e.message)}</div>`;
          return;
        }
        container.innerHTML = '';
        if (files.length === 0) {
          container.innerHTML = '<div class="desc" style="padding:2px 6px">（空目录）</div>';
          return;
        }
        for (const f of files) {
          const row = document.createElement('div');
          row.style.cssText = 'padding:3px 6px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
          row.onmouseenter = () => { row.style.background = '#f2f5fa'; };
          row.onmouseleave = () => { row.style.background = ''; };
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
              row.style.background = '#eef3ff';
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
    bodyHtml: `
      <label>名字（字母/数字/下划线/连字符，1-64 位）</label>
      <input type="text" id="nskName" placeholder="my-skill">
      <label>说明（frontmatter description）</label>
      <input type="text" id="nskDesc" placeholder="这个 skill 做什么、什么时候用">
      <div class="hint" style="margin-top:10px">创建后生成目录与 SKILL.md 模板，请到目录中补充正文与脚本。</div>`,
    footHtml: `<button class="btn" data-act="cancel">取消</button><button class="btn primary" data-act="save">创建</button>`,
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
    const name = prompt(`skill 名（zip 内含目录结构时可留空，将取目录名；根打包时必填。建议：${guess})`, '') ?? '';
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
  icon: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  render: renderSkills,
};
