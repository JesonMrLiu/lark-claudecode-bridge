// ============ Claude 认证（生效配置 / 厂商档案 双 Tab） ============
// 常规路径站在用户角度：bridge 托管 = 从厂商档案选（档案卡单选 → 下拉选模型），凭证不再手填；
// 手动凭证 / BASE_URL / 模型收进「高级」折叠（兼容老配置直填场景）。档案卡加宽 420px，
// 卡上候选模型点击即切换当前模型（走 /api/claude/use-profile，凭证明文不出进程）。
import { S, $, esc, toast, api, snapDoc, saveDoc, cardDirty, applyDirty, refresh } from '../core.js';
import { openDrawer, closeDrawer, cancelDrawer, isDrawerOpen, saveBarHtml, dirtyDotHtml, bindSaveBar, confirmDialog } from '../ui.js';

const svg = (inner, s = 12) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const IC = {
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M12 12v4"/>',
};

/** 模型名 1M 上下文标记解析（纯函数，可测）：'glm-5.3[1m]' → { name:'glm-5.3', tag:'1M' }；后缀大小写不敏感（后端归一为小写 [1m]） */
export function splitModelTag(m) {
  const s = String(m || '');
  const mm = s.match(/^(.*?)\s*\[1m\]$/i);
  return mm ? { name: mm[1], tag: '1M' } : { name: s, tag: '' };
}

/** 勾选 1M 时拼接官方小写后缀 [1m]（Claude Code 1M 上下文模型格式）；输入已带后缀时幂等 */
export function withModelTag(name, on) {
  const base = splitModelTag(name).name;
  return on ? `${base}[1m]` : base;
}

/** 模型拉取公共逻辑：getBody() 组请求体（凭证仅携带本次输入的明文，空则不带给后端回落磁盘值） */
async function pullModels(getBody, btn, datalistId) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '拉取中…';
  try {
    const r = await api('POST', '/api/models/fetch', getBody());
    const dl = document.getElementById(datalistId);
    if (dl) dl.innerHTML = (r.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
    toast(`获取到 ${(r.models || []).length} 个模型：在模型框下拉选择，或继续手动输入`);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
  btn.textContent = old;
}

let claudeTab = 'cur'; // 页内 Tab 态（切页保留）

function renderClaude(el) {
  const c = S.doc.claude || (S.doc.claude = {});
  c.profiles = c.profiles || [];
  const mode = c.mode || 'inherit';
  el.innerHTML = `
  <div class="tabs">
    <button data-t="cur" class="${claudeTab === 'cur' ? 'active' : ''}">生效配置</button>
    <button data-t="pf" class="${claudeTab === 'pf' ? 'active' : ''}">厂商档案 <span class="tag off" style="margin-left:4px">${c.profiles.length}</span></button>
  </div><div id="claudePane"></div>`;
  el.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => { claudeTab = b.dataset.t; renderClaude(el); });
  void (claudeTab === 'cur' ? renderCurPane : renderPfPane)($('#claudePane'), c, mode, el);
  applyDirty();
}

/** 档案「使用中」近似判定：前端无凭证明文，用尾 4 位提示 + baseUrl 比对 */
function inUseProfile(p, cur) {
  const credSame = (p.auth_token?.secretHint && cur.authToken?.secretHint === p.auth_token.secretHint)
    || (p.api_key?.secretHint && cur.apiKey?.secretHint === p.api_key.secretHint);
  return credSame && (p.base_url || '') === (cur.baseUrl || '');
}

