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
      <th style="width:170px">名字</th><th>说明</th><th style="width:130px">来源</th><th style="width:240px">路径</th><th style="width:50px"></th>
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
      <td>${isDeletable(s) ? `<button class="btn sm danger" data-del="${esc(s.name)}">删</button>` : '<span class="desc">只读</span>'}</td>`;
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
