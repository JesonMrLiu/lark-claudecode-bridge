// ============ 应用（列表 + 抽屉编辑；输入实时写回 S.doc.apps，抽屉「保存」一次落盘） ============
import { S, $, esc, toast, snapDoc, saveDoc } from '../core.js';
import { openDrawer, closeDrawer, cancelDrawer, confirmDialog } from '../ui.js';

function renderApps(el) {
  const apps = S.doc.apps || (S.doc.apps = []);
  el.innerHTML = `
  <div class="card">
    <h3>飞书应用（机器人）</h3>
    <div class="desc">每个应用一条独立长连接与会话池。点击行或「编辑」在抽屉中配置；App Secret 已脱敏，留空 = 保持不变。凭证 / 名称 / 域名 / 默认工作区 / 并发 / 人格 / 环境变量改动需重启 lcb start；触发词与显式插件热生效。</div>
    <div class="list-toolbar">
      <button class="btn primary" id="addApp">+ 新增应用</button>
    </div>
    <table>
      <thead><tr><th>名称</th><th>App ID</th><th style="width:80px">域名</th><th>默认工作区</th><th style="width:110px">状态</th><th style="width:64px"></th></tr></thead>
      <tbody id="appsBody"></tbody>
    </table>
    <div class="footer-note">⚠️ 应用段改动需重启 lcb start 后生效（触发词 / 显式插件除外，下一条消息自动生效）。</div>
  </div>`;
  const statusTag = (app) => {
    const st = S.status?.apps?.find((s) => s.name === (app.name || app.app_id))?.started;
    return st === true ? '<span class="tag ok">运行中</span>'
      : st === false ? '<span class="tag err">启动失败</span>'
      : '<span class="tag off">未随本页启动</span>';
  };
  $('#appsBody').innerHTML = apps.map((app, i) => `
    <tr data-i="${i}" style="cursor:pointer">
      <td><b>${esc(app.name || app.app_id || '（未命名）')}</b></td>
      <td><code>${esc(app.app_id || '')}</code></td>
      <td>${esc(app.domain === 'lark' ? 'lark' : 'feishu')}</td>
      <td>${esc(app.default_workspace || '（全局默认）')}</td>
      <td>${statusTag(app)}</td>
      <td><button class="btn sm">编辑</button></td>
    </tr>`).join('');
  $('#appsBody').querySelectorAll('tr').forEach((tr) =>
    tr.onclick = () => openAppDrawer(apps, Number(tr.dataset.i), el));
  $('#addApp').onclick = () => {
    const snap = snapDoc(); // 快照先于 push：取消时连同新增空行一起回滚
    apps.push({ app_id: '', app_secret: '' });
    renderApps(el);
    openAppDrawer(apps, apps.length - 1, el, snap);
  };
}

/**
 * 应用编辑抽屉：输入实时 mutate app 对象，「保存」PUT 落盘（applySecrets / 注文保护链路零改动）。
 * secret 语义逐字保留：非空 = 明文写入；空 = 保持脱敏对象（PUT 端按 app_id 回填磁盘现值）。
 * 「取消」/ X / ESC = 回滚到打开前快照（新增未保存的应用行一并撤销）。
 */
