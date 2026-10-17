// ============ 飞书应用（卡片列表 + 抽屉横向 Tab 编辑） ============
// 抽屉顶部横向 Tab：基本信息（身份/Secret/域名/工作区/并发/人格）/ 机器人角色（主/分身 +
// 分身三项白名单）/ 模型 / 触发词 / 环境变量。输入实时写回 S.doc.apps，抽屉「保存」一次落盘。
// Secret 已脱敏：留空 = 保持不变；带「显示」切换。主机器人不渲染分身白名单区。
import { S, $, esc, toast, api, snapDoc, saveDoc } from '../core.js';
import { openDrawer, closeDrawer, cancelDrawer, confirmDialog, multiSelectField, singleSelectField } from '../ui.js';

const svg = (inner, s = 12) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const IC = {
  bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><path d="M9 13v2M15 13v2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  claude: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  slash: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M12 12v4"/>',
};

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

/** 纯函数（可测）：档案 → 模型单选候选（models ∪ 默认 model 去重，默认模型带 tag 便于辨认）。
 *  空档案（未配置任何模型）返回空数组，由组件展示 emptyText */
export function toProfileModelOptions(prof) {
  if (!prof) return [];
  const seen = new Set();
  const models = [];
  for (const m of [...(prof.models || []), ...(prof.model ? [prof.model] : [])]) {
    if (seen.has(m)) continue;
    seen.add(m);
    models.push(m);
  }
  return models.map((m) => ({ value: m, tag: m === prof.model ? '默认' : '' }));
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
  const statusOf = (app) => S.status?.apps?.find((s) => s.name === (app.name || app.app_id))?.started;
  // 该应用实际启用的模型：profile_model 覆盖优先，其次档案默认 model（与后端 resolveAppProfileModel 展示口径一致）
  const profiles = (S.doc.claude && S.doc.claude.profiles) || [];
  const profileModelOf = (app) =>
    app.profile_model || (profiles.find((p) => p.name === app.profile)?.model || '');
  el.innerHTML = `
  <div class="cardgrid">
    ${apps.map((app, i) => {
      const started = statusOf(app);
      const model = profileModelOf(app);
      return `
      <div class="acard" data-i="${i}" tabindex="0" role="button" aria-label="编辑 ${esc(app.name || app.app_id || '应用')}">
        <div class="acard-head"><b>${esc(app.name || app.app_id || '（未命名）')}</b>
          ${app.role === 'deputy' ? '<span class="tag info">分身</span>' : ''}
          <span class="dot ${started === true ? 'ok' : started === false ? 'err' : 'off'}" title="${started === true ? '运行中' : started === false ? '启动失败' : '未随本页启动'}"></span></div>
        <div class="acard-meta">
          <span title="App ID">${svg(IC.bot)}<span class="mono">${esc(app.app_id || '（待填写）')}</span></span>
          <span>${svg(IC.globe)}${app.domain === 'lark' ? 'lark 国际' : 'feishu 国内'}</span>
          <span>${svg(IC.folder)}${esc(app.default_workspace || '全局默认')}</span>
        </div>
        <div class="acard-meta">
          <span>${svg(IC.claude)}${esc(app.profile ? `${app.profile}${model ? ` · ${model}` : ''}` : '跟随全局')}</span>
          <span>${svg(IC.slash)}触发词 ${(app.triggers || []).length}</span>
        </div>
        <div class="acard-foot">
          <button class="btn sm" data-edit="${i}">编辑</button>
          <button class="btn sm danger" data-del="${i}">删除</button>
          <span class="mut" style="font-size:11px;align-self:center;margin-left:auto">${app.role === 'deputy' ? '艾特即用' : '配对码准入'}</span>
        </div>
      </div>`;
    }).join('')}
    <div class="acard newcard" id="addApp" tabindex="0" role="button">${svg(IC.plus, 18)}<span>新增应用</span></div>
  </div>
  <div class="mini-note" style="margin-top:10px">每个应用一条独立长连接与会话池。App Secret 已脱敏保存，留空 = 保持不变。凭证 / 名称 / 域名 / 默认工作区 / 并发 / 人格 / 角色改动需重启 lcb start；触发词与环境变量改动下一条消息热生效。</div>`;
  $('#pageActions').innerHTML = `<button class="btn primary" id="addAppTop">${svg(IC.plus, 14)} 新增应用</button>`;
  const openEdit = (i) => {
    const snap = snapDoc(); // 快照先于改动：取消时回滚（含新增未保存行）
    openAppDrawer(apps, i, snap);
  };
  el.querySelectorAll('.acard[data-i]').forEach((c) => {
    c.onclick = (e) => { if (e.target.closest('button')) return; openEdit(Number(c.dataset.i)); };
    c.onkeydown = (e) => { if (e.key === 'Enter') openEdit(Number(c.dataset.i)); };
  });
  el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openEdit(Number(b.dataset.edit)));
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (apps.length <= 1) return toast('至少保留一个应用', true);
    const app = apps[Number(b.dataset.del)];
    if (!(await confirmDialog({ title: '删除应用', message: `确认删除应用「${esc(app.name || app.app_id || '未命名')}」？删除将立即保存生效。`, danger: true, confirmText: '删除' }))) return;
    apps.splice(Number(b.dataset.del), 1);
    // saveDoc 内部 refresh() 会整页重渲染；失败时 toast（内存态与磁盘不一致由下一轮 refresh 校正前保持）
    if (!(await saveDoc())) toast('删除失败，请重试', true);
  });
  const add = () => {
    const snap = snapDoc(); // 快照先于 push：取消时连同新增空行一起回滚
    apps.push({ app_id: '', app_secret: '' });
    openAppDrawer(apps, apps.length - 1, snap);
  };
  $('#addApp').onclick = add;
  $('#addAppTop').onclick = add;
}