/** 生效配置 Tab：当前生效只读卡 + 认证模式卡（managed = 档案卡 + 模型下拉；高级折叠保留手填） */
function renderCurPane(pane, c, mode, el) {
  const cur = S.status?.claude?.current || {};
  const hint = (h) => (h?.secretSet ? `已设置（${esc(h.secretHint)}）` : '未设置');
  const profiles = c.profiles || [];
  const activePf = profiles.find((p) => inUseProfile(p, cur));
  const modelChipsOf = (p) => [...(p.models || []), ...(p.model && !(p.models || []).includes(p.model) ? [p.model] : [])];
  pane.innerHTML = `
  <div class="panel">
    <header class="panel-head"><h3>当前生效</h3>
      <div class="panel-actions"><span class="tag ${mode === 'inherit' ? (cur.authToken?.secretSet || cur.apiKey?.secretSet || cur.model ? 'ok' : 'warn') : (cur.authToken?.secretSet || cur.apiKey?.secretSet ? 'ok' : 'err')}">${cur.authToken?.secretSet || cur.apiKey?.secretSet ? '已就绪' : mode === 'inherit' ? '沿用本机登录态' : '未认证'}</span></div></header>
    <div class="panel-body"><table class="kv">
      <tr><td>认证模式</td><td>${mode === 'managed' ? `bridge 托管（managed）${activePf ? ` · 档案「${esc(activePf.name)}」` : ''}` : '继承本机 ~/.claude（inherit）'}</td></tr>
      <tr><td>BASE_URL</td><td>${cur.baseUrl ? `<code>${esc(cur.baseUrl)}</code>` : '<span class="hint">官方默认（api.anthropic.com）</span>'}</td></tr>
      <tr><td>模型</td><td>${(() => { const { name, tag } = splitModelTag(cur.model || ''); return cur.model ? `<code>${esc(name)}</code>${tag ? ' <span class="tag ok">1M 上下文</span>' : ''}` : '<span class="hint">未设置（CLI 默认）</span>'; })()}</td></tr>
      <tr><td>凭证</td><td>${mode === 'managed' ? `AUTH_TOKEN ${hint(cur.authToken)} · API_KEY ${hint(cur.apiKey)}` : '本机登录态（本页不改）'}</td></tr>
      <tr><td>自定义环境变量</td><td>${cur.envCount ? `${cur.envCount} 个（写入托管 settings.json env 块）` : '<span class="hint">无</span>'}</td></tr>
      <tr><td>settings.json</td><td><code>${esc(S.status?.claude?.settingsPath || '—')}</code></td></tr>
    </table></div>
  </div>
  <div class="panel">
    <header class="panel-head"><h3>认证模式${dirtyDotHtml('claude')}</h3></header>
    <div class="panel-body">
      <div class="rcards">
        <label class="rcard ${mode !== 'managed' ? 'on' : ''}"><input type="radio" name="clMode" value="inherit" ${mode !== 'managed' ? 'checked' : ''}><span><b>继承本机</b><span class="hint">沿用本机 claude login 的登录态</span></span></label>
        <label class="rcard ${mode === 'managed' ? 'on' : ''}"><input type="radio" name="clMode" value="managed" ${mode === 'managed' ? 'checked' : ''}><span><b>bridge 托管</b><span class="hint">凭证来自厂商档案，无需本机登录</span></span></label>
      </div>
      ${mode === 'managed' ? `
      <hr>
      <label class="fld" style="font-size:12.5px;color:var(--ink);font-weight:600">选择厂商档案 <span class="tip" data-tip="凭证类型、BASE_URL 与密钥都在档案中维护；此处只做选择，改档案请到「厂商档案」页签">${svg(IC.info, 13)}</span></label>
      <div class="pfcards" id="clPfs">
        ${profiles.map((p, i) => `
        <div class="pfcard ${activePf && activePf.name === p.name ? 'on' : ''}" data-clpf="${i}" role="button" tabindex="0" aria-label="使用档案 ${esc(p.name)}">
          <b>${esc(p.name || '（未命名）')} ${activePf && activePf.name === p.name ? '<span class="tag ok">使用中</span>' : ''}</b>
          <div class="hint mut">${p.base_url ? `<span class="mono">${esc(p.base_url)}</span>` : '官方默认端点'} · ${p.auth_token?.secretSet ? 'AUTH_TOKEN' : p.api_key?.secretSet ? 'API_KEY' : '未设凭证'}</div>
        </div>`).join('') || '<div class="hint">尚无档案——先到「厂商档案」页签创建，或展开下方高级手动填写。</div>'}
      </div>
      <div style="display:flex;gap:14px;align-items:flex-end;margin-top:14px;flex-wrap:wrap">
        <div style="flex:1;min-width:240px"><label class="fld">模型 <span class="dim" style="font-weight:400">${activePf ? `${esc(activePf.name)} 候选` : '（先选择档案）'}</span></label>
          <select id="clModel" ${activePf ? '' : 'disabled'}>
            <option value="${esc(cur.model || '')}">${cur.model ? `${esc(splitModelTag(cur.model).name)}（当前）` : '（先选择档案）'}</option>
            ${activePf ? modelChipsOf(activePf).filter((m) => m !== cur.model).map((m) => `<option value="${esc(m)}">${esc(splitModelTag(m).name)}${splitModelTag(m).tag ? '（1M）' : ''}</option>`).join('') : ''}
          </select></div>
        <button class="btn" id="clGotoPf">去管理厂商档案 →</button>
      </div>
      <details class="adv" style="margin-top:14px"><summary>高级：手动凭证 / BASE_URL / 模型 / 环境变量（老配置直填与 MCP 变量在这里）</summary>
        <div class="adv-body">
          <div class="radio-row">
            <label><input type="radio" name="cred" value="auth_token" ${c.api_key?.secretSet && !c.auth_token?.secretSet ? '' : 'checked'}> AUTH_TOKEN（中转站常用，Bearer）</label>
            <label><input type="radio" name="cred" value="api_key" ${c.api_key?.secretSet && !c.auth_token?.secretSet ? 'checked' : ''}> API_KEY（官方，x-api-key）</label>
          </div>
          <div class="row">
            <div><label class="fld" id="credLabel">凭证（留空不改）</label>
              <input type="password" id="credVal" placeholder="${c.auth_token?.secretSet || c.api_key?.secretSet ? '留空保持不变' : 'sk-…'}"></div>
            <div><label class="fld">BASE_URL（官方留空）</label><input type="text" id="baseUrl" value="${esc(c.base_url || '')}" placeholder="https://relay.example.com"></div>
          </div>
          <div class="row" style="align-items:end">
            <div style="flex:1"><label class="fld">模型（写入 settings.json，可留空）</label>
              <input type="text" id="model" list="modelList" value="${esc(c.model || '')}" placeholder="claude-sonnet-5 或任意厂商模型名">
              <datalist id="modelList"></datalist></div>
            <button class="btn" id="btnModels">拉取模型</button>
          </div>
          <div class="hint" style="margin-top:6px">「拉取模型」用当前表单的 BASE_URL 与凭证（未填则用已保存值）请求模型列表：自动兼容带 / 不带 /v1 的地址与 Bearer / x-api-key 认证；失败可手动填写。</div>
          <hr>
          <div class="hint" style="margin-bottom:6px">环境变量写入托管 settings.json（MCP 工具依赖的自定义变量在此配置）；本机 ~/.claude/settings.json 已有的非认证键自动继承，此处配置<b>优先级更高</b>。认证相关键（ANTHROPIC_*）不在此生效，请用上方表单。</div>
          <table><thead><tr><th style="width:38%">KEY</th><th>VALUE</th><th style="width:70px"></th></tr></thead><tbody id="claudeEnvBody"></tbody></table>
          <button class="btn sm" id="claudeEnvAdd" style="margin-top:6px">＋ 添加变量</button>
        </div></details>
      ` : `
      <div class="banner info" style="margin-top:12px"><span>继承本机登录态：LCB 不写托管凭证，Claude CLI 直接使用本机 <code>~/.claude</code> 的登录与配置。如需固定凭证 / 模型 / 多厂商档案，请切到「bridge 托管」。</span></div>`}
    </div>
    ${saveBarHtml('claude')}
    <footer class="panel-foot">凭证与 BASE_URL 由所选厂商档案统一维护（本页只读展示）；托管模式与本机 ~/.claude 完全隔离；模式切换需重启，模型选择即时生效。</footer>
  </div>`;
  bindSaveBar(pane, 'claude');
  pane.querySelectorAll('input[name=clMode]').forEach((r) => r.onchange = () => {
    c.mode = pane.querySelector('input[name=clMode]:checked').value;
    cardDirty('claude', c.mode === 'managed'); // inherit 无 managed 表单语义：不标记未保存
    renderClaude(el); // 模式切换影响多卡显隐，整页重渲染（radio 状态由 c.mode 驱动）
  });
  // 档案单选小卡：点击 = 整套切换（走后端端点，凭证不出进程）；编辑中先收尾
  pane.querySelectorAll('[data-clpf]').forEach((cardP) => cardP.onclick = async () => {
    const p = profiles[Number(cardP.dataset.clpf)];
    if (isDrawerOpen()) return toast('请先完成档案编辑（保存或取消）', true);
    if (S.dirtyCards.size && !(await saveDoc())) return; // 保存失败已 toast 原因，保持编辑态不切换
    try {
      const r = await api('POST', '/api/claude/use-profile', { name: p.name });
      toast(r.message || `已切换到档案「${p.name}」`);
      await refresh();
    } catch (e) { toast(e.message, true); }
  });
  const modelSel = pane.querySelector('#clModel');
  if (modelSel) modelSel.onchange = async () => {
    if (!activePf) return;
    try {
      const r = await api('POST', '/api/claude/use-profile', { name: activePf.name, model: modelSel.value });
      toast(r.message || '已切换模型');
      await refresh();
    } catch (e) { toast(e.message, true); }
  };
  const gotoPf = pane.querySelector('#clGotoPf');
  if (gotoPf) gotoPf.onclick = () => { claudeTab = 'pf'; renderClaude(el); };
  // ---- 高级折叠内的手填通道（语义与旧版一致） ----
  const credType = () => pane.querySelector('input[name=cred]:checked')?.value || 'auth_token';
  pane.querySelectorAll('input[name=cred]').forEach((r) => r.onchange = () => {
    const v = credType();
    const t = v === 'auth_token' && c.auth_token?.secretSet ? `（已设置 ${esc(c.auth_token.secretHint)}，留空不改）` : '';
    const k = v === 'api_key' && c.api_key?.secretSet ? `（已设置 ${esc(c.api_key.secretHint)}，留空不改）` : '';
    const lb = pane.querySelector('#credLabel');
    if (lb) lb.textContent = `凭证${t || k || '（留空不改）'}`;
    cardDirty('claude', true);
  });
  const credVal = pane.querySelector('#credVal');
  if (credVal) credVal.oninput = () => {
    const v = credVal.value.trim();
    const key = credType();
    const other = key === 'auth_token' ? 'api_key' : 'auth_token';
    const hasT = c.auth_token?.secretSet, hasK = c.api_key?.secretSet;
    if (v) { c[key] = v; c[other] = ''; } else { c[key] = { secretSet: key === 'auth_token' ? hasT : hasK }; }
    cardDirty('claude', true);
  };
  const baseUrl = pane.querySelector('#baseUrl');
  if (baseUrl) baseUrl.oninput = () => { c.base_url = baseUrl.value.trim() || undefined; cardDirty('claude', true); };
  const modelInput = pane.querySelector('#model');
  if (modelInput) modelInput.oninput = () => { c.model = modelInput.value.trim() || undefined; cardDirty('claude', true); };
  const btnModels = pane.querySelector('#btnModels');
  if (btnModels) btnModels.onclick = () => {
    const typed = credVal?.value.trim() || '';
    const key = credType();
    pullModels(() => ({ base_url: baseUrl?.value.trim() || '', ...(typed ? { [key]: typed } : {}) }), btnModels, 'modelList');
  };
  // ---- 环境变量行编辑（claude.env）：对象 ↔ 行数组，KEY/VALUE 实时写回 ----
  const cEnvRows = Object.entries(c.env || {}).map(([key, value]) => ({ key, value: String(value) }));
  const syncClaudeEnv = () => {
    const obj = {};
    for (const r of cEnvRows) if (r.key.trim()) obj[r.key.trim()] = r.value;
    if (Object.keys(obj).length) c.env = obj; else delete c.env;
  };
  const renderClaudeEnv = () => {
    const tb = pane.querySelector('#claudeEnvBody');
    if (!tb) return;
    tb.innerHTML = cEnvRows.length ? cEnvRows.map((r, i) => `
      <tr>
        <td><input type="text" data-cei="${i}" data-col="key" value="${esc(r.key)}" placeholder="SOME_KEY"></td>
        <td><input type="text" data-cei="${i}" data-col="value" value="${esc(r.value)}" placeholder="some-value"></td>
        <td><button class="btn sm danger" data-crm="${i}">删除</button></td>
      </tr>`).join('') : '<tr><td colspan="3" class="hint">未配置（本机 ~/.claude 的非认证键自动继承）</td></tr>';
    tb.querySelectorAll('input[data-cei]').forEach((input) => input.oninput = () => {
      cEnvRows[Number(input.dataset.cei)][input.dataset.col] = input.value;
      syncClaudeEnv();
      cardDirty('claude', true);
    });
    tb.querySelectorAll('button[data-crm]').forEach((b) => b.onclick = () => {
      cEnvRows.splice(Number(b.dataset.crm), 1);
      syncClaudeEnv();
      cardDirty('claude', true);
      renderClaudeEnv();
    });
  };
  renderClaudeEnv();
  const envAdd = pane.querySelector('#claudeEnvAdd');
  if (envAdd) envAdd.onclick = () => { cEnvRows.push({ key: '', value: '' }); renderClaudeEnv(); };
}

