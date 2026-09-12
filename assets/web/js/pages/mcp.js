// ============ MCP 管理页（#12）============
// 后端：GET /api/mcp · POST /api/mcp/action（add/update/remove）· POST /api/mcp/check（状态探测）
// 四来源：bridge 自管（mcp/servers.json，页面管理 + 注入生效）/ 用户级·本机（~/.claude.json，展示+可删）/
// 项目级（工作区 .mcp.json，只读）/ 已装插件内（<plugin-installPath>/.mcp.json，只读；未启用时标「（未启用）」）。
import { $, esc, toast, api } from '../core.js';
import { openDrawer, closeDrawer, confirmDialog } from '../ui.js';

const SOURCE_TAG = {
  bridge: 'bridge · 可管理',
  'machine-user': '用户级 · 本机',
  project: '项目级',
};
const sourceTag = (s) => {
  if (s.source === 'project') return `项目级 · ${esc(s.workspaceName || '?')}`;
  if (s.source === 'plugin') return `插件 · ${esc(s.pluginName || '?')}${s.pluginEnabled ? '' : '（未启用）'}`;
  return SOURCE_TAG[s.source] || s.source;
};
/** 来源是否可删（project / plugin 只读） */
const isDeletable = (s) => s.source !== 'project' && s.source !== 'plugin';

function renderMcp(el) {
  el.innerHTML = `
  <div class="card">
    <h3>MCP Servers</h3>
    <div class="desc">stdio 走 command + args（本地进程），http/sse 走 url（远程服务）。页面添加的配置存 bridge 自管目录（见下方路径），运行中的任务即时生效；本机 ~/.claude.json 与工作区 .mcp.json 为只读来源（前者可删）；已装插件内 .mcp.json 或 plugin.json 内 mcpServers 字段只读展示。</div>
    <div class="list-toolbar">
      <button class="btn" id="mcpRefresh">刷新</button>
      <button class="btn primary" id="mcpAdd">+ 添加 MCP</button>
    </div>
    <input type="search" class="list-search" id="mcpSearch" placeholder="按名字 / 来源 / 类型 / URL 过滤…">
    <table><thead><tr>
      <th style="width:150px">名字</th><th>类型 / 连接</th><th style="width:130px">来源</th><th style="width:130px">状态</th><th style="width:130px"></th>
    </tr></thead>
      <tbody id="mcpBody"><tr><td colspan="5" class="desc">加载中…</td></tr></tbody>
    </table>
    <div class="desc" id="mcpBridgePath" style="margin-top:10px"></div>
  </div>`;
  $('#mcpRefresh').onclick = () => void loadMcp();
  $('#mcpAdd').onclick = addMcp;
  $('#mcpSearch').oninput = filterMcpRows;
  void loadMcp();
}

/** 搜索过滤：遍历 tr.dataset.searchText 切换 hidden */
function filterMcpRows() {
  const q = ($('#mcpSearch').value || '').trim().toLowerCase();
  const body = $('#mcpBody');
  if (!body) return;
  let shown = 0;
  for (const tr of body.querySelectorAll('tr[data-search-text]')) {
    const hit = !q || (tr.dataset.searchText || '').includes(q);
    tr.hidden = !hit;
    if (hit) shown++;
  }
  const total = body.querySelectorAll('tr[data-search-text]').length;
  const bp = $('#mcpBridgePath');
  if (bp && bp.dataset.base) bp.textContent = `${bp.dataset.base} · 搜索结果 ${shown}/${total}`;
}

