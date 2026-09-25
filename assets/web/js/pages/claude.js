// ============ Claude 认证 ============
import { S, $, esc, toast, api, snapDoc, saveDoc, cardDirty, applyDirty, refresh } from '../core.js';
import { openDrawer, closeDrawer, cancelDrawer, saveBarHtml, dirtyDotHtml, bindSaveBar, confirmDialog } from '../ui.js';

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

function renderClaude(el) {
  const c = S.doc.claude || (S.doc.claude = {});
  c.profiles = c.profiles || [];
  const mode = c.mode || 'inherit';
  const hasToken = c.auth_token?.secretSet, hasKey = c.api_key?.secretSet;
  const credType = hasToken ? 'auth_token' : 'api_key';
  const cur = S.status?.claude?.current || {};
  const hint = (h) => h?.secretSet ? `已设置（${esc(h.secretHint)}）` : '未设置';
  el.innerHTML = `
  <div class="card">
    <h3>当前生效配置</h3>
    <div class="desc">认证模式与实际生效的值（凭证脱敏显示）。managed 模式改动保存后对后续任务即生效；模式切换需重启。</div>
    <table>
      <tr><td style="width:150px">认证模式</td><td>${mode === 'managed' ? 'bridge 托管（managed）' : '继承本机 ~/.claude（inherit）'}</td></tr>
      <tr><td>BASE_URL</td><td>${cur.baseUrl ? `<code>${esc(cur.baseUrl)}</code>` : '<span class="hint">官方默认（api.anthropic.com）</span>'}</td></tr>
      <tr><td>模型</td><td>${(() => { const { name, tag } = splitModelTag(cur.model || ''); return cur.model ? `<code>${esc(name)}</code>${tag ? ' <span class="tag ok">1M 上下文</span>' : ''}` : '<span class="hint">未设置（CLI 默认）</span>'; })()}</td></tr>
      <tr><td>Auth Token</td><td>${hint(cur.authToken)}</td></tr>
      <tr><td>API Key</td><td>${hint(cur.apiKey)}</td></tr>
      <tr><td>自定义环境变量</td><td>${cur.envCount ? `${cur.envCount} 个（写入托管 settings.json env 块，MCP 工具可用）` : '<span class="hint">无</span>'}</td></tr>
      <tr><td>settings.json</td><td><code>${esc(S.status?.claude?.settingsPath || '—')}</code></td></tr>
    </table>
    ${mode !== 'managed' ? '<div class="desc" style="margin-top:8px">inherit 模式上表为本机 ~/.claude 实际状态，本页不修改本机登录。要管理多厂商档案并一键切换，请切到 bridge 托管。</div>' : ''}
  </div>
  <div class="card">
    <h3>认证模式${dirtyDotHtml('claude')}</h3>
    <div class="radio-row">
      <label><input type="radio" name="mode" value="inherit" ${mode === 'inherit' ? 'checked' : ''}> 继承本机 ~/.claude（已在本机 claude login）</label>
      <label><input type="radio" name="mode" value="managed" ${mode === 'managed' ? 'checked' : ''}> bridge 托管（填 API Key / Token，无需本机登录）</label>
    </div>
    <div id="managedBox" style="${mode === 'managed' ? '' : 'display:none'}">
      <div class="desc" style="margin:6px 0 2px">常规用法：在下方「厂商档案」保存凭证后点「设为当前」即可，无须手动填写。</div>
      <details style="margin-top:4px">
        <summary style="cursor:pointer;font-size:13px;color:var(--muted)">高级：手动编辑当前生效凭证</summary>
        <div style="margin-top:10px">
          <div class="radio-row">
            <label><input type="radio" name="cred" value="auth_token" ${credType === 'auth_token' ? 'checked' : ''}> AUTH_TOKEN（中转站常用，Bearer）</label>
            <label><input type="radio" name="cred" value="api_key" ${credType === 'api_key' ? 'checked' : ''}> API_KEY（官方，x-api-key）</label>
          </div>
          <div class="row">
            <div><label id="credLabel">Auth Token ${hasToken ? `（已设置 ${esc(c.auth_token.secretHint)}，留空不改）` : ''}</label>
              <input type="password" id="credVal" placeholder="${hasToken || hasKey ? '留空保持不变' : 'sk-…'}"></div>
            <div><label>BASE_URL（中转站端点，官方留空）</label><input type="text" id="baseUrl" value="${esc(c.base_url || '')}" placeholder="https://relay.example.com"></div>
          </div>
          <div class="row" style="align-items:end">
            <div style="flex:1"><label>模型（写入 settings.json，可留空）</label>
              <input type="text" id="model" list="modelList" value="${esc(c.model || '')}" placeholder="claude-sonnet-5 或任意厂商模型名">
              <datalist id="modelList"></datalist></div>
            <button class="btn" id="btnModels">拉取模型</button>
          </div>
          <div class="hint" style="margin-top:6px">「拉取模型」用当前表单的 BASE_URL 与凭证（未填则用已保存值）请求模型列表：自动兼容带 / 不带 /v1 的地址与 Bearer / x-api-key 认证；失败可手动填写。</div>
        </div>
      </details>
      <h4 style="margin:14px 0 2px;font-size:13.5px">环境变量（写入托管 settings.json，MCP 工具依赖的自定义变量在此配置）</h4>
      <div class="hint" style="margin-bottom:6px">本机 ~/.claude/settings.json 已有的非认证键会自动继承；此处配置的键<b>优先级更高</b>（覆盖继承值）。认证相关（ANTHROPIC_AUTH_TOKEN / API_KEY / BASE_URL / MODEL）不在此生效，请用上方认证表单。</div>
      <table><thead><tr><th style="width:38%">KEY</th><th>VALUE</th><th style="width:44px"></th></tr></thead><tbody id="claudeEnvBody"></tbody></table>
      <button class="btn sm" id="claudeEnvAdd" style="margin-top:6px">+ 添加变量</button>
      ${saveBarHtml('claude')}
    </div>
    <div class="footer-note">managed 模式把认证写入 <code>~/.lark-claudecode-bridge/claude/settings.json</code>，与本机 ~/.claude 完全隔离；认证/模型改动保存后对后续任务即生效，模式切换需重启。</div>
  </div>
  <div class="card" id="pfCard" style="${mode === 'managed' ? '' : 'display:none'}">
    <h3>厂商档案</h3>
    <div class="desc">保存多套厂商 / 中转站凭证，每个档案可维护多个候选模型（如 fable / opus / sonnet / haiku）。「设为当前」整套切换；点候选模型即时切换当前模型。档案在抽屉「保存」后即可切换。</div>
    <div class="list-toolbar"><button class="btn primary" id="pfAdd">+ 新增档案</button></div>
    <table><thead><tr><th style="width:120px">名称</th><th style="width:100px">凭证类型</th><th>BASE_URL</th><th>模型（点击切换）</th><th style="width:190px">操作</th></tr></thead>
    <tbody id="pfBody"></tbody></table>
  </div>`;
  document.querySelectorAll('input[name=mode]').forEach((r) => r.onchange = () => {
    c.mode = document.querySelector('input[name=mode]:checked').value;
    cardDirty('claude', c.mode === 'managed'); // inherit 无 managed 表单语义：不标记未保存
    renderClaude(el); // 模式切换影响多卡显隐，整页重渲染（radio 状态由 c.mode 驱动）
  });
  bindSaveBar(el, 'claude');
  const updCredLabel = () => {
    const v = document.querySelector('input[name=cred]:checked').value;
    $('#credLabel').innerHTML = (v === 'api_key' ? 'API Key' : 'Auth Token')
      + (v === 'auth_token' && hasToken ? `（已设置 ${esc(c.auth_token.secretHint)}，留空不改）` : '')
      + (v === 'api_key' && hasKey ? `（已设置 ${esc(c.api_key.secretHint)}，留空不改）` : '');
  };
  document.querySelectorAll('input[name=cred]').forEach((r) => r.onchange = () => { updCredLabel(); cardDirty('claude', true); });
  $('#credVal').oninput = () => {
    const v = $('#credVal').value.trim();
    const key = document.querySelector('input[name=cred]:checked').value;
    const other = key === 'auth_token' ? 'api_key' : 'auth_token';
    if (v) { c[key] = v; c[other] = ''; } else { c[key] = { secretSet: key === 'auth_token' ? hasToken : hasKey }; }
    cardDirty('claude', true);
  };
  $('#baseUrl').oninput = () => { c.base_url = $('#baseUrl').value.trim() || undefined; cardDirty('claude', true); };
  $('#model').oninput = () => { c.model = $('#model').value.trim() || undefined; cardDirty('claude', true); };
  // ---- 环境变量行编辑（claude.env）：对象 ↔ 行数组，KEY/VALUE 实时写回（同 apps 抽屉 env 模式） ----
  const cEnvRows = Object.entries(c.env || {}).map(([key, value]) => ({ key, value: String(value) }));
  const syncClaudeEnv = () => {
    const obj = {};
    for (const r of cEnvRows) if (r.key.trim()) obj[r.key.trim()] = r.value;
    if (Object.keys(obj).length) c.env = obj; else delete c.env;
  };
  const renderClaudeEnv = () => {
    const tb = $('#claudeEnvBody');
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
  const envAdd = $('#claudeEnvAdd');
  if (envAdd) envAdd.onclick = () => { cEnvRows.push({ key: '', value: '' }); renderClaudeEnv(); tbFocusLastKey(); };
  const tbFocusLastKey = () => {
    const inputs = document.querySelectorAll('#claudeEnvBody input[data-col=key]');
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  };
  renderClaudeEnv();
  $('#btnModels').onclick = () => {
    const typed = $('#credVal').value.trim();
    const key = document.querySelector('input[name=cred]:checked').value;
    pullModels(() => ({ base_url: $('#baseUrl').value.trim(), ...(typed ? { [key]: typed } : {}) }), $('#btnModels'), 'modelList');
  };
  // ---- 厂商档案列表 ----
  const renderProfiles = () => {
    const body = $('#pfBody');
    if (!body) return;
    if (!c.profiles.length) { body.innerHTML = '<tr><td colspan="5" class="hint">尚无档案，点右上「+ 新增档案」创建</td></tr>'; return; }
    const inUse = (p) => {
      // 前端无凭证明文，用尾 4 位提示 + baseUrl 近似判断「使用中」（当前模型在 chips 上单独高亮）
      const credSame = (p.auth_token?.secretHint && cur.authToken?.secretHint === p.auth_token.secretHint)
        || (p.api_key?.secretHint && cur.apiKey?.secretHint === p.api_key.secretHint);
      return credSame && (p.base_url || '') === (cur.baseUrl || '');
    };
    const modelChips = (p, active, i) => {
      const list = [...(p.models || []), ...(p.model && !(p.models || []).includes(p.model) ? [p.model] : [])];
      return list.map((m) => {
        const { name, tag } = splitModelTag(m);
        return `<button class="btn sm${active && cur.model === m ? ' primary' : ''}" data-op="usemodel" data-i="${i}" data-m="${esc(m)}" title="点击切换为当前模型">${esc(name)}${tag ? ' <span class="tag ok">1M</span>' : ''}${active && cur.model === m ? ' ✓' : ''}</button>`;
      }).join(' ')
        || '<span class="hint">—</span>';
    };
    body.innerHTML = c.profiles.map((p, i) => {
      const active = inUse(p);
      return `
      <tr>
        <td><b>${esc(p.name)}</b>${active ? '<br><span class="tag ok">使用中</span>' : ''}</td>
        <td>${p.auth_token?.secretSet ? 'AUTH_TOKEN' : p.api_key?.secretSet ? 'API_KEY' : '<span class="hint">未设凭证</span>'}</td>
        <td>${p.base_url ? `<code>${esc(p.base_url)}</code>` : '<span class="hint">官方</span>'}</td>
        <td>${modelChips(p, active, i)}</td>
        <td>
          <button class="btn sm" data-op="edit" data-i="${i}">编辑</button>
          <button class="btn sm danger" data-op="del" data-i="${i}">删除</button>
        </td>
      </tr>`;
    }).join('');
    body.querySelectorAll('button[data-op]').forEach((b) => b.onclick = async () => {
      const i = Number(b.dataset.i);
      const p = c.profiles[i];
      if (b.dataset.op === 'usemodel') {
        // 切换 = 点击模型 chip（「设为当前」按钮已移除：默认模型必在候选集内，点其 chip 等效激活）。
        // 走后端端点（档案凭证明文不出进程）；编辑中先收尾，未保存改动自动落盘再切（如认证模式切换）
        if (!$('#drawerMask').hidden) return toast('请先完成档案编辑（保存或取消）', true);
        if (S.dirtyCards.size && !(await saveDoc())) return; // 保存失败已 toast 原因，保持编辑态不切换
        try {
          const r = await api('POST', '/api/claude/use-profile', { name: p.name, model: b.dataset.m });
          toast(r.message || '已切换');
          await refresh();
        } catch (e) { toast(e.message, true); }
        return;
      }
      if (b.dataset.op === 'del') {
        if (!(await confirmDialog({
          title: '删除档案',
          message: `确认删除档案「${esc(p.name || '未命名')}」？删除将立即保存生效。`,
          danger: true,
          confirmText: '删除',
        }))) return;
        c.profiles.splice(i, 1);
        await saveDoc();
        return;
      }
      openProfileDrawer(c, i, el);
    });
  };
  renderProfiles();
  $('#pfAdd').onclick = () => {
    const snap = snapDoc(); // 快照先于 push：取消时连同新增空档案一并回滚
    c.profiles.push({ name: '' });
    renderClaude(el);
    openProfileDrawer(c, c.profiles.length - 1, el, snap);
  };
  applyDirty(); // 模式切换等 handler 先 cardDirty 再整卡重渲染：回放防止保存条/圆点随重建丢失
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
      <label>档案名（显示用，如「官方」「中转站A」）</label>
      <input type="text" id="dwPfName" value="${esc(p.name || '')}" placeholder="中转站A">
      <div class="radio-row">
        <label><input type="radio" name="dwCred" value="auth_token" ${ctype === 'auth_token' ? 'checked' : ''}> AUTH_TOKEN（Bearer，中转站常用）</label>
        <label><input type="radio" name="dwCred" value="api_key" ${ctype === 'api_key' ? 'checked' : ''}> API_KEY（官方，x-api-key）</label>
      </div>
      <label id="dwPfCredLabel">${ctype === 'api_key' ? 'API Key' : 'Auth Token'} ${hasT || hasK ? '（已设置，留空不改）' : ''}</label>
      <input type="password" id="dwPfCred" placeholder="${hasT || hasK ? '留空保持不变' : 'sk-…'}">
      <label>BASE_URL（中转站端点，官方留空）</label>
      <input type="text" id="dwPfBase" value="${esc(p.base_url || '')}" placeholder="https://relay.example.com">
      <h4 style="margin:18px 0 4px;font-size:13.5px">候选模型（fable / opus / sonnet / haiku 等，各存一条；列表页点击即切换当前模型）</h4>
      <div class="chips" id="dwPfModels"></div>
      <div class="row" style="align-items:end;max-width:640px">
        <div style="flex:1"><input type="text" id="dwPfNewModel" list="dwPfModelList" placeholder="输入或下拉选择后点「添加」">
          <datalist id="dwPfModelList"></datalist></div>
        <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;padding-bottom:6px"><input type="checkbox" id="dwPfModel1M"> 1M 上下文</label>
        <div class="btn-wrap"><button class="btn" id="dwPfAddModel">添加</button></div>
        <div class="btn-wrap"><button class="btn" id="dwPfPull">拉取模型</button></div>
      </div>
      <div class="hint" style="margin-top:6px">勾选「1M 上下文」添加的模型名带 <code>[1m]</code> 后缀（Claude Code 官方 1M 上下文格式，切换后写入 ANTHROPIC_MODEL）；勾选前请确认厂商支持 1M 上下文。</div>
      <div class="row" style="align-items:end;margin-top:12px;max-width:600px">
        <div style="flex:1"><label>默认模型（点「设为当前」时使用，通常为候选之一）</label>
          <input type="text" id="dwPfModel" list="dwPfModelsList" value="${esc(p.model || '')}" placeholder="留空 = 切换时不指定">
          <datalist id="dwPfModelsList"></datalist></div>
      </div>`,
    footHtml: `<button class="btn danger" id="dwPfDel">删除档案</button><span class="spacer"></span><button class="btn" id="dwPfCancel">取消</button><button class="btn primary" id="dwPfSave">保存</button>`,
    onMount: () => {
      document.querySelectorAll('input[name=dwCred]').forEach((r) => r.onchange = () => {
        const v = document.querySelector('input[name=dwCred]:checked').value;
        const t = v === 'auth_token' && hasT ? `（已设置 ${esc(p.auth_token.secretHint)}，留空不改）` : '';
        const k = v === 'api_key' && hasK ? `（已设置 ${esc(p.api_key.secretHint)}，留空不改）` : '';
        document.getElementById('dwPfCredLabel').textContent = `${v === 'api_key' ? 'API Key' : 'Auth Token'}${t || k}`;
      });
      document.getElementById('dwPfName').oninput = (e) => { p.name = e.target.value.trim(); };
      document.getElementById('dwPfCred').oninput = (e) => {
        const v = e.target.value.trim();
        const key = document.querySelector('input[name=dwCred]:checked').value;
        const other = key === 'auth_token' ? 'api_key' : 'auth_token';
        if (v) { p[key] = v; delete p[other]; }
        else if (!(p[key] && typeof p[key] === 'object')) delete p[key]; // 空输入：保留原脱敏对象（未修改语义）
      };
      document.getElementById('dwPfBase').oninput = (e) => { p.base_url = e.target.value.trim() || undefined; };
      // ---- 候选模型 chips：本地数组编辑，同步 p.models ----
      const models = [...(p.models || [])];
      const syncModels = () => {
        if (models.length) p.models = [...models];
        else delete p.models;
        const box = document.getElementById('dwPfModels');
        box.innerHTML = models.map((m, mi) => {
          const { name, tag } = splitModelTag(m);
          return `<span class="chip">${esc(name)}${tag ? '<span class="tag ok" style="margin-left:4px">1M</span>' : ''}<button type="button" data-rm="${mi}" title="移除">×</button></span>`;
        }).join('')
          || '<span class="hint">尚无候选模型（不影响使用，可随时添加）</span>';
        box.querySelectorAll('button[data-rm]').forEach((b) => b.onclick = () => {
          models.splice(Number(b.dataset.rm), 1);
          syncModels();
        });
        document.getElementById('dwPfModelsList').innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
      };
      syncModels();
      const addModel = () => {
        const inp = document.getElementById('dwPfNewModel');
        const cb = document.getElementById('dwPfModel1M');
        const v = inp.value.trim();
        if (!v) return;
        // 勾选 1M：拼官方 [1m] 后缀（输入已带后缀时幂等）；添加后自动取消勾选
        const full = withModelTag(v, cb.checked);
        if (!models.includes(full)) models.push(full);
        inp.value = '';
        cb.checked = false;
        syncModels();
      };
      document.getElementById('dwPfAddModel').onclick = addModel;
      document.getElementById('dwPfNewModel').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addModel(); } };
      document.getElementById('dwPfModel').oninput = (e) => { p.model = e.target.value.trim() || undefined; };
      document.getElementById('dwPfPull').onclick = () => {
        const typed = document.getElementById('dwPfCred').value.trim();
        const key = document.querySelector('input[name=dwCred]:checked').value;
        pullModels(() => ({
          base_url: document.getElementById('dwPfBase').value.trim(),
          ...(p.name ? { profile_name: p.name } : {}),
          ...(typed ? { [key]: typed } : {}),
        }), document.getElementById('dwPfPull'), 'dwPfModelList');
      };
      document.getElementById('dwPfDel').onclick = async () => {
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
      document.getElementById('dwPfCancel').onclick = cancelDrawer;
      document.getElementById('dwPfSave').onclick = async () => {
        if (await saveDoc()) closeDrawer();
      };
    },
  });
}

export const page = {
  id: 'claude',
  title: 'Claude 认证',
  icon: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  render: renderClaude,
};
