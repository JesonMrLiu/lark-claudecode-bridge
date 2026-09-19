// ============ 应用（列表 + 抽屉编辑；输入实时写回 S.doc.apps，抽屉「保存」一次落盘） ============
import { S, $, esc, toast, api, snapDoc, saveDoc } from '../core.js';
import { openDrawer, closeDrawer, cancelDrawer, confirmDialog, multiSelectField } from '../ui.js';

// ---- 分身白名单多选候选（/api/skills + /api/plugins；60s TTL + in-flight 去重 + stale-if-error） ----
/** 纯函数（可测）：技能清单 → 多选候选。插件来源 value 用 `plugin:skill` 限定格式
 *  （SDK Options.skills 契约，sdk.d.ts：插件技能须限定名），裸技能用目录名；按 value 去重首胜 */
export function toSkillOptions(skills) {
  const out = [];
  const seen = new Set();
  for (const s of skills || []) {
    const value = s.source === 'plugin' ? `${s.pluginName}:${s.name}` : s.name;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const tag = s.source === 'plugin'
      ? `插件${s.pluginEnabled ? '' : ' · 未启用'}`
      : s.source === 'project' ? `项目 · ${s.workspaceName || '?'}`
        : s.source === 'managed' ? 'bridge' : '本机';
    out.push({ value, desc: s.description, tag });
  }
  return out;
}

/** 纯函数（可测）：已装插件清单 → 多选候选。value = name（installed_plugins.json 键的
 *  @ 前段，与后端 allowedPlugins.includes(p.name) 匹配口径同源）；未启用插件标记提醒 */