async function loadMcp() {
  const body = $('#mcpBody');
  let data;
  try {
    data = await api('GET', '/api/mcp');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" class="desc">加载失败：${esc(e.message)}</td></tr>`;
    return;
  }
  const bp = $('#mcpBridgePath');
  // 诊断行：插件目录扫到 N 个已装插件，其中 M 个含 MCP 定义（plugin.json 内嵌或 .mcp.json 独立）
  const stats = data.pluginStats;
  const diag = stats && stats.total > 0 ? ` · 插件目录扫到 ${stats.total} 个已装插件，其中 ${stats.withMcp} 个含 MCP server 定义` : '';
  if (bp) {
    bp.dataset.base = `bridge 自管配置文件（页面添加落这里）：${data.bridgePath || ''}${diag}`;
    bp.textContent = bp.dataset.base;
  }
  const servers = data.servers || [];
  if (servers.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5" class="desc">暂无 MCP server。可点「+ 添加 MCP」或在终端用 claude mcp add 添加（本机用户级会出现在此列表）。</td></tr>`;
    return;
  }
  body.innerHTML = '';
  for (const s of servers) {
    const conn = s.config.type === 'http' || s.config.type === 'sse'
      ? `${esc(String(s.config.type))} · ${esc(String(s.config.url ?? ''))}`
      : `${esc(String(s.config.type ?? 'stdio'))} · ${esc(String(s.config.command ?? ''))}${s.config.args ? ' ' + esc(JSON.stringify(s.config.args)) : ''}`;
    const tag = sourceTag(s);
    const tr = document.createElement('tr');
    tr.dataset.searchText = `${s.name} ${sourceTag(s)} ${conn} ${s.config.url ?? ''} ${s.config.command ?? ''}`.toLowerCase();
    tr.innerHTML = `
      <td><strong>${esc(s.name)}</strong></td>
      <td>${conn}</td>
      <td><span class="chip">${tag}</span></td>
      <td class="mcp-status" data-status-for="${esc(s.name)}"><span class="desc">未检测</span></td>
      <td class="ops">
        <button class="btn sm" data-view="${esc(s.name)}">查看</button>
        ${isDeletable(s) ? `<button class="btn sm danger" data-del="${esc(s.name)}">删除</button>` : '<span class="desc">只读</span>'}
      </td>`;
    tr.querySelector('[data-view]').onclick = () => viewMcp(s);
    const delBtn = tr.querySelector('[data-del]');
    if (delBtn) delBtn.onclick = () => delMcp(s);
    // 状态检测按钮放状态列内（点谁检谁，不自动批量探测）
    const statusCell = tr.querySelector('[data-status-for]');
    statusCell.onclick = () => void checkMcp(s, statusCell);
    statusCell.style.cursor = 'pointer';
    statusCell.title = '点击检测';
    body.appendChild(tr);
  }
  // 保留搜索框当前过滤（如刷新列表后保留关键字）
  filterMcpRows();
}

async function checkMcp(s, cell) {
  cell.innerHTML = '<span class="desc">检测中…</span>';
  try {
    const r = await api('POST', '/api/mcp/check', { name: s.name, source: s.source, workspaceName: s.workspaceName });
    const map = {
      ok: `<span style="color:var(--ok-tx)">✔ 正常</span>`,
      failed: `<span style="color:var(--err-tx)">✘ 异常</span>`,
      unreachable: `<span style="color:var(--warn-tx)">⚠ 不可达</span>`,
    };
    cell.innerHTML = `${map[r.status] || esc(r.status)}<div class="desc" style="font-size:11px;white-space:normal">${esc(r.detail || '')}</div>`;
  } catch (e) {
    cell.innerHTML = `<span style="color:var(--err-tx)">检测失败</span>`;
    toast(e.message, true);
  }
}

async function delMcp(s) {
  if (!(await confirmDialog({
    title: '删除 MCP server',
    message: `确定删除 MCP server <b>${esc(s.name)}</b>（${sourceTag(s)}）？删除后引用它的任务将无法启动该 server。`,
    danger: true,
    confirmText: '删除',
  }))) return;
  api('POST', '/api/mcp/action', { op: 'remove', name: s.name, source: s.source })
    .then(() => { toast('已删除'); void loadMcp(); })
    .catch((e) => toast(e.message, true));
}