/** 厂商档案 Tab：加宽卡片网格（420px），卡上候选模型点击即切换当前模型 */
function renderPfPane(pane, c, mode, el) {
  const cur = S.status?.claude?.current || {};
  pane.innerHTML = `
  <div class="cardgrid wide">
    ${c.profiles.map((p, i) => {
      const active = inUseProfile(p, cur);
      const models = [...(p.models || []), ...(p.model && !(p.models || []).includes(p.model) ? [p.model] : [])];
      return `
      <div class="acard" style="cursor:default">
        <div class="acard-head"><b>${esc(p.name || '（未命名）')}</b>${active ? '<span class="tag ok">使用中</span>' : ''}</div>
        <div class="acard-meta">
          <span>${svg(IC.key)}${p.auth_token?.secretSet ? 'AUTH_TOKEN' : p.api_key?.secretSet ? 'API_KEY' : '未设凭证'}</span>
          <span>${svg(IC.globe)}${p.base_url ? `<span class="mono">${esc(p.base_url)}</span>` : '官方默认'}</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${models.map((m) => {
            const { name, tag } = splitModelTag(m);
            return `<button class="btn sm ${active && cur.model === m ? 'primary' : ''}" data-usemodel="${i}" data-m="${esc(m)}" title="点击切换为当前模型">${esc(name)}${tag ? ' <span class="tag ok">1M</span>' : ''}${active && cur.model === m ? ' ✓' : ''}</button>`;
          }).join('') || '<span class="hint">无候选模型（编辑档案添加）</span>'}
        </div>
        <div class="acard-foot">
          <button class="btn sm" data-pfedit="${i}">编辑</button>
          <button class="btn sm danger" data-pfdel="${i}">删除</button>
          <span class="mut" style="font-size:11px;align-self:center;margin-left:auto">默认 ${esc(p.model ? splitModelTag(p.model).name : '—')}</span>
        </div>
      </div>`;
    }).join('')}
    <div class="acard newcard" id="pfAdd">${svg(IC.plus, 18)}<span>新增档案</span></div>
  </div>
  <div class="mini-note" style="margin-top:10px">保存多套厂商 / 中转站凭证，每个档案可维护多个候选模型；「生效配置」页签选档案即整套切换，点候选模型即时切换当前模型。档案在抽屉「保存」后即可切换。</div>`;
  $('#pageActions').innerHTML = `<button class="btn primary" id="pfAddTop">${svg(IC.plus, 14)} 新增档案</button>`;
  pane.querySelectorAll('[data-usemodel]').forEach((b) => b.onclick = async () => {
    const p = c.profiles[Number(b.dataset.usemodel)];
    if (isDrawerOpen()) return toast('请先完成档案编辑（保存或取消）', true);
    if (S.dirtyCards.size && !(await saveDoc())) return;
    try {
      const r = await api('POST', '/api/claude/use-profile', { name: p.name, model: b.dataset.m });
      toast(r.message || '已切换');
      await refresh();
    } catch (e) { toast(e.message, true); }
  });
  pane.querySelectorAll('[data-pfedit]').forEach((b) => b.onclick = () => openProfileDrawer(c, Number(b.dataset.pfedit), el));
  pane.querySelectorAll('[data-pfdel]').forEach((b) => b.onclick = async () => {
    const i = Number(b.dataset.pfdel);
    const p = c.profiles[i];
    if (!(await confirmDialog({
      title: '删除档案',
      message: `确认删除档案「${esc(p.name || '未命名')}」？删除将立即保存生效。`,
      danger: true,
      confirmText: '删除',
    }))) return;
    c.profiles.splice(i, 1);
    await saveDoc();
    renderClaude(el);
  });
  const add = () => {
    const snap = snapDoc(); // 快照先于 push：取消时连同新增空档案一并回滚
    c.profiles.push({ name: '' });
    openProfileDrawer(c, c.profiles.length - 1, el, snap);
  };
  const pfAdd = pane.querySelector('#pfAdd');
  if (pfAdd) pfAdd.onclick = add;
  const pfAddTop = $('#pfAddTop');
  if (pfAddTop) pfAddTop.onclick = add;
}

