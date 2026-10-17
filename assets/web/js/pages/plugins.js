// ============ 插件（已装列表 + 管理市场 / 从市场安装 双卡；市场卡在左：先添加市场再安装） ============
import { $, esc, toast, api } from '../core.js';
import { confirmDialog } from '../ui.js';

// 点击 combobox 之外收起面板的监听只注册一次（模块级标志，等价原 document.body 标记法）
let comboHideBound = false;
let badgeCount = 0; // 有新版本的插件数（导航徽标；进过本页后可见）

async function renderPlugins(el) {
  el.innerHTML = `
  <div class="panel">
    <header class="panel-head"><h3>已安装插件</h3>
      <div class="panel-actions"><button class="btn sm" id="plCheckUpdate">检查更新</button></div></header>
    <div class="panel-body">
      <div class="hint" id="plSyncNote" hidden style="margin:0 0 8px"></div>
      <table><thead><tr><th>插件</th><th style="width:120px">市场</th><th style="width:130px">来源</th><th style="width:170px">版本</th><th style="width:90px">状态</th><th style="width:230px">操作</th></tr></thead>
      <tbody id="plBody"><tr><td colspan="6" class="hint">加载中…</td></tr></tbody></table>
    </div>
    <footer class="panel-foot">两处目录的已启用插件都会自动加载（managed 托管目录优先）：本机 <code>~/.claude</code> 与 bridge 托管目录 <code id="pluginDir">…</code>。启停 / 更新后<b>下一条消息生效</b>，无须重启；飞书端亦可用 <code>/plugin install xxx@marketplace</code>（仅管理员）。</footer>
  </div>
  <div class="grid2" style="gap:16px;align-items:start">
    <div class="panel" style="margin:0">
      <header class="panel-head"><h3>管理市场</h3></header>
      <div class="panel-body">
        <div class="mini-note" style="margin-bottom:10px">安装来源为已添加的市场：新插件先在这里「添加市场」，再到右侧安装。</div>
        <label class="fld">添加市场（git 地址或本机路径）</label>
        <div class="input-btn"><input type="text" id="plMarket" placeholder="https://github.com/…/marketplace"><button class="btn" id="plDoMarketAdd">添加</button></div>
        <label class="fld" style="margin-top:12px">目标目录</label>
        <div class="input-btn"><select id="plMarketDir">
          <option value="user" selected>本机 ~/.claude</option>
          <option value="bridge">bridge 托管目录</option>
        </select><button class="btn" id="plDoMarketUpdate">全部更新</button></div>
        <div class="mini-note" style="margin-top:8px">「全部更新」= 刷新市场索引 + 逐个更新该目录所有已装插件。</div>
      </div>
    </div>
    <div class="panel" style="margin:0">
      <header class="panel-head"><h3>从市场安装</h3></header>
      <div class="panel-body">
        <label class="fld">搜索插件 <span class="tip" data-tip="候选来自已添加市场的全部插件；也可在飞书端 /plugin install xxx@marketplace（仅管理员）">ⓘ</span></label>
        <div class="input-btn" style="align-items:flex-start">
          <div class="combo" style="flex:1;min-width:0">
            <input type="text" id="plInstall" placeholder="（加载中…）" autocomplete="off">
            <div class="combo-panel" id="plInstallPanel" hidden></div>
          </div>
        </div>
        <label class="fld" style="margin-top:12px">安装到</label>
        <select id="plDir">
          <option value="user" selected>本机 ~/.claude（推荐：本机 CLI 与桥接器共用一份）</option>
          <option value="bridge">bridge 托管目录</option>
        </select>
        <div style="margin-top:12px"><button class="btn primary" id="plDoInstall">安装</button></div>
      </div>
    </div>
  </div>
  <pre class="report" id="plReport" style="display:none;margin-top:0"></pre>`;
  const report = (title, text) => {
    $('#plReport').style.display = '';
    $('#plReport').textContent = `${title}\n${text}`;
  };
  let available = [];        // 当前目录可装清单（扁平化，combobox 数据源）
  let selectedInstall = '';  // 已选中安装参数 name@marketplace（输入改动即失效）
  let installed = [];        // 已装清单缓存（update-all 前端编排取该目录步骤用）
  const busyText = {
    install: '安装中…', uninstall: '卸载中…', update: '更新中…', 'update-all': '更新中…',
    'marketplace-add': '添加中…', 'marketplace-remove': '移除中…', enable: '处理中…', disable: '处理中…',
  };
  const opNames = { install: '安装', uninstall: '卸载', update: '更新', 'update-all': '全部更新', 'marketplace-add': '添加市场', 'marketplace-remove': '移除市场', enable: '启用', disable: '停用' };
  /** 远程刷新信息条：后台检查远程市场索引的状态提示（非阻断、非报错样式；空串隐藏） */
  const setSyncNote = (text) => {
    const note = $('#plSyncNote');
    if (!note) return;
    note.textContent = text || '';
    note.hidden = !text;
  };
  /** 渲染已装插件表（本地秒出与后台刷新完成两条路径共用；入参 /api/plugins 响应） */
  const renderList = (r) => {
    installed = r.plugins || [];
    badgeCount = installed.filter((p) => p.latestVersion).length;
    $('#pluginDir').textContent = r.configDir;
    const body = $('#plBody');
    if (!body) return; // 页面已切走（后台刷新回调晚于切页）
    if (!installed.length) {
      body.innerHTML = '<tr class="empty"><td colspan="6">尚未安装任何插件</td></tr>';
      return;
    }
    body.innerHTML = installed.map((p) => `
      <tr>
        <td><b>${esc(p.name)}</b></td>
        <td>${esc(p.marketplace || '-')}</td>
        <td>${p.source === 'bridge' ? '<span class="tag warn">bridge 托管</span>' : '<span class="tag off">本机 ~/.claude</span>'}</td>
        <td><span class="mono">${esc(p.version || '-')}</span>${p.latestVersion ? ` <span class="tag warn">→ ${esc(p.latestVersion)}</span>` : ''}</td>
        <td>${p.enabled ? '<span class="tag ok">已启用</span>' : '<span class="tag off">未启用</span>'}</td>
        <td class="ops">
          <button class="btn sm" data-op="update" data-arg="${esc(p.key)}" data-dir="${p.source}">更新</button>
          <button class="btn sm" data-op="${p.enabled ? 'disable' : 'enable'}" data-arg="${esc(p.key)}" data-dir="${p.source}">${p.enabled ? '停用' : '启用'}</button>
          <button class="btn sm danger" data-op="uninstall" data-arg="${esc(p.key)}" data-dir="${p.source}">卸载</button>
        </td>
      </tr>`).join('');
    body.querySelectorAll('button[data-op]').forEach((b) => b.onclick = async () => {
      const { op, arg, dir } = b.dataset;
      // 影响性操作先二次确认（启用/安装/市场添加为新增类，无需确认）
      if (op === 'disable' && !(await confirmDialog({
        title: '停用插件',
        message: `确定停用插件 <code>${esc(arg)}</code> 吗？停用后下一条消息不再加载该插件，可随时再启用。`,
        confirmText: '停用',
      }))) return;
      if (op === 'update' && !(await confirmDialog({
        title: '更新插件',
        message: `确定更新插件 <code>${esc(arg)}</code> 吗？更新后下一条消息按新版本加载。`,
        confirmText: '更新',
      }))) return;
      if (op === 'uninstall' && !(await confirmDialog({
        title: '卸载插件',
        message: `确定卸载插件 <code>${esc(arg)}</code> 吗？卸载后需重新安装才能恢复，进行中的会话不受影响。`,
        danger: true,
        confirmText: '卸载',
      }))) return;
      // 慢操作走进度弹框；亚秒级启停走轻量 act（弹框一闪而过反而干扰）
      if (op === 'enable' || op === 'disable') act(op, arg, dir, b);
      else runOpDialog(op, arg, dir, b);
    });
  };
  // 列表本地秒出：不带 refresh（纯本地文件读取，无远程市场索引等待）
  const loadLocal = async () => {
    try {
      renderList(await api('GET', '/api/plugins'));
      return true;
    } catch (e) {
      installed = [];
      const body = $('#plBody');
      if (body) body.innerHTML = `<tr><td colspan="6" class="hint">加载失败：${esc(e.message)}</td></tr>`;
      return false;
    }
  };
  // 后台刷新远程市场索引（force=true 绕过 5 分钟节流，手动「检查更新」用）：不阻塞列表，
  // 完成后仅更新版本号列（只拉最新版本号不升级插件本体）；失败降级为信息条温和提示
  // （后端本就返回本地数据 + refreshWarning），不再弹红色 toast。切页后放弃渲染
  const refreshRemote = async (force) => {
    setSyncNote('🔄 后台检查远程市场新版本中…（不影响浏览）');
    try {
      const r = await api('GET', `/api/plugins?refresh=1${force ? '&force=1' : ''}`);
      if (!$('#plBody')) return !r.refreshWarning;
      renderList(r);
      if (r.refreshWarning) {
        setSyncNote('远程市场索引刷新失败，列表为本地缓存数据（网络或市场源异常，不影响本地使用）');
      } else {
        const n = installed.filter((p) => p.latestVersion).length;
        setSyncNote(n ? `${n} 个插件有新版本（见列表「→ 版本」标注，逐个点「更新」升级）` : '');
      }
      return !r.refreshWarning;
    } catch (e) {
      if ($('#plBody')) setSyncNote(`远程市场索引刷新失败，列表为本地缓存数据（${e.message}）`);
      return false;
    }
  };

  /** 轻量操作（enable/disable 亚秒级）：按钮瞬时 loading + toast，不弹框 */
  const act = async (op, arg, dir, btn) => {
    const pageBtns = el.querySelectorAll('button');
    const old = btn ? btn.textContent : '';
    pageBtns.forEach((b) => { b.disabled = true; });
    if (btn) btn.textContent = busyText[op] || '处理中…';
    try {
      const r = await api('POST', '/api/plugins/action', { op, arg, ...(dir ? { dir } : {}) });
      report(r.ok ? `✅ ${op} 完成` : `❌ ${op} 失败`, r.text);
      await loadLocal();
      toast(r.ok ? `${opNames[op] || op}完成，下一条消息生效` : `${opNames[op] || op}失败：${r.text.slice(0, 120)}`, !r.ok);
    } catch (e) {
      report(`❌ ${op} 失败`, e.message);
      toast(e.message, true);
    } finally {
      pageBtns.forEach((b) => { b.disabled = false; });
      if (btn) btn.textContent = old;
    }
  };
  /**
   * 慢操作进度弹框（install/update/uninstall/marketplace-add/update-all）：
   * spinner + 进度条 + 逐步日志。update-all 走前端编排（marketplace-update + 逐插件
   * update，每步一请求）→ 进度真实（i/N）；单操作是单请求无内部进度 → 时间缓动模拟
   * （前 2s 直线推进，之后渐缓封顶 90%，完成跳 100%）。进行中不可关闭；完成后列表刷新。
   */
  const runOpDialog = async (op, arg, dir, btn) => {
    const dirLabel = dir === 'bridge' ? 'bridge 托管目录' : '本机 ~/.claude';
    const title = op === 'update-all'
      ? `全部更新（${dirLabel}）`
      : `${opNames[op] || op} ${arg}${dir ? `（${dirLabel}）` : ''}`;
    // update-all 编排步骤：刷新市场索引 + 该目录逐个已装插件（失败不中断，与后端聚合语义一致）
    const steps = op === 'update-all'
      ? [{ op: 'marketplace-update', arg: '', label: '刷新市场索引' },
        ...installed.filter((p) => p.source === dir).map((p) => ({ op: 'update', arg: p.key, label: `更新 ${p.key}` }))]
      : [{ op, arg, label: `${opNames[op] || op} ${arg}` }];
    // 弹框 DOM（遮罩不可点击关闭；关闭按钮完成前不存在）
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="width:min(640px,94vw)">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="br-spin" style="margin:0"></div>
        <b id="podTitle">${esc(title)}</b>
      </div>
      <div class="prog"><div class="prog-bar" id="podBar"></div></div>
      <pre class="report" id="podLog" style="margin-top:12px;max-height:220px">正在执行 claude plugin …（安装/更新可能需要拉取仓库，请稍候）</pre>
      <div class="savebar" style="justify-content:flex-end">
        <button class="btn primary" id="podClose" hidden>关闭</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const bar = mask.querySelector('#podBar');
    const log = mask.querySelector('#podLog');
    const spin = mask.querySelector('.br-spin');
    const titleEl = mask.querySelector('#podTitle');
    const closeBtn = mask.querySelector('#podClose');
    const setBar = (pct) => { bar.style.width = `${pct}%`; };
    const appendLog = (line) => { log.textContent += `\n${line}`; log.scrollTop = log.scrollHeight; };
    // 单请求无内部进度：缓动模拟；update-all 用真实 i/N 不走此定时器
    let fakePct = 0;
    const startedAt = Date.now();
    const timer = op === 'update-all' ? null : setInterval(() => {
      const elapsed = Date.now() - startedAt;
      fakePct = elapsed < 2000 ? Math.min(70, (elapsed / 2000) * 70) : Math.min(90, fakePct + 1);
      setBar(fakePct);
    }, 300);
    // 操作互斥 + 被点按钮进行时文案（遮罩之外的双保险）
    const pageBtns = el.querySelectorAll('button');
    const old = btn ? btn.textContent : '';
    pageBtns.forEach((b) => { b.disabled = true; });
    if (btn) btn.textContent = busyText[op] || '处理中…';
    report(`执行中：${op} ${arg}${dir ? `（${dirLabel}）` : ''}`, '…（安装/更新可能需要拉取仓库，请稍候）');
    const close = async () => { mask.remove(); await Promise.all([loadLocal(), loadAvailable()]); };
    try {
      let allOk = true;
      const lines = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (op === 'update-all') setBar(Math.round(((i + 1) / steps.length) * 100));
        const r = await api('POST', '/api/plugins/action', { op: s.op, arg: s.arg, ...(dir ? { dir } : {}) });
        const line = `${r.ok ? '✅' : '❌'} ${s.label}${r.ok ? '' : `：${(r.text || '').split('\n').slice(0, 3).join(' ⏎ ').slice(0, 300)}`}`;
        lines.push(line);
        appendLog(line);
        if (!r.ok) allOk = false;
      }
      if (timer) clearInterval(timer);
      setBar(100);
      bar.classList.add('done');
      spin.style.display = 'none';
      titleEl.textContent = `${allOk ? '✅' : '❌'} ${title} · ${allOk ? '完成' : '部分失败（详见日志与底部全文）'}`;
      report(allOk ? `✅ ${op} 完成` : `❌ ${op} 部分失败`, lines.join('\n'));
      closeBtn.hidden = false;
      closeBtn.onclick = () => void close();
    } catch (e) {
      if (timer) clearInterval(timer);
      setBar(100);
      spin.style.display = 'none';
      titleEl.textContent = `❌ ${title} · 失败`;
      appendLog(`❌ 请求失败：${e.message}`);
      report(`❌ ${op} 失败`, e.message);
      closeBtn.hidden = false;
      closeBtn.onclick = () => void close();
    } finally {
      pageBtns.forEach((b) => { b.disabled = false; });
      if (btn) btn.textContent = old;
    }
  };
  /** 安装 combobox 数据：该目录已添加市场里的可安装插件（扁平化 + 关键词过滤面板） */
  const loadAvailable = async () => {
    const input = $('#plInstall');
    if (!input) return;
    try {
      const r = await api('GET', `/api/plugins/available?dir=${$('#plDir').value}`);
      available = [];
      for (const m of r.marketplaces || []) {
        for (const p of m.plugins || []) {
          available.push({ key: `${p.name}@${m.name}`, name: p.name, market: m.name, version: p.version || '', description: p.description || '' });
        }
      }
      $('#plDoInstall').disabled = !available.length;
      input.placeholder = available.length ? '输入关键词搜索插件，从结果中选择' : '（请先在左侧添加市场）';
    } catch (e) {
      available = [];
      $('#plDoInstall').disabled = true;
      input.placeholder = `（加载失败：${e.message}）`;
    }
    input.value = '';
    selectedInstall = '';
    hidePanel();
  };
  const hidePanel = () => { const p = $('#plInstallPanel'); if (p) p.hidden = true; };
  const pickInstall = (key) => {
    selectedInstall = key;
    $('#plInstall').value = key;
    hidePanel();
  };
  const showMatches = () => {
    const panel = $('#plInstallPanel');
    if (!panel) return;
    const q = $('#plInstall').value.trim().toLowerCase();
    const hits = q
      ? available.filter((it) => `${it.name} ${it.description} ${it.market}`.toLowerCase().includes(q))
      : available;
    const shown = hits.slice(0, 50);
    panel.hidden = false;
    panel.innerHTML = shown.length
      ? shown.map((it) => `<div class="combo-item" data-key="${esc(it.key)}"><b>${esc(it.name)}</b><span class="tag off">${esc(it.market)}</span>${it.version ? ` <span class="hint">v${esc(it.version)}</span>` : ''}${it.description ? `<div class="hint">${esc(it.description.slice(0, 80))}</div>` : ''}</div>`).join('')
        + (hits.length > shown.length ? `<div class="combo-empty">仅显示前 ${shown.length} 项，继续输入关键词缩小范围</div>` : '')
      : `<div class="combo-empty">${q ? '无匹配插件' : '（该目录还没有可安装插件）'}</div>`;
    panel.querySelectorAll('.combo-item').forEach((item) => {
      item.onmousedown = (e) => { e.preventDefault(); pickInstall(item.dataset.key); }; // mousedown+preventDefault 防输入框 blur 抢先收起面板
    });
  };
  $('#plInstall').oninput = () => { selectedInstall = ''; showMatches(); };
  $('#plInstall').onfocus = showMatches;
  $('#plInstall').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = $('#plInstallPanel')?.querySelector('.combo-item');
      if (first) pickInstall(first.dataset.key);
    } else if (e.key === 'Escape') hidePanel();
  };
  // 点击 combobox 之外收起面板（只注册一次：hidePanel 内 $ 按 id 查询当前 DOM，重渲染后仍指向新面板）
  if (!comboHideBound) {
    comboHideBound = true;
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('.combo')) hidePanel();
    });
  }
  $('#plDoInstall').onclick = () => {
    if (!selectedInstall) return toast('请从搜索结果中选择要安装的插件', true);
    runOpDialog('install', selectedInstall, $('#plDir').value, $('#plDoInstall'));
  };
  $('#plDir').onchange = loadAvailable; // 安装目标目录切换 → 可装清单随之变化
  // 手动「检查更新」：force 绕过节流立即刷新远程市场索引，汇总提示有新版的插件数
  //（只检测新版本号，升级仍由用户逐个点「更新」/「全部更新」）
  $('#plCheckUpdate').onclick = async () => {
    const btn = $('#plCheckUpdate');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…';
    try {
      const ok = await refreshRemote(true);
      if (!ok) return; // 刷新失败已在信息条提示，不再误报「全部最新」
      const n = installed.filter((p) => p.latestVersion).length;
      toast(n ? `${n} 个插件有新版本（见列表「→ 版本」标注，逐个点「更新」升级）` : '已检查：所有插件均为最新版本');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
  $('#plDoMarketAdd').onclick = () => {
    const v = $('#plMarket').value.trim();
    if (!v) return toast('请填写 marketplace git 地址或本机路径', true);
    // 安装下拉的目录跟随市场添加的目标目录：两处 select 独立时容易出现
    // 「市场添加到了 bridge、安装下拉还在 user」，新市场里的插件在默认视图搜不到
    $('#plDir').value = $('#plMarketDir').value;
    runOpDialog('marketplace-add', v, $('#plMarketDir').value, $('#plDoMarketAdd'));
  };
  $('#plDoMarketUpdate').onclick = async () => {
    // 影响面大（该目录全部已装插件逐个更新）：先二次确认
    const dirLabel = $('#plMarketDir').value === 'bridge' ? 'bridge 托管目录' : '本机 ~/.claude';
    if (!(await confirmDialog({
      title: '全部更新',
      message: `将刷新市场索引，并逐个更新「${dirLabel}」下的全部已装插件。确定继续？`,
      confirmText: '全部更新',
    }))) return;
    runOpDialog('update-all', '', $('#plMarketDir').value, $('#plDoMarketUpdate'));
  };
  // 列表本地秒出；远程市场索引后台检查不阻塞（切页后回调自动放弃渲染）
  await Promise.all([loadLocal(), loadAvailable()]);
  void refreshRemote(false);
}

export const page = {
  id: 'plugins',
  title: '插件',
  desc: '两处目录的 Claude Code 插件统一管理，改动下一条消息自动生效',
  legend: false,
  badge: () => (badgeCount ? `<span class="nav-badge">${badgeCount}</span>` : ''),
  icon: '<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/>',
  render: renderPlugins,
};