export function toPluginOptions(plugins) {
  const out = [];
  const seen = new Set();
  for (const p of plugins || []) {
    if (!p.name || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({
      value: p.name,
      desc: p.description,
      tag: `${p.source === 'bridge' ? 'bridge' : '本机'}${p.enabled ? '' : ' · 未启用'}${p.version ? ` · v${p.version}` : ''}`,
    });
  }
  return out;
}

const CAND = { at: 0, skills: null, plugins: null, skillsError: '', pluginsError: '', inflight: null };
const CAND_TTL = 60_000;
/** 拉候选（失败时保留旧缓存继续用；全新失败返回 error 字段，组件空候选但已选值不受影响） */
function loadDeputyCandidates() {
  if (Date.now() - CAND.at < CAND_TTL && (CAND.skills || CAND.plugins)) return Promise.resolve({ ...CAND });
  if (CAND.inflight) return CAND.inflight;
  CAND.inflight = (async () => {
    const [sk, pl] = await Promise.allSettled([api('GET', '/api/skills'), api('GET', '/api/plugins')]);
    CAND.at = Date.now();
    // stale-if-error：失败且有旧缓存 → 沿用旧值（error 只在无缓存可退时向上暴露）
    if (sk.status === 'fulfilled') { CAND.skills = sk.value?.skills ?? []; CAND.skillsError = ''; }
    else if (!CAND.skills) CAND.skillsError = sk.reason?.message || '未知错误';
    if (pl.status === 'fulfilled') { CAND.plugins = pl.value?.plugins ?? []; CAND.pluginsError = ''; }
    else if (!CAND.plugins) CAND.pluginsError = pl.reason?.message || '未知错误';
    CAND.inflight = null;
    return { ...CAND };
  })();
  return CAND.inflight;
}

function renderApps(el) {
  const apps = S.doc.apps || (S.doc.apps = []);
  el.innerHTML = `
  <div class="card">
    <h3>飞书应用（机器人）</h3>
    <div class="desc">每个应用一条独立长连接与会话池。点击行或「编辑」在抽屉中配置；App Secret 已脱敏，留空 = 保持不变。凭证 / 名称 / 域名 / 默认工作区 / 并发 / 人格 / 角色改动需重启 lcb start；触发词、显式插件与环境变量改动下一条消息热生效。</div>
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
      <td><b>${esc(app.name || app.app_id || '（未命名）')}</b>${app.role === 'deputy' ? ' <span class="tag off">分身</span>' : ''}</td>
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
      <label>角色（主机器人 = 全权限、首次使用需配对；分身机器人 = 限定能力、艾特即用供他人使用）</label>
      <select data-f="role">
        <option value="primary" ${app.role !== 'deputy' ? 'selected' : ''}>主机器人（全权限，配对码准入）</option>
        <option value="deputy" ${app.role === 'deputy' ? 'selected' : ''}>分身机器人（限定技能 / 插件 / 工作区，艾特即用）</option>
      </select>
      <div id="deputyFields" style="${app.role === 'deputy' ? '' : 'display:none'}">
        <div class="hint" style="margin:8px 0 2px">分身必填「允许的技能」与「允许的工作区」；未列入白名单的技能 / 插件不加载，任务锁定在第一个允许的工作区；管理命令在分身里一律不可用。改动需重启生效。</div>
        <label>允许的技能（必填；输入关键词搜索选择，未列出的技能对模型不可见）</label>
        <div data-msel="allowed_skills"></div>
        <label>允许的工作区（必填；取值须在工作区列表内，任务锁定第一个）</label>
        <div data-msel="allowed_workspaces"></div>
        <label>允许的插件（可选；按名称过滤自动发现的插件，不配 = 不加载任何自动发现插件）</label>
        <div data-msel="allowed_plugins"></div>
      </div>
      <label>人格补充（追加到该机器人每个会话的 system prompt，多机器人差异化定位）<span class="tag warn" style="margin-left:6px">改动需重启生效</span></label>
      <textarea data-f="append_system_prompt" placeholder="你是我的超级助手，擅长代码开发、文案编写…（回复须带「主人」称谓等要求写在这里）">${esc(app.append_system_prompt || '')}</textarea>
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
      // ---- 角色（主/分身）：切换 deputy 区块显示；选主时移除 role 键（yaml 干净，归一化仍为 primary） ----
      const roleSel = body.querySelector('[data-f="role"]');
      const deputyFields = body.querySelector('#deputyFields');
      roleSel.addEventListener('change', () => {
        if (roleSel.value === 'deputy') app.role = 'deputy';
        else delete app.role;
        deputyFields.style.display = roleSel.value === 'deputy' ? '' : 'none';
      });
      // ---- 分身白名单（可搜索多选）：onChange 实时写回 app——空数组删键，语义与旧 textarea 一致 ----
      const mselInst = {};
      for (const f of ['allowed_skills', 'allowed_workspaces', 'allowed_plugins']) {
        mselInst[f] = multiSelectField({
          mount: body.querySelector(`[data-msel="${f}"]`),
          value: app[f] || [],
          placeholder: '输入关键词搜索选择…',
          emptyText: '候选加载中…',
          onChange: (values) => { if (values.length) app[f] = values; else delete app[f]; },
        });
      }
      // 工作区候选来自配置本身（refresh 后 S.doc 是新引用，无须缓存）
      mselInst.allowed_workspaces.setOptions(
        wsNames.map((n) => ({ value: n })),
        wsNames.length ? undefined : '尚未配置工作区（先到「工作区」页添加）',
      );
      // 技能/插件候选走 API：组件先以空候选就位，数据到达（或失败提示）后回填，已选值不受影响
      void loadDeputyCandidates().then((c) => {
        mselInst.allowed_skills.setOptions(
          toSkillOptions(c.skills),
          c.skillsError ? `候选加载失败：${c.skillsError}（已选项不受影响）` : (c.skills?.length ? undefined : '暂无已安装技能'),
        );
        mselInst.allowed_plugins.setOptions(
          toPluginOptions(c.plugins),
          c.pluginsError ? `候选加载失败：${c.pluginsError}（已选项不受影响）` : (c.plugins?.length ? undefined : '暂无已安装插件'),
        );
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
        // 分身预校验（后端 loadConfig 校验兜底，前端提前拦截给出友好提示）
        if (app.role === 'deputy') {
          if (!(app.allowed_skills || []).length) return toast('分身机器人必须配置「允许的技能」（至少一个）', true);
          if (!(app.allowed_workspaces || []).length) return toast('分身机器人必须配置「允许的工作区」（至少一个）', true);
          const badWs = (app.allowed_workspaces || []).filter((w) => !wsNames.includes(w));
          if (badWs.length) return toast(`「允许的工作区」含未定义的工作区：${badWs.join('、')}（请先在工作区列表中添加）`, true);
        }
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