/** 档案编辑抽屉：实时 mutate profile 对象，「保存」一次落盘；凭证留空 = 保持不变（PUT 按 name 对齐回填）。
 * 模型候选 chips：手输 / 「拉取模型」下拉添加，点 × 删除；默认模型（「设为当前」用）从候选中选 */
function openProfileDrawer(c, i, el, snap) {
  const p = c.profiles[i];
  const hasT = p.auth_token?.secretSet, hasK = p.api_key?.secretSet;
  const ctype = hasT ? 'auth_token' : 'api_key';
  openDrawer({
    title: `厂商档案${p.name ? `：${p.name}` : '（新档案）'}`,
    snap: snap ?? snapDoc(),
    bodyHtml: `
      <label class="fld">档案名（显示用，如「官方」「中转站A」）</label>
      <input type="text" id="dwPfName" value="${esc(p.name || '')}" placeholder="中转站A">
      <label class="fld">凭证类型</label>
      <div class="radio-row">
        <label><input type="radio" name="dwCred" value="auth_token" ${ctype === 'auth_token' ? 'checked' : ''}> AUTH_TOKEN（Bearer，中转站常用）</label>
        <label><input type="radio" name="dwCred" value="api_key" ${ctype === 'api_key' ? 'checked' : ''}> API_KEY（官方，x-api-key）</label>
      </div>
      <label class="fld" id="dwPfCredLabel">${ctype === 'api_key' ? 'API Key' : 'Auth Token'} ${hasT || hasK ? '（已设置，留空不改）' : ''}</label>
      <input type="password" id="dwPfCred" placeholder="${hasT || hasK ? '留空保持不变' : 'sk-…'}">
      <label class="fld">BASE_URL（官方留空）</label>
      <input type="text" id="dwPfBase" value="${esc(p.base_url || '')}" placeholder="https://relay.example.com">
      <label class="fld">候选模型 <span class="tip" data-tip="列表页点模型名即时切换当前模型；勾选 1M 添加的模型带 [1m] 后缀">${svg(IC.info, 13)}</span></label>
      <div class="chips echips on-box" id="dwPfModels" style="margin:0"></div>
      <div class="frow" style="margin-top:10px;max-width:640px">
        <div><input type="text" id="dwPfNewModel" list="dwPfModelList" placeholder="输入或下拉选择后点「添加」">
          <datalist id="dwPfModelList"></datalist></div>
        <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;padding-top:6px"><input type="checkbox" id="dwPfModel1M"> 1M 上下文</label>
        <div class="btn-wrap"><button class="btn" id="dwPfAddModel">添加</button></div>
        <div class="btn-wrap"><button class="btn" id="dwPfPull">拉取模型</button></div>
      </div>
      <div class="hint" style="margin-top:6px">勾选「1M 上下文」添加的模型名带 <code>[1m]</code> 后缀（Claude Code 官方 1M 上下文格式，切换后写入 ANTHROPIC_MODEL）；勾选前请确认厂商支持 1M 上下文。</div>
      <label class="fld" style="margin-top:14px">默认模型（点档案卡即用此模型切换，通常为候选之一）</label>
      <input type="text" id="dwPfModel" list="dwPfModelsList" value="${esc(p.model || '')}" placeholder="留空 = 切换时不指定" style="max-width:420px">
      <datalist id="dwPfModelsList"></datalist>`,
    footHtml: `<button class="btn danger" id="dwPfDel">删除档案</button><span class="sp"></span><button class="btn" id="dwPfCancel">取消</button><button class="btn primary" id="dwPfSave">保存</button>`,
    onMount: ({ body, foot }) => {
      body.querySelectorAll('input[name=dwCred]').forEach((r) => r.onchange = () => {
        const v = body.querySelector('input[name=dwCred]:checked').value;
        const t = v === 'auth_token' && hasT ? `（已设置 ${esc(p.auth_token.secretHint)}，留空不改）` : '';
        const k = v === 'api_key' && hasK ? `（已设置 ${esc(p.api_key.secretHint)}，留空不改）` : '';
        body.querySelector('#dwPfCredLabel').textContent = `${v === 'api_key' ? 'API Key' : 'Auth Token'}${t || k}`;
      });
      body.querySelector('#dwPfName').oninput = (e) => { p.name = e.target.value.trim(); };
      body.querySelector('#dwPfCred').oninput = (e) => {
        const v = e.target.value.trim();
        const key = body.querySelector('input[name=dwCred]:checked').value;
        const other = key === 'auth_token' ? 'api_key' : 'auth_token';
        if (v) { p[key] = v; delete p[other]; }
        else if (!(p[key] && typeof p[key] === 'object')) delete p[key]; // 空输入：保留原脱敏对象（未修改语义）
      };
      body.querySelector('#dwPfBase').oninput = (e) => { p.base_url = e.target.value.trim() || undefined; };
      // ---- 候选模型 chips：本地数组编辑，同步 p.models ----
      const models = [...(p.models || [])];
      const syncModels = () => {
        if (models.length) p.models = [...models];
        else delete p.models;
        const box = body.querySelector('#dwPfModels');
        box.innerHTML = models.map((m, mi) => {
          const { name, tag } = splitModelTag(m);
          return `<span class="chip">${esc(name)}${tag ? '<span class="tag ok" style="margin-left:4px">1M</span>' : ''}<button type="button" class="x" data-rm="${mi}" title="移除">×</button></span>`;
        }).join('')
          || '<span class="hint">尚无候选模型（不影响使用，可随时添加）</span>';
        box.querySelectorAll('button[data-rm]').forEach((b) => b.onclick = () => {
          models.splice(Number(b.dataset.rm), 1);
          syncModels();
        });
        body.querySelector('#dwPfModelsList').innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
      };
      syncModels();
      const addModel = () => {
        const inp = body.querySelector('#dwPfNewModel');
        const cb = body.querySelector('#dwPfModel1M');
        const v = inp.value.trim();
        if (!v) return;
        // 勾选 1M：拼官方 [1m] 后缀（输入已带后缀时幂等）；添加后自动取消勾选
        const full = withModelTag(v, cb.checked);
        if (!models.includes(full)) models.push(full);
        inp.value = '';
        cb.checked = false;
        syncModels();
      };
      body.querySelector('#dwPfAddModel').onclick = addModel;
      body.querySelector('#dwPfNewModel').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addModel(); } };
      body.querySelector('#dwPfModel').oninput = (e) => { p.model = e.target.value.trim() || undefined; };
      body.querySelector('#dwPfPull').onclick = () => {
        const typed = body.querySelector('#dwPfCred').value.trim();
        const key = body.querySelector('input[name=dwCred]:checked').value;
        pullModels(() => ({
          base_url: body.querySelector('#dwPfBase').value.trim(),
          ...(p.name ? { profile_name: p.name } : {}),
          ...(typed ? { [key]: typed } : {}),
        }), body.querySelector('#dwPfPull'), 'dwPfModelList');
      };
      foot.querySelector('#dwPfDel').onclick = async () => {
        if (!(await confirmDialog({
          title: '删除档案',
          message: `确认删除档案「${esc(p.name || '未命名')}」？删除将立即保存生效。`,
          danger: true,
          confirmText: '删除',
        }))) return;
        c.profiles.splice(i, 1);
        if (await saveDoc()) closeDrawer();
        else cancelDrawer();
      };
      foot.querySelector('#dwPfCancel').onclick = cancelDrawer;
      foot.querySelector('#dwPfSave').onclick = async () => {
        if (await saveDoc()) closeDrawer();
      };
    },
  });
}

export const page = {
  id: 'claude',
  title: 'Claude 认证',
  desc: '认证模式、生效凭证与厂商档案；bridge 托管时从档案中选择，无须手填',
  icon: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  render: renderClaude,
};