/** 抽屉查看：完整配置 JSON + env 表（${VAR}/${VAR:-default} 引用已按多来源合并展开；未设置的变量标红）。
 *  bridge 来源支持「编辑」：JSON 原文可改，保存走 op:update（任务级热生效，无须重启） */
function viewMcp(s) {
  const envKeys = Object.keys(s.config.env || {});
  const envRows = envKeys.length
    ? envKeys.map((k) => {
      const missing = (s.missingEnv || []).includes(k) || ((s.resolvedEnv || {})[k] || '').includes('${');
      const raw = String((s.config.env || {})[k] ?? '');
      const cur = (s.resolvedEnv || {})[k] ?? raw;
      return `<tr><td><code>${esc(k)}</code></td><td><code class="desc">${esc(raw)}</code></td>
        <td>${missing ? `<span style="color:var(--err-tx)">未设置（${esc(cur)}）</span>` : `<code>${esc(cur)}</code>`}</td></tr>`;
    }).join('')
    : `<tr><td colspan="3" class="desc">（无 env 配置）</td></tr>`;
  const onlyRead = !isDeletable(s);
  const editable = s.source === 'bridge'; // 后端 op:update 只写 bridge servers.json；machine-user 只能删
  openDrawer({
    title: `MCP · ${s.name}`,
    bodyHtml: `
      <div class="hint" style="margin:0 0 8px">来源：${sourceTag(s)} · 配置文件：<code class="desc">${esc(s.path)}</code></div>
      ${onlyRead ? `<div class="hint" style="margin:0 0 8px;color:var(--warn-tx)">只读来源——此 MCP 由 ${s.source === 'plugin' ? '插件' : '项目'}自带，编辑请前往 ${s.source === 'plugin' ? '插件目录' : '对应工作区目录'}手动修改。</div>` : ''}
      ${!editable && !onlyRead ? `<div class="hint" style="margin:0 0 8px;color:var(--warn-tx)">用户级·本机来源不支持页面编辑（可删除）；如需修改请在 ~/.claude.json 手动改，或删除后到本页重新添加。</div>` : ''}
      <div data-pane="view">
        <label>配置（JSON 原文）</label>
        <textarea readonly rows="10" style="min-height:140px">${esc(JSON.stringify(s.config, null, 2))}</textarea>
      </div>
      <div data-pane="edit" style="display:none">
        <label>配置（JSON，可编辑——env 也在其中改）</label>
        <textarea id="emJson" rows="12" style="min-height:180px">${esc(JSON.stringify(s.config, null, 2))}</textarea>
        <div class="hint" style="margin-top:6px">保存后立即对新任务生效（bridge 自管 servers.json 每任务现读）。</div>
      </div>
      <label>环境变量（引用值 → 当前值；当前值已合并 飞书应用 env › Claude 认证 env › settings.json env › 系统环境，支持 \${VAR:-默认值}）</label>
      <table><thead><tr><th style="width:130px">变量</th><th>配置值</th><th>当前值</th></tr></thead><tbody>${envRows}</tbody></table>`,
    footHtml: `${editable ? '<button class="btn" data-act="edit">编辑</button><button class="btn primary" data-act="save" style="display:none">保存</button>' : ''}<button class="btn" data-act="close">关闭</button>`,
    onMount({ body, foot }) {
      foot.querySelector('[data-act="close"]').onclick = () => closeDrawer();
      const editBtn = foot.querySelector('[data-act="edit"]');
      const saveBtn = foot.querySelector('[data-act="save"]');
      if (editBtn) {
        editBtn.onclick = () => {
          body.querySelector('[data-pane="view"]').style.display = 'none';
          body.querySelector('[data-pane="edit"]').style.display = '';
          editBtn.style.display = 'none';
          saveBtn.style.display = '';
        };
        saveBtn.onclick = async () => {
          const raw = body.querySelector('#emJson').value.trim();
          let config;
          try { config = JSON.parse(raw); } catch (e) { return toast(`JSON 解析失败：${e.message}`, true); }
          try {
            await api('POST', '/api/mcp/action', { op: 'update', name: s.name, config });
            toast('已保存（任务级热生效，无须重启）');
            closeDrawer();
            void loadMcp();
          } catch (e) { toast(e.message, true); }
        };
      }
    },
  });
}