/**
 * 应用编辑抽屉（横向 Tab）。输入实时 mutate app 对象，「保存」PUT 落盘（applySecrets /
 * 注文保护链路零改动）。secret 语义逐字保留：非空 = 明文写入；空 = 保持脱敏对象（PUT 端
 * 按 app_id 回填磁盘现值）。「取消」/ X / ESC = 回滚到打开前快照（新增未保存行一并撤销）。
 */
function openAppDrawer(apps, idx, snap) {
  const app = apps[idx];
  const secret = app.app_secret || {};
  const isNew = !app.app_id && !app.name;
  const wsNames = (S.doc.workspaces || []).map((w) => w.name || '').filter(Boolean);
  const globalDef = S.doc.defaults?.workspace || '';
  const profiles = (S.doc.claude && S.doc.claude.profiles) || [];
  const profileByName = (n) => profiles.find((p) => p.name === n);
  const started = S.status?.apps?.find((s) => s.name === (app.name || app.app_id))?.started;
  const secs = [
    ['base', '基本信息'],
    ['role', '机器人角色'],
    ['model', '模型'],
    ['trig', '触发词'],
    ['env', '环境变量'],
  ];
  let cur = 'base';

  const paneBase = () => `
    <div class="sub-title" style="margin-bottom:2px">应用身份
      ${started === true ? '<span class="tag ok" style="margin-left:auto">已连接</span>' : started === false ? '<span class="tag err" style="margin-left:auto">启动失败</span>' : '<span class="tag off" style="margin-left:auto">未连接</span>'}
    </div>
    <div class="mut" style="font-size:12px;margin-bottom:8px">配置机器人连接信息与默认行为。</div>
    <div class="grid2">
      <div><label class="fld">应用名称 <span class="tip" data-tip="概览页与飞书 /status 显示用，缺省取 App ID">${svg(IC.info, 13)}</span></label>
        <input type="text" data-f="name" value="${esc(app.name || '')}" placeholder="素材收集"></div>
      <div><label class="fld">App ID</label>
        <input type="text" data-f="app_id" value="${esc(app.app_id || '')}" placeholder="cli_…"></div>
    </div>
    <label class="fld">App Secret ${secret.secretSet ? `<span class="tag off">已设置 ${esc(secret.secretHint)}</span>` : ''} <span class="tip" data-tip="已脱敏保存；留空 = 保持不变，输入 = 覆盖">${svg(IC.info, 13)}</span></label>
    <div class="input-btn">
      <input type="password" data-f="app_secret" placeholder="${secret.secretSet ? '••••••••（留空保持不变）' : '未设置'}">
      <button class="btn" type="button" id="dwSecretShow">显示</button>
    </div>
    <div class="mini-note" style="margin-top:5px">密钥已保存。保存时留空或不修改，将继续使用现有密钥。</div>
    <div class="grid3" style="margin-top:6px">
      <div><label class="fld">域名</label><select data-f="domain">
        <option value="" ${!app.domain || app.domain === 'feishu' ? 'selected' : ''}>feishu（国内）</option>
        <option value="lark" ${app.domain === 'lark' ? 'selected' : ''}>lark（国际）</option></select></div>
      <div><label class="fld">默认工作区</label><select data-f="default_workspace">
        <option value="" ${!app.default_workspace ? 'selected' : ''}>（全局默认${globalDef ? `：${esc(globalDef)}` : ''}）</option>
        ${wsNames.map((n) => `<option value="${esc(n)}" ${app.default_workspace === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select></div>
      <div><label class="fld">并发上限 <span class="tag warn">需重启</span></label>
        <input type="number" data-f="concurrency" min="1" max="100" value="${esc(app.concurrency ?? '')}" placeholder="缺省用全局"></div>
    </div>
    <label class="fld">人格补充 <span class="tag off">可选</span> <span class="tag warn">需重启</span> <span class="tip" data-tip="追加到该机器人每个会话的 system prompt，用于多机器人差异化定位">${svg(IC.info, 13)}</span></label>
    <textarea data-f="append_system_prompt" style="min-height:76px" class="plain" placeholder="你是我的超级助手，擅长代码开发、文案编写…（回复须带「主人」称谓等要求写在这里）">${esc(app.append_system_prompt || '')}</textarea>
    <div class="mini-note" style="margin-top:6px">${(app.append_system_prompt || '').length} 字 · 建议只写角色差异与表达偏好，避免重复全局指令。</div>`;

  const paneRole = () => {
    const deputy = app.role === 'deputy';
    return `
    <label class="fld">机器人角色 <span class="tip" data-tip="主机器人=全权限、配对码准入；分身机器人=限定能力、群内艾特即用">${svg(IC.info, 13)}</span></label>
    <div class="rcards">
      <label class="rcard ${!deputy ? 'on' : ''}"><input type="radio" name="dwRole" value="primary" ${!deputy ? 'checked' : ''}><span><b>主机器人</b><span class="hint">全权限，配对码准入</span></span></label>
      <label class="rcard ${deputy ? 'on' : ''}"><input type="radio" name="dwRole" value="deputy" ${deputy ? 'checked' : ''}><span><b>分身机器人</b><span class="hint">限定能力，供他人在群里艾特使用</span></span></label>
    </div>
    ${deputy ? `
    <div class="hint" style="margin:8px 0 2px">分身必填「允许的技能」与「允许的工作区」；未列入白名单的技能 / 插件不加载，任务锁定在第一个允许的工作区；管理命令在分身里一律不可用。改动需重启生效。</div>
    <label class="fld">允许的技能（必填）</label><div data-msel="allowed_skills"></div>
    <label class="fld">允许的工作区（必填，任务锁定第一个）</label><div data-msel="allowed_workspaces"></div>
    <label class="fld">允许的插件（可选）</label><div data-msel="allowed_plugins"></div>` : `
    <div class="mini-note" style="margin-top:12px">主机器人 = 全权限（不限制技能 / 工作区 / 插件），首次使用需配对码准入。</div>`}`;
  };

  const paneModel = () => `
    <div class="hint" style="margin-bottom:6px">未配置 = 跟随全局（「Claude 认证」页当前生效配置）。档案须先在「Claude 认证」页创建；认证经独立 settings 文件注入（优先级高于全局），模型经 --model 参数注入。改动下一条消息热生效。</div>
    <div class="grid2" style="align-items:end">
      <div><label class="fld">厂商档案</label>
        <select data-f="profile">
          <option value="" ${!app.profile ? 'selected' : ''}>（跟随全局）</option>
          ${profiles.map((p) => `<option value="${esc(p.name)}" ${app.profile === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></div>
      <div id="profileModelBox" style="${app.profile ? '' : 'display:none'}"><label class="fld">模型（留空 = 档案默认模型）</label>
        <div id="profileModelMount"></div></div>
    </div>
    <div class="mini-note" style="margin-top:10px">认证经独立 settings 注入，模型经 --model 参数注入；改动下一条消息热生效。档案在「Claude 认证」页维护。</div>`;

  const paneTrig = () => `
    <div class="banner info" style="margin-bottom:10px"><span>命中即改写消息后入队；<code>{text}</code>=原文，<code>{args}</code>=首词后的参数。match 以 <code>/</code> 开头或关键词 = 消息首词精确匹配；可指向 bridge 本地命令（如 match=新会话、rewrite=/new）。<span class="tag info" style="margin-left:6px">热生效</span></span></div>
    <table><thead><tr><th style="width:34%">match</th><th>rewrite</th><th style="width:76px" title="开启后命中先追问补充内容，下一条消息与原文合并再执行（两段式触发）">追问补充</th><th style="width:70px"></th></tr></thead>
    <tbody data-list="triggers"></tbody></table>
    <button class="btn sm" data-add="triggers" style="margin-top:8px">＋ 添加规则</button>`;

  const paneEnv = () => `
    <div class="mini-note" style="margin-bottom:8px">注入该机器人的 Claude 子进程，覆盖本机同名值；~/.claude/settings.json 已配置的键会被 CLI 自身应用且优先，无须在此重复。<span class="tag warn" style="margin-left:4px">需重启</span></div>
    <table><thead><tr><th style="width:36%">KEY</th><th>VALUE</th><th style="width:70px"></th></tr></thead>
    <tbody data-list="env"></tbody></table>
    <button class="btn sm" data-add="env" style="margin-top:8px">＋ 添加变量</button>`;

  const panes = { base: paneBase, role: paneRole, model: paneModel, trig: paneTrig, env: paneEnv };
  const cnt = (s) => (s === 'trig' ? (app.triggers?.length || '') : s === 'env' ? (Object.keys(app.env || {}).length || '') : '');

  openDrawer({
    title: `${isNew ? '新增应用' : `应用：${app.name || app.app_id || '（未命名）'}`}`,
    snap: snap ?? snapDoc(),
    bodyHtml: `<div class="tabs" id="dwTabs" style="margin-bottom:18px"></div><div id="dwPane"></div>`,
    footHtml: `<button class="btn danger" id="dwDel">删除应用</button><span class="sp"></span><button class="btn" id="dwCancel">取消</button><button class="btn primary" id="dwSave">保存</button>`,
    onMount: ({ body, foot }) => {
      const paintTabs = () => {
        body.querySelector('#dwTabs').innerHTML = secs.map(([id, label]) =>
          `<button data-s="${id}" class="${id === cur ? 'active' : ''}">${label}${cnt(id) !== '' ? `<span class="tag off" style="margin-left:4px">${cnt(id)}</span>` : ''}</button>`).join('');
        body.querySelectorAll('#dwTabs button').forEach((b) => b.onclick = () => { cur = b.dataset.s; paint(); });
      };

      /** 每次切 Tab / 行增删后重画当前 Tab 并重绑事件（状态都在 app 对象上，切页零丢失） */
      const bindPane = () => {
        const p = body.querySelector('#dwPane');
        if (cur === 'base') {
          p.querySelectorAll('[data-f]').forEach((input) => {
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
          const showBtn = p.querySelector('#dwSecretShow');
          if (showBtn) showBtn.onclick = () => {
            const sec = p.querySelector('[data-f="app_secret"]');
            const hide = sec.type === 'password';
            sec.type = hide ? 'text' : 'password';
            showBtn.textContent = hide ? '隐藏' : '显示';
          };
        }
        if (cur === 'role') {
          p.querySelectorAll('.rcard').forEach((r) => r.onclick = (e) => {
            e.preventDefault();
            const v = r.querySelector('input').value;
            if (v === 'deputy') app.role = 'deputy'; else delete app.role;
            paint();
          });
          if (app.role === 'deputy') {
            const mselInst = {};
            for (const f of ['allowed_skills', 'allowed_workspaces', 'allowed_plugins']) {
              mselInst[f] = multiSelectField({
                mount: p.querySelector(`[data-msel="${f}"]`),
                value: app[f] || [],
                placeholder: '输入关键词搜索选择…',
                emptyText: '候选加载中…',
                onChange: (values) => { if (values.length) app[f] = values; else delete app[f]; },
              });
            }
            // 工作区候选来自配置本身；技能/插件候选走 API（组件先空候选就位，数据到达后回填）
            mselInst.allowed_workspaces.setOptions(
              wsNames.map((n) => ({ value: n })),
              wsNames.length ? undefined : '尚未配置工作区（先到「工作区」页添加）',
            );
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
          }
        }
        if (cur === 'model') {
          const profileSel = p.querySelector('[data-f="profile"]');
          const profileModelBox = p.querySelector('#profileModelBox');
          const modelCombo = singleSelectField({
            mount: p.querySelector('#profileModelMount'),
            value: app.profile_model || '', // 遗留值（含已不在候选的）ghost 展示可清除
            placeholder: '输入关键词搜索选择；留空 = 档案默认模型',
            emptyText: '该档案未配置候选模型（到「Claude 认证」页为档案添加模型）',
            onChange: (v) => { if (v) app.profile_model = v; else delete app.profile_model; },
          });
          const applyProfileModels = () => {
            modelCombo.setOptions(toProfileModelOptions(profileByName(profileSel.value)));
            profileModelBox.style.display = profileSel.value ? '' : 'none';
          };
          applyProfileModels(); // 初次填充：不动 value、不动 app.profile_model
          profileSel.addEventListener('change', () => {
            if (profileSel.value) app.profile = profileSel.value; else delete app.profile;
            applyProfileModels();
            modelCombo.setValue(''); // 静默清空 → 显式删键（切「（跟随全局）」同样命中）
            delete app.profile_model;
          });
        }
        if (cur === 'trig') {
          const tb = p.querySelector('[data-list="triggers"]');
          const draw = () => {
            const list = app.triggers || [];
            tb.innerHTML = list.length ? list.map((t, i) => `
              <tr>
                <td><input type="text" data-l="${i}" data-c="match" value="${esc(t?.match ?? '')}" placeholder="/produce 或 关键词"></td>
                <td><input type="text" data-l="${i}" data-c="rewrite" value="${esc(t?.rewrite ?? '')}" placeholder="请执行内容生产流程：{args}"></td>
                <td style="text-align:center;vertical-align:middle"><label class="switch tight" title="开启后命中先追问补充内容，下一条消息与原文合并再执行（两段式触发）"><input type="checkbox" data-l="${i}" data-ck="ask_detail" ${t?.ask_detail === true ? 'checked' : ''}><span class="track"></span></label></td>
                <td><button class="btn sm danger" data-rm="${i}">删除</button></td>
              </tr>`).join('') : '<tr class="empty"><td colspan="4">暂无规则</td></tr>';
            tb.querySelectorAll('input[data-l]').forEach((input) => {
              if (input.dataset.ck) { // 勾选列：未勾即删键，与后端「仅 true 时写入」语义一致（YAML 干净）
                input.onchange = () => {
                  const row = app.triggers[Number(input.dataset.l)];
                  if (input.checked) row[input.dataset.ck] = true;
                  else delete row[input.dataset.ck];
                };
                return;
              }
              input.oninput = () => { app.triggers[Number(input.dataset.l)][input.dataset.c] = input.value; };
            });
            tb.querySelectorAll('button[data-rm]').forEach((b) => b.onclick = () => {
              app.triggers.splice(Number(b.dataset.rm), 1);
              if (!app.triggers.length) delete app.triggers;
              draw();
              paintTabs();
            });
          };
          draw();
          p.querySelector('[data-add="triggers"]').onclick = () => {
            (app.triggers = app.triggers || []).push({ match: '', rewrite: '' });
            draw();
            paintTabs();
            tb.querySelector('input')?.focus();
          };
        }
        if (cur === 'env') {
          const envRows = Object.entries(app.env || {}).map(([key, value]) => ({ key, value: String(value) }));
          const syncEnv = () => {
            const obj = {};
            for (const r of envRows) if (r.key.trim()) obj[r.key.trim()] = r.value;
            if (Object.keys(obj).length) app.env = obj; else delete app.env;
          };
          const tb = p.querySelector('[data-list="env"]');
          const draw = () => {
            tb.innerHTML = envRows.length ? envRows.map((r, i) => `
              <tr>
                <td><input type="text" data-ei="${i}" data-c="key" value="${esc(r.key)}" placeholder="SOME_KEY"></td>
                <td><input type="text" data-ei="${i}" data-c="value" value="${esc(r.value)}" placeholder="some-value"></td>
                <td><button class="btn sm danger" data-rm="${i}">删除</button></td>
              </tr>`).join('') : '<tr class="empty"><td colspan="3">暂无变量</td></tr>';
            tb.querySelectorAll('input[data-ei]').forEach((input) => input.oninput = () => {
              envRows[Number(input.dataset.ei)][input.dataset.c] = input.value;
              syncEnv();
            });
            tb.querySelectorAll('button[data-rm]').forEach((b) => b.onclick = () => {
              envRows.splice(Number(b.dataset.rm), 1);
              syncEnv();
              draw();
              paintTabs();
            });
          };
          draw();
          p.querySelector('[data-add="env"]').onclick = () => {
            envRows.push({ key: '', value: '' });
            draw();
            paintTabs();
            tb.querySelector('input')?.focus();
          };
        }
      };

      const paint = () => {
        paintTabs();
        body.querySelector('#dwPane').innerHTML = panes[cur]();
        bindPane();
      };
      paint();

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
        // 清理半填的空行：triggers 行两列全空剔除；env 以 key 非空为准（bindPane 内 syncEnv 已过滤）。数组空则整键删除
        const list = app.triggers;
        if (Array.isArray(list)) {
          const filtered = list.filter((item) => String(item?.match ?? '').trim() || String(item?.rewrite ?? '').trim());
          if (filtered.length) app.triggers = filtered;
          else delete app.triggers;
        }
        // 档案未选时清掉残留的模型覆盖（profile_model 依附于 profile 存在）
        if (!app.profile) delete app.profile_model;
        if (await saveDoc()) closeDrawer();
      };
    },
  });
}

export const page = {
  id: 'apps',
  title: '飞书应用',
  desc: '每个应用一条独立长连接与独立会话池',
  icon: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  render: renderApps,
};