function openAppDrawer(apps, idx, el, snap) {
  const app = apps[idx];
  const secret = app.app_secret || {};
  const wsNames = (S.doc.workspaces || []).map((w) => w.name || '').filter(Boolean);
  const globalDef = S.doc.defaults?.workspace || '';
  openDrawer({
    title: `应用：${app.name || app.app_id || '（新应用）'}`,
    snap: snap ?? snapDoc(),
    bodyHtml: `
      <div class="row">
        <div><label>应用名字（概览页与飞书 /status 显示用，缺省取 App ID）</label>
          <input type="text" data-f="name" value="${esc(app.name || '')}" placeholder="素材收集"></div>
        <div><label>App ID</label>
          <input type="text" data-f="app_id" value="${esc(app.app_id || '')}" placeholder="cli_…"></div>
      </div>
      <label>App Secret ${secret.secretSet ? `（已设置 ${esc(secret.secretHint)}，留空不改）` : ''}</label>
      <input type="password" data-f="app_secret" placeholder="${secret.secretSet ? '••••••••（留空保持不变）' : '未设置'}">
      <div class="row">
        <div><label>域名</label><select data-f="domain">
          <option value="" ${!app.domain || app.domain === 'feishu' ? 'selected' : ''}>feishu（国内）</option>
          <option value="lark" ${app.domain === 'lark' ? 'selected' : ''}>lark（国际）</option>
        </select></div>
        <div><label>默认工作区${globalDef ? `（缺省用全局默认：${esc(globalDef)}）` : '（缺省用全局默认）'}</label>
          <select data-f="default_workspace">
            <option value="" ${!app.default_workspace ? 'selected' : ''}>（全局默认）</option>
            ${wsNames.map((n) => `<option value="${esc(n)}" ${app.default_workspace === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
          </select></div>
        <div><label>并发上限（1-100）</label>
          <input type="number" data-f="concurrency" min="1" max="100" value="${esc(app.concurrency ?? '')}" placeholder="缺省用全局"></div>
      </div>
      <label>人格补充（追加到该机器人每个会话的 system prompt，多机器人差异化定位；改动需重启生效）</label>
      <textarea data-f="append_system_prompt" placeholder="你是一个素材收集助手…">${esc(app.append_system_prompt || '')}</textarea>
      <h4 style="margin:18px 0 2px;font-size:13.5px">触发词（命中即改写消息后再发给 Claude；下一条消息热生效）</h4>
      <div class="hint" style="margin-bottom:6px">match 以 <code>/</code> 开头 = 消息首词精确匹配，否则 = 关键词包含；rewrite 可用 <code>{text}</code>=原文全文、<code>{args}</code>=首词后的参数；本地命令（/stop 等）不受影响；按序首个命中生效。</div>
      <table><thead><tr><th style="width:42%">match</th><th>rewrite</th><th style="width:44px"></th></tr></thead><tbody data-list="triggers"></tbody></table>
      <button class="btn sm" data-add="triggers" style="margin-top:6px">+ 添加规则</button>
      <h4 style="margin:18px 0 2px;font-size:13.5px">显式插件（本地插件源码目录；同名优先于 ~/.claude 自动发现；热生效）</h4>
      <div class="hint" style="margin-bottom:6px">须为包含 <code>.claude-plugin/plugin.json</code> 的目录；一般用户无须配置，多用于开发期直指源码。</div>
      <table><thead><tr><th style="width:30%">name</th><th>path</th><th style="width:44px"></th></tr></thead><tbody data-list="plugins"></tbody></table>
      <button class="btn sm" data-add="plugins" style="margin-top:6px">+ 添加插件</button>
      <h4 style="margin:18px 0 2px;font-size:13.5px">环境变量（注入该机器人 Claude 子进程，覆盖本机同名值；改动需重启生效）</h4>
      <div class="hint" style="margin-bottom:6px">~/.claude/settings.json 已配置的键会被 CLI 自身应用且优先，无须在此重复。</div>
      <table><thead><tr><th style="width:38%">KEY</th><th>VALUE</th><th style="width:44px"></th></tr></thead><tbody data-list="env"></tbody></table>
      <button class="btn sm" data-add="env" style="margin-top:6px">+ 添加变量</button>`,
    footHtml: `<button class="btn danger" id="dwDel">删除应用</button><span class="spacer"></span><button class="btn" id="dwCancel">取消</button><button class="btn primary" id="dwSave">保存</button>`,
    onMount: ({ body, foot }) => {
      // ---- 普通字段（语义与旧卡片版逐字一致；改动只进内存，抽屉「保存」落盘） ----
      body.querySelectorAll('[data-f]').forEach((input) => {
        input.oninput = input.onchange = () => {
          const f = input.dataset.f;
          if (f === 'default_workspace') {
            if (input.value) app.default_workspace = input.value; else delete app.default_workspace;
            return;
          }
          if (f === 'app_secret') {
            if (input.value.trim()) { app.app_secret = input.value; }
            else if (typeof app.app_secret === 'string') { app.app_secret = { secretSet: secret.secretSet }; }
            return;
          }
          if (f === 'concurrency') {
            if (input.value.trim()) app.concurrency = Number(input.value); else delete app.concurrency;
            return;
          }
          if (input.value.trim() || f === 'name' || f === 'app_id') { app[f] = input.value; }
          else { delete app[f]; }
        };
      });
      // ---- 触发词 / 显式插件：数组行编辑，实时写回 ----
      const LIST_DEFS = {
        triggers: { key: 'triggers', cols: [['match', '/produce 或 关键词'], ['rewrite', '请执行内容生产流程：{args}']] },
        plugins: { key: 'plugins', cols: [['name', 'my-plugin'], ['path', 'F:/dev/my-plugin']] },
      };
      const renderPairList = (name) => {
        const def = LIST_DEFS[name];
        const list = app[def.key] || [];
        const tb = body.querySelector(`[data-list="${name}"]`);
        tb.innerHTML = list.map((item, i) => `
          <tr>
            ${def.cols.map(([col, ph]) => `<td><input type="text" data-l="${i}" data-c="${col}" value="${esc(item?.[col] ?? '')}" placeholder="${esc(ph)}"></td>`).join('')}
            <td><button class="btn sm danger" data-rm="${i}">删除</button></td>
          </tr>`).join('');
        tb.querySelectorAll('input[data-l]').forEach((input) => input.oninput = () => {
          app[def.key][Number(input.dataset.l)][input.dataset.c] = input.value;
        });
        tb.querySelectorAll('button[data-rm]').forEach((b) => b.onclick = () => {
          app[def.key].splice(Number(b.dataset.rm), 1);
          if (!app[def.key].length) delete app[def.key];
          renderPairList(name);
        });
      };
      for (const name of Object.keys(LIST_DEFS)) renderPairList(name);
      // ---- 环境变量：对象 ↔ 行数组同步（key 改名 / 删除即时生效到 app.env） ----
      const envRows = Object.entries(app.env || {}).map(([key, value]) => ({ key, value: String(value) }));
      const syncEnv = () => {
        const obj = {};
        for (const r of envRows) if (r.key.trim()) obj[r.key.trim()] = r.value;
        if (Object.keys(obj).length) app.env = obj; else delete app.env;
      };
      const renderEnv = () => {
        const tb = body.querySelector('[data-list="env"]');
        tb.innerHTML = envRows.map((r, i) => `
          <tr>
            <td><input type="text" data-ei="${i}" data-c="key" value="${esc(r.key)}" placeholder="SOME_KEY"></td>
            <td><input type="text" data-ei="${i}" data-c="value" value="${esc(r.value)}" placeholder="some-value"></td>
            <td><button class="btn sm danger" data-rm="${i}">删除</button></td>
          </tr>`).join('');
        tb.querySelectorAll('input[data-ei]').forEach((input) => input.oninput = () => {
          envRows[Number(input.dataset.ei)][input.dataset.c] = input.value;
          syncEnv();
        });
        tb.querySelectorAll('button[data-rm]').forEach((b) => b.onclick = () => {
          envRows.splice(Number(b.dataset.rm), 1);
          syncEnv();
          renderEnv();
        });
      };
      renderEnv();
      // ---- 添加行 ----
      body.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
        const name = b.dataset.add;
        if (name === 'env') { envRows.push({ key: '', value: '' }); renderEnv(); return; }
        const def = LIST_DEFS[name];
        (app[def.key] = app[def.key] || []).push({ [def.cols[0][0]]: '', [def.cols[1][0]]: '' });
        renderPairList(name);
        body.querySelector(`[data-list="${name}"] tbody input`)?.focus();
      });
      // ---- 删除 / 保存 / 取消 ----
      foot.querySelector('#dwDel').onclick = async () => {
        if (apps.length <= 1) return toast('至少保留一个应用', true);
        if (!(await confirmDialog({
          title: '删除应用',
          message: `确认删除应用「${esc(app.name || app.app_id || '未命名')}」？删除将立即保存生效。`,
          danger: true,
          confirmText: '删除',
        }))) return;
        apps.splice(idx, 1);
        if (await saveDoc()) closeDrawer();
        else cancelDrawer(); // 落盘失败：回滚删除，保留编辑现场让用户重试
      };
      foot.querySelector('#dwCancel').onclick = cancelDrawer;
      foot.querySelector('#dwSave').onclick = async () => {
        // 清理半填的空行：triggers/plugins 行两列全空剔除；env 以 key 非空为准（syncEnv 已过滤）。数组空则整键删除
        for (const name of Object.keys(LIST_DEFS)) {
          const def = LIST_DEFS[name];
          const list = app[def.key];
          if (!Array.isArray(list)) continue;
          const filtered = list.filter((item) => def.cols.some(([col]) => String(item?.[col] ?? '').trim()));
          if (filtered.length) app[def.key] = filtered;
          else delete app[def.key];
        }
        if (await saveDoc()) closeDrawer();
      };
    },
  });
}

export const page = {
  id: 'apps',
  title: '飞书应用',
  icon: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  render: renderApps,
};