/** 添加 MCP：两个 tab——原生命令（claude mcp add …）粘贴即加 / JSON 配置 */
function addMcp() {
  openDrawer({
    title: '添加 MCP（存 bridge 自管目录，任务即时生效）',
    bodyHtml: `
      <div class="subtabs" style="margin-bottom:10px">
        <button class="active" data-tab="cmd">原生命令</button>
        <button data-tab="json">JSON 配置</button>
      </div>
      <div data-panel="cmd">
        <label>粘贴 claude mcp add 命令（自动解析 command / args / env / header / url）</label>
        <textarea id="amCmd" rows="4" placeholder='claude mcp add my-mcp -e API_KEY=xxx -- npx -y @scope/mcp-server&#10;claude mcp add my-mcp -t http -H "Authorization: Bearer xxx" https://example.com/mcp&#10;claude mcp add-json my-mcp {"type":"http","url":"https://…"}'></textarea>
        <div class="hint" style="margin-top:8px">名字取命令第 4 个参数；scope（-s）忽略——统一存 bridge 目录。</div>
      </div>
      <div data-panel="json" style="display:none">
        <label>名字</label>
        <input type="text" id="amName" placeholder="my-mcp">
        <label>配置 JSON</label>
        <textarea id="amJson" rows="6" placeholder='stdio：{"type":"stdio","command":"npx","args":["-y","mcp-server-foo"],"env":{"KEY":"val"}}&#10;http：{"type":"http","url":"https://example.com/mcp"}'></textarea>
      </div>`,
    footHtml: `<button class="btn" data-act="cancel">取消</button><button class="btn primary" data-act="save">添加</button>`,
    onMount({ body, foot }) {
      body.querySelectorAll('.subtabs [data-tab]').forEach((b) => {
        b.onclick = () => {
          body.querySelectorAll('.subtabs [data-tab]').forEach((x) => x.classList.toggle('active', x === b));
          const t = b.dataset.tab;
          body.querySelector('[data-panel="cmd"]').style.display = t === 'cmd' ? '' : 'none';
          body.querySelector('[data-panel="json"]').style.display = t === 'json' ? '' : 'none';
        };
      });
      foot.querySelector('[data-act="cancel"]').onclick = () => closeDrawer();
      foot.querySelector('[data-act="save"]').onclick = async () => {
        const cmdTab = body.querySelector('[data-panel="cmd"]').style.display !== 'none';
        try {
          if (cmdTab) {
            const command = $('#amCmd').value.trim();
            if (!command) return toast('请粘贴 claude mcp add 命令', true);
            // 名字由后端从命令解析校验（表单不重复输入）；先取第 4 段预校验存在性
            const nameGuess = command.split(/\s+/)[3] || '';
            if (!nameGuess) return toast('命令中缺少名字（claude mcp add <名字> …）', true);
            await api('POST', '/api/mcp/action', { op: 'add', name: nameGuess, command });
          } else {
            const name = $('#amName').value.trim();
            const raw = $('#amJson').value.trim();
            if (!name) return toast('请填写名字', true);
            if (!raw) return toast('请填写配置 JSON', true);
            let config;
            try { config = JSON.parse(raw); } catch (e) { return toast(`JSON 解析失败：${e.message}`, true); }
            await api('POST', '/api/mcp/action', { op: 'add', name, config });
          }
          toast('已添加（任务级热生效，无须重启）');
          closeDrawer();
          void loadMcp();
        } catch (e) { toast(e.message, true); }
      };
    },
  });
}

export const page = {
  id: 'mcp',
  title: 'MCP',
  icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l2.8 2.8m8.4 8.4L19 19M19 5l-2.8 2.8M7.8 16.2L5 19"/>',
  render: renderMcp,
};
