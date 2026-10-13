// ============ 记忆增强（OpenViking 长期记忆，生命周期方案 §6.7/§6.8/§6.9） ============
// 双视图页面（互斥渲染，消除「未安装却看一堆服务状态行」的错位）：
// - 未安装向导（!serverFound && !healthy && 非远程模式）：引导横幅（⚡ 一键安装 + 五步流水线
//   水平 stepper，模型未保存时安装置灰）+ 模型配置（安装前置）+ 外部服务入口 + 折叠手动指引。
// - 已安装：总开关卡（OFF 时下方整体置灰仅查看）+ 服务状态卡（deriveState 八态精确状态横幅
//   + 关键信息网格；启停 / 检查修复 / 刷新按钮就在卡标题右侧——状态与操作同屏）+ 模型配置卡。
// 配置读写走标准 doc 管道（saveDoc → PUT /api/config，secret 自动回填）；测试连接走
// /api/memory/test-connection（表单现值，不落盘）；安装/启停走 /api/memory/install|start|stop。
// 安装回写会改 config.yaml——完成后走 refresh()（重拉 S.doc 再渲染），避免陈旧 doc 覆盖回写。
import { S, $, esc, api, toast, saveDoc, hooks, refresh } from '../core.js';
import { confirmDialog } from '../ui.js';

/** 服务商预设（§6.8 填表助手：只预填已知值，全部可见可改） */
const PRESETS = {
  glm: { label: '智谱 GLM', api_base: 'https://open.bigmodel.cn/api/paas/v4', vlm_model: 'glm-4.7', embedding_model: 'embedding-3', key_hint: 'open.bigmodel.cn 的 API Key' },
  volcengine: { label: '火山方舟', api_base: 'https://ark.cn-beijing.volces.com/api/v3', vlm_model: '', embedding_model: '', key_hint: '方舟 API Key；模型名填推理接入点 EP ID' },
  'openai-compatible': { label: 'OpenAI 兼容（中转 / 自建）', api_base: '', vlm_model: '', embedding_model: '', key_hint: '任意 OpenAI 协议端点的 Key（本地端点可留空）' },
  ollama: { label: 'Ollama 本地（零 Key）', api_base: 'http://127.0.0.1:11434/v1', vlm_model: 'qwen3:8b', embedding_model: 'nomic-embed-text', key_hint: '本地服务无需 Key' },
};
const DEFAULT_ENDPOINT = 'http://127.0.0.1:1933';
const DOC_URL = 'https://github.com/volcengine/OpenViking';

/** 探活失败分类 → 下一步行动建议（后端 reason 驱动；not-running 由状态机接管，不在此列） */
const REASON_HINT = {
  auth: '鉴权失败——服务为 api_key 模式时，检查 ov.conf 的 root key 与本页保存的 API Key 是否一致（一键安装会自动对齐）',
  timeout: '服务无响应——进程可能卡死，可「一键检查 / 修复」重拉',
  unreachable: '端点不可达——检查服务端点地址与网络（远程模式常见），或服务是否监听该地址',
  'http-error': '服务返回异常状态码——可「一键检查 / 修复」重拉，或查看服务日志定位',
  unhealthy: '服务进程在但自报异常——可「一键检查 / 修复」重拉，或查看服务日志定位',
};

/** 向导 idle 态的五步预览（真实进度以 /api/memory/install/status 为准） */
const IDLE_STEPS = [
  { id: 'runtime', title: '运行时（uv）', status: 'pending' },
  { id: 'service', title: '安装 OpenViking 服务', status: 'pending' },
  { id: 'config', title: '生成服务配置（ov.conf）', status: 'pending' },
  { id: 'start', title: '拉起受管服务', status: 'pending' },
  { id: 'plugin', title: '接入记忆插件', status: 'pending' },
];

/** 路径缩短（家目录前缀折叠为 ~） */
const shortPath = (p) => esc(String(p)
  .replace(/^C:\\Users\\[^\\]+/i, '~')
  .replace(/^\/(home|Users)\/[^/]+/, '~'));

/** 受管运行时间人性化（ISO → 「2天 3小时」/「4小时 12分钟」/「35分钟」） */
const fmtSince = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  const h = Math.floor(min / 60), d = Math.floor(h / 24);
  return d > 0 ? `${d}天 ${h % 24}小时` : h > 0 ? `${h}小时 ${min % 60}分钟` : `${min}分钟`;
};

/** 端点是否指向本机（非本机 + mode=remote = 远程模式，不引导本地安装） */
const isLocalHost = (u) => {
  try {
    const h = new URL(u).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
  } catch { return false; }
};

/** 信息网格字段图标（Lucide 风格线性 SVG，stroke:currentColor） */
const cellIcon = (inner) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7.5h.01M7 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
};

/** 关键信息网格单元（图标+标签在上、值在下；值行 flex 防错位换行；span>1 时跨多列） */
const infoCell = (icon, label, valueHtml, span = 1) =>
  `<div style="min-width:0${span > 1 ? `;grid-column:span ${span}` : ''}">
    <div class="hint" style="display:flex;align-items:center;gap:5px;margin-bottom:4px">${cellIcon(ICONS[icon])}${label}</div>
    <div style="font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;line-height:1.5">${valueHtml}</div>
  </div>`;

/** 页头说明行（卡片外，两视图共用）：一句话定位 + 文档外链 */
const pageIntro = `<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:0 0 14px">
  <span class="hint" style="font-size:12.5px">OpenViking 长期记忆：每条消息自动召回相关历史、会话归档自动提炼，按 <code>{appId}-{userId}</code> 命名空间隔离（机器人之间互不可见）。</span>
  <!--<a href="${DOC_URL}" target="_blank" rel="noreferrer" style="font-size:12.5px;flex:0 0 auto;margin-left:auto">查看文档 ↗</a>-->
</div>`;

// ============ 服务状态八态（「一概而论异常」→ 精确状态；探活 reason 全量映射） ============

function deriveState(st, svcInstalled) {
  const h = st.health ?? {};
  if (h.healthy) return 'running';
  switch (h.reason) {
    case 'not-running': return svcInstalled ? 'stopped' : 'not-installed';
    case 'auth': return 'auth';
    case 'timeout': return 'timeout';
    case 'unreachable': return 'unreachable';
    case 'http-error': case 'unhealthy': return 'unhealthy';
    default: return 'error';
  }
}

/** 状态元数据：标签 + tag 色（css 定义 ok/off/err）+ 状态横幅底色 */
const STATE_META = {
  running: { label: '运行中', cls: 'ok', bg: 'var(--ok-bg)' },
  stopped: { label: '已停止', cls: 'off', bg: 'var(--off-bg)' },
  auth: { label: '鉴权失败', cls: 'err', bg: 'var(--err-bg)' },
  timeout: { label: '无响应', cls: 'err', bg: 'var(--err-bg)' },
  unreachable: { label: '端点不可达', cls: 'err', bg: 'var(--err-bg)' },
  unhealthy: { label: '服务异常', cls: 'err', bg: 'var(--err-bg)' },
  error: { label: '未知错误', cls: 'err', bg: 'var(--err-bg)' },
  'not-installed': { label: '未安装', cls: 'off', bg: 'var(--off-bg)' },
};

/** 记忆插件加载渠道标注（status.plugin.source）：与任务装配实际加载源一一对应 */
const PLUGIN_SOURCE_LABEL = {
  marketplace: 'CLI 安装',
  explicit: '显式引用',
  managed: 'LCB 自管副本',
};

// ============ 模型表单（双视图共用：渲染 + 绑定） ============

function modelFormHtml(model, endpoint) {
  const secretVal = (v) => (v && typeof v === 'object' && v.secretSet) ? v.secretHint : '';
  return `
  <div class="grid2">
    <div><label>服务商预设（填表助手，值可改）</label>
      <select id="memProvider">
        <option value="">— 选择预设 —</option>
        ${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${model.provider === k ? 'selected' : ''}>${p.label}</option>`).join('')}
      </select>
      <div class="hint" style="margin-top:3px">选择后只预填空字段，已填值不覆盖</div></div>
    <div><label>API 端点（api_base）</label><input type="text" id="memApiBase" value="${esc(model.apiBase || '')}" placeholder="https://…/v1">
      <div class="hint" style="margin-top:3px">OpenAI 协议端点，与机器人对话用的厂商档案相互独立</div></div>
    <div><label>API Key ${secretVal(model.apiKey) ? `<span class="hint">已保存 ${esc(secretVal(model.apiKey))}，测试连接将使用已保存 Key；更换请输入新值</span>` : ''}</label>
      <input type="password" id="memApiKey" value="" placeholder="${esc(PRESETS[model.provider]?.key_hint || 'sk-…（本地端点可留空）')}"></div>
    <div><label>提炼模型（vlm，会话归档时用）</label><input type="text" id="memVlm" value="${esc(model.vlmModel || '')}" placeholder="glm-4.7">
      <div class="hint" style="margin-top:3px">归档会话时提炼记忆的对话模型，可选更强档位</div></div>
    <div><label>向量模型（embedding）</label><input type="text" id="memEmb" value="${esc(model.embeddingModel || '')}" placeholder="embedding-3">
      <div class="hint" style="margin-top:3px">文本向量化模型，测试连接会真调一次验证</div></div>
    <div><label>服务端点（OpenViking server）</label><input type="text" id="memEndpoint" value="${esc(endpoint || DEFAULT_ENDPOINT)}" placeholder="${DEFAULT_ENDPOINT}">
      <div class="hint" style="margin-top:3px">一般无须修改：一键安装自动回写；远程模式填外部服务地址</div></div>
  </div>`;
}

/** 绑定模型表单交互（预设联动 / 测试连接双绿 / 保存）。isWizard 只影响保存后的提示文案 */
function bindModelForm(isWizard) {
  // 预设联动：只预填空字段（已手填的值不覆盖）
  $('#memProvider').onchange = (e) => {
    const p = PRESETS[e.target.value];
    if (!p) return;
    if (!$('#memApiBase').value.trim()) $('#memApiBase').value = p.api_base;
    if (!$('#memVlm').value.trim()) $('#memVlm').value = p.vlm_model;
    if (!$('#memEmb').value.trim()) $('#memEmb').value = p.embedding_model;
    $('#memApiKey').placeholder = p.key_hint || 'sk-…';
  };
  // 测试连接：表单现值直测（不落盘）——把 Key/端点/模型名错误挡在开启之前
  $('#memTest').onclick = async () => {
    const btn = $('#memTest');
    btn.disabled = true;
    $('#memTestResult').textContent = '测试中（真实调用 embedding + 提炼模型各一次）…';
    $('#memTestReport').style.display = 'none';
    try {
      const r = await api('POST', '/api/memory/test-connection', {
        api_base: $('#memApiBase').value.trim(),
        api_key: $('#memApiKey').value.trim(),
        vlm_model: $('#memVlm').value.trim(),
        embedding_model: $('#memEmb').value.trim(),
      });
      const line = (name, c) => `${c.ok ? '✅' : '❌'} ${name}：${c.detail}`;
      $('#memTestResult').innerHTML = r.ok
        ? '<span class="tag ok">双绿通过</span> 可以保存' + (isWizard ? '并一键安装' : '')
        : '<span class="tag err">未通过</span> 请按下方报告修正';
      $('#memTestReport').style.display = '';
      $('#memTestReport').textContent = `${line('向量模型', r.embedding)}\n${line('提炼模型', r.vlm)}`;
    } catch (e) {
      $('#memTestResult').innerHTML = `<span class="tag err">请求失败</span> ${esc(e.message)}`;
    }
    btn.disabled = false;
  };
  // 保存模型配置：写入 S.doc.memory（secret 空值保持脱敏对象 → 后端 applySecrets 回填现值）
  $('#memSaveModel').onclick = async () => {
    if (!S.doc.memory || typeof S.doc.memory !== 'object') S.doc.memory = {};
    const mem = S.doc.memory;
    mem.endpoint = $('#memEndpoint').value.trim() || DEFAULT_ENDPOINT;
    const keep = (mem.model && typeof mem.model === 'object') ? mem.model : {};
    const pv = $('#memProvider').value;
    const next = {
      ...keep,
      ...(pv ? { provider: pv } : {}),
      api_base: $('#memApiBase').value.trim(),
      vlm_model: $('#memVlm').value.trim(),
      embedding_model: $('#memEmb').value.trim(),
    };
    if (!pv) delete next.provider;
    mem.model = next;
    const rawKey = $('#memApiKey').value.trim();
    if (rawKey) mem.model.api_key = rawKey; // 空值保留脱敏对象 → applySecrets 回填
    if (!await saveDoc()) return;
    if (isWizard) {
      // 保存即解锁「⚡ 一键安装」：重渲染让 modelSaved 重新计算（不让用户对着灰按钮困惑到刷新）
      toast('模型配置已保存——「⚡ 一键安装」已解锁');
      hooks.rerender();
      return;
    }
    toast('记忆模型配置已保存（未开启记忆时仅保存，打开开关后生效）');
  };
}

// ============ 安装流水线（双视图共用：水平 stepper + 轮询 + 进页恢复） ============

/** 模块级轮询句柄：rerender 不产生重复 interval（旧闭包继续刷新 DOM，gate 以最新渲染为准） */
let installTimer = null;

function installStepsHtml(steps) {
  const chip = (s, i) => {
    const done = s.status === 'done' || s.status === 'skipped';
    const badge = done
      ? '<span style="width:20px;height:20px;border-radius:50%;background:var(--ok-tx);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto">✓</span>'
      : s.status === 'failed'
        ? '<span style="width:20px;height:20px;border-radius:50%;background:var(--err-tx);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto">✗</span>'
        : s.status === 'running'
          ? '<span class="br-spin-sm" style="margin:0;flex:0 0 auto"></span>'
          : `<span style="width:20px;height:20px;border-radius:50%;border:1.5px solid var(--muted);color:var(--muted);display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto">${i + 1}</span>`;
    const fallback = ({ pending: '等待中', running: '执行中…', done: '完成', skipped: '已就绪（跳过）' })[s.status] || '';
    const sub = esc(s.detail || fallback);
    return `<div style="flex:1;min-width:0;background:var(--off-bg);border-radius:10px;padding:9px 11px">
      <div style="display:flex;align-items:center;gap:7px">${badge}<b style="font-size:12px;line-height:1.35">${esc(s.title)}</b></div>
      <div class="hint" style="margin-top:5px;font-size:11px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical" title="${esc(s.detail || '')}">${sub || '&nbsp;'}</div>
    </div>`;
  };
  return `<div style="display:flex;gap:6px;align-items:stretch;margin-top:12px">${steps.map(chip).join('<span class="hint" style="align-self:center;flex:0 0 auto">→</span>')}</div>`;
}

/**
 * 绑定安装按钮 + 轮询 + 进页恢复。gate() = 额外禁用条件（向导：模型未保存时禁装——
 * 首装生成 ov.conf 需要模型三件套；已安装视图的「检查/修复」不受此限）。
 */
function bindInstallActions(gate) {
  const renderInstall = (ist) => {
    const box = $('#memInstallSteps');
    if (box) box.innerHTML = installStepsHtml(ist.steps);
    const failed = ist.steps.find((s) => s.status === 'failed');
    const hintEl = $('#memInstallHint');
    const kindTxt = ist.kind === 'start' ? '启动流水线' : '安装流水线';
    if (hintEl) hintEl.innerHTML = ist.running ? `${kindTxt}执行中…`
      : failed ? `<span style="color:var(--warn-tx)">「${esc(failed.title)}」失败：${esc(failed.detail || '')}——修正后可重跑（已就绪步骤自动跳过）</span>`
      : ist.finishedAt ? (ist.kind === 'start'
        ? '<span class="tag ok">启动完成</span> 服务已就绪、记忆插件已接入——LCB 接管的完整记忆链路即刻生效'
        : '<span class="tag ok">全部就绪</span> 配置已回写（endpoint / mode=embedded），机器人记忆即刻生效')
      : '';
    const btn = $('#memInstall');
    if (btn) btn.disabled = !!ist.running || gate();
    ['memStart', 'memStop', 'memRefresh'].forEach((id) => { const b = $('#' + id); if (b) b.disabled = !!ist.running; });
  };
  const poll = async () => {
    try {
      const ist = await api('GET', '/api/memory/install/status');
      renderInstall(ist);
      if (!ist.running) {
        if (installTimer) { clearInterval(installTimer); installTimer = null; }
        // 回写改了 config.yaml：refresh 重拉 S.doc 再整页渲染（防止陈旧 doc 在下次保存时覆盖回写）
        refresh().catch(() => hooks.rerender());
        return;
      }
    } catch { /* 轮询失败静默重试 */ }
  };
  const startPipeline = (path, runningMsg) => async () => {
    try {
      await api('POST', path, {});
      toast(runningMsg);
      if (!installTimer) installTimer = setInterval(poll, 2000);
      poll();
    } catch (e) { toast(e.message, true); }
  };
  const btn = $('#memInstall');
  if (btn) btn.onclick = startPipeline('/api/memory/install', '安装流水线已启动（后台执行，本页实时显示进度）');
  // 启动服务：LCB 接管式启动流水线（检查 → 拉起探活 → 接入插件），同款 stepper 实时进度——
  // 结束即完整接管态，无须再点「检查修复」补插件
  const startBtn = $('#memStart');
  if (startBtn) startBtn.onclick = startPipeline('/api/memory/start', '启动流水线已开始（检查 → 拉起 → 接入插件，本页实时显示进度）');
  // 进页恢复（切页回来 / 安装刚结束）：在跑则继续轮询，刚结束则展示结果
  api('GET', '/api/memory/install/status').then((ist) => {
    if (ist.running || ist.finishedAt) {
      renderInstall(ist);
      if (ist.running && !installTimer) installTimer = setInterval(poll, 2000);
    }
  }).catch(() => {});
}

// ============ 主渲染 ============

export async function renderMemory(el) {
  el.innerHTML = '<div class="card"><h3>记忆增强</h3><div class="br-spin-sm"></div><div class="hint">正在读取记忆服务状态…</div></div>';
  let st;
  try {
    st = await api('GET', '/api/memory/status');
  } catch (e) {
    el.innerHTML = `<div class="card"><h3>记忆增强</h3><div class="hint">状态读取失败：${esc(e.message)}</div></div>`;
    return;
  }
  const m = st.memory ?? { enabled: false, mode: 'remote', endpoint: DEFAULT_ENDPOINT };
  const model = m.model ?? {};
  const inst = st.install ?? {};
  const svcInstalled = !!inst.serverFound;
  const svcOk = !!st.health?.healthy;
  // 远程模式（endpoint 指向非本机）：不引导本地安装，进已安装视图管理外部服务
  const remoteConfigured = m.mode === 'remote' && !!m.endpoint && !isLocalHost(m.endpoint);
  const showWizard = !svcInstalled && !svcOk && !remoteConfigured;
  const state = deriveState(st, svcInstalled);
  const meta = STATE_META[state] ?? STATE_META.error;
  // 首装模型三件套就绪判定（安装流水线生成 ov.conf 的前置）
  const modelSaved = !!(model.apiBase && model.vlmModel && model.embeddingModel);

  if (showWizard) return renderWizard(el, { m, model, modelSaved });
  return renderInstalled(el, { st, m, model, inst, state, meta, remoteConfigured });
}

// ============ 未安装向导 ============

function renderWizard(el, { m, model, modelSaved }) {
  const epVal = (m.endpoint && m.endpoint !== DEFAULT_ENDPOINT) ? m.endpoint : '';
  el.innerHTML = `
  ${pageIntro}
  <div class="card">
    <div style="display:flex;align-items:center;gap:10px">
      <h3 style="margin:0">开始使用记忆增强</h3>
      <span style="flex:1"></span>
      <button class="btn primary sm" id="memInstall" ${modelSaved ? '' : 'disabled'} title="${modelSaved ? '自动完成安装与配置（检测/安装 uv → 服务 → 配置 → 拉起 → 插件）' : '请先在下方「模型配置」卡填写并保存（安装生成服务配置需要模型三件套）'}">⚡ 一键安装</button>
    </div>
    <div style="background:var(--primary-weak);border-radius:10px;padding:14px 16px">
      <b>未安装 OpenViking 服务</b>
      <div class="hint" style="margin-top:4px;line-height:1.7">点右上「⚡ 一键安装」自动完成安装与配置（检测/安装 uv 运行时 → 安装 OpenViking 服务 → 生成配置 → 拉起服务 → 接入记忆插件）。全程无须终端；已就绪部件自动跳过，可重复执行。</div>
      ${modelSaved ? '' : `<div class="hint" style="margin-top:8px;color:var(--warn-tx)">⚠ 请先在下方「模型配置」填表并保存——安装需要用模型三件套（API 端点 / 提炼模型 / 向量模型）生成服务配置。</div>`}
    </div>
    <div id="memInstallSteps">${installStepsHtml(IDLE_STEPS)}</div>
    <div id="memInstallHint" class="hint" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <div style="display:flex;align-items:center;gap:10px">
      <h3 style="margin:0">模型配置（安装前置）</h3>
      <span style="flex:1"></span>
      <button class="btn sm" id="memTest">测试连接</button>
      <button class="btn sm primary" id="memSaveModel">保存配置</button>
    </div>
    <div class="desc" style="margin-top:6px">记忆的<b>提炼（vlm）与向量化（embedding）</b>走 OpenAI 协议端点，与机器人对话用的厂商档案相互独立。建议先 [测试连接] 双绿，再保存并一键安装。</div>
    ${modelFormHtml(model, m.endpoint)}
    <div id="memTestResult" class="hint" style="margin-top:8px"></div>
    <pre class="report" id="memTestReport" style="display:none;margin-top:6px"></pre>
  </div>

  <div class="card">
    <details><summary class="hint">已有外部 OpenViking 服务？填写远程端点（不在本机安装）</summary>
      <div style="margin-top:10px">
        <div class="row" style="align-items:end">
          <div><label>服务端点（OpenViking server）</label><input type="text" id="memRemoteEp" value="${esc(epVal)}" placeholder="http://192.168.x.x:1933"></div>
          <div class="btn-wrap"><button class="btn" id="memRemoteSave">保存并切换</button></div>
        </div>
        <div class="hint" style="margin-top:6px">保存后本页改为管理该外部服务（探活 + 模型配置，不接管其进程）。</div>
      </div>
    </details>
    <details style="margin-top:10px"><summary class="hint">高级：手动安装指引与常见问题（一键安装失败时的兜底路径）</summary>
      <pre class="report" style="margin-top:8px">① 安装并启动 OpenViking 服务（本机）：
    uv tool install openviking
    openviking-server init        # 初始化配置（含模型）
    openviking-server start

② 安装 Claude Code 记忆插件（一次性）：
    claude marketplace add openviking
    claude plugin install openviking-memory@openviking

③ 回到本页：保存模型配置 → 一键安装（或直接开启）</pre>
      <div class="hint" style="margin-top:8px;line-height:1.9">常见问题：
· 启动失败 / 服务异常 → 点「一键检查 / 修复」重跑流水线（已就绪步骤自动跳过，不覆盖现有数据）
· 鉴权失败 → ov.conf 的 root_api_key 与本页保存的 API Key 需一致（一键安装会自动对齐）
· 支持哪些模型 → 任意 OpenAI 协议端点（智谱 / 方舟 / 中转 / Ollama 本地）
· 修改端口 → 模型配置里的「服务端点」；一键安装会自动避开占用端口</div>
    </details>
  </div>`;

  bindModelForm(true);
  bindInstallActions(() => !modelSaved);

  // 外部服务入口：保存远程 endpoint → remoteConfigured → 切到已安装（外部）视图
  $('#memRemoteSave').onclick = async () => {
    const val = $('#memRemoteEp').value.trim();
    if (!/^https?:\/\//.test(val)) return toast('服务端点必须以 http(s):// 开头', true);
    if (!S.doc.memory || typeof S.doc.memory !== 'object') S.doc.memory = { mode: 'remote', endpoint: val };
    else { S.doc.memory.endpoint = val; if (!S.doc.memory.mode) S.doc.memory.mode = 'remote'; }
    if (await saveDoc()) toast('已保存远程端点，切换为外部服务管理模式');
  };
}

// ============ 已安装视图 ============

function renderInstalled(el, { st, m, model, inst, state, meta, remoteConfigured }) {
  const ver = st.health?.version;
  const endpoint = m.endpoint || DEFAULT_ENDPOINT;
  const authNote = st.authNote;
  const off = !m.enabled;

  // 状态行主文案 + 补充说明（running 一行收尾；其余态独立说明行带 detail + 行动建议）
  const statusSub = state === 'running' ? 'OpenViking 服务运行正常，记忆召回与归档已就绪'
    : state === 'stopped' ? '服务已安装，进程未运行——点右上「▶ 启动服务」一键拉起（自动检查配置 → 拉起探活 → 接入插件）'
      : '';
  const statusDetail = state === 'running' || state === 'stopped' ? ''
    : `${esc(st.health?.detail || '探活失败')}${REASON_HINT[st.health?.reason] ? `<br>➜ ${REASON_HINT[st.health.reason]}` : ''}`;

  // 信息网格：只渲染「有值」的列（隐藏字段不占列位）；运行方式用 mode 推导（embedded=LCB 受管安装）
  // 网格固定 3 列（一行 3 项；auto-fit 会在宽屏挤成 6 列）；地址列不跨列，长 URL 列内省略号截断防撑破；插件列值整体 nowrap 防拆行
  const cells = [
    infoCell('globe', '服务地址', `<span style="white-space:nowrap;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%"><code style="font-size:11.5px;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(endpoint)}</code><button class="btn sm" id="memCopy" title="复制服务地址" style="padding:2px 9px;flex:0 0 auto">⧉</button>${remoteConfigured ? '<span class="hint">远程</span>' : ''}</span>`),
    ...(state === 'running' && ver ? [infoCell('box', '版本', `v${esc(ver)}`)] : []),
    infoCell('server', '运行方式', m.mode === 'embedded'
      ? `LCB 受管${inst.managedRunning ? '' : ' <span class="hint">（未运行）</span>'}`
      : `外部自管 <span class="hint">非 LCB 拉起</span>`),
    ...(inst.managedSince ? [infoCell('clock', '运行时间', esc(fmtSince(inst.managedSince)))] : []),
    ...(st.health?.authMode ? [infoCell('server', '鉴权模式', `${esc(st.health.authMode)}${authNote ? ` <span class="hint" title="${esc(authNote)}">ⓘ</span>` : ''}`)] : []),
    infoCell('spark', '记忆插件', st.plugin?.found
      ? `<span style="white-space:nowrap;display:inline-flex;align-items:center;gap:6px"><span style="color:var(--ok-tx);font-weight:600">✓</span><code>${esc(st.plugin.name)}</code>${st.plugin.version ? `<span class="hint">v${esc(st.plugin.version)}</span>` : ''}${st.plugin.source && PLUGIN_SOURCE_LABEL[st.plugin.source] ? `<span class="hint" title="实际加载渠道：与机器人任务装配一致">${esc(PLUGIN_SOURCE_LABEL[st.plugin.source])}</span>` : ''}</span>`
      : '<span style="color:var(--warn-tx);font-weight:600">○ 未安装</span><span class="hint">「检查修复」可补装</span>'),
  ];

  // 卡标题右按钮组：主行动随状态切换（启动/停止），刷新与检查修复常驻
  // 检查/修复门禁与向导一键安装同口径：受管 conf 缺失（= 重跑会走首装生成 ov.conf）且模型
  // 三件套未保存时禁用——把「缺模型」挡在点击之前，而不是让用户在「生成服务配置」步骤撞失败
  const needModelFirst = !inst.confFound && !modelSaved;
  const repairBtn = `<button class="btn sm" id="memInstall" title="${needModelFirst
    ? '受管服务配置缺失，生成配置需要模型三件套——请先在下方「模型配置」卡填写并保存'
    : '重跑安装流水线（已就绪部件自动跳过）'}">检查修复</button>`;
  const refreshBtn = '<button class="btn sm" id="memRefresh" title="重新探活">↻ 刷新</button>';
  const actionBtns = state === 'stopped'
    ? `${repairBtn} ${refreshBtn} <button class="btn sm primary" id="memStart">▶ 启动服务</button>`
    : state === 'running'
      ? `${repairBtn} ${refreshBtn}${inst.managedRunning ? ' <button class="btn sm danger" id="memStop" title="停止 LCB 受管服务">⏹ 停止</button>' : ''}`
      : `${repairBtn} ${refreshBtn}`;

  el.innerHTML = `
  ${pageIntro}
  <div class="card">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <label class="switch"><input type="checkbox" id="memEnabled" ${m.enabled ? 'checked' : ''}><span class="track"></span></label>
      <span class="switch-label" style="font-weight:600">启用长期记忆</span>
      <span style="flex:1"></span>
      <span class="tag ${meta.cls}" title="${esc(shortPath(inst.serverBin || ''))}">${meta.label}${state === 'running' && ver ? ` · v${esc(ver)}` : ''}</span>
    </div>
    <div class="desc" style="margin:10px 0 0">关闭后 LCB 行为与未安装完全一致。</div>
  </div>
  ${off ? '<div class="hint" style="margin:0 0 12px;padding:9px 14px;background:var(--warn-bg);color:var(--warn-tx);border-radius:10px">⏸ 记忆增强已停用——下方仅供查看，打开顶部开关后可管理服务与配置。</div><div class="block-disabled">' : ''}
  <div class="card">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <h3 style="margin:0">服务状态</h3>
      <span style="flex:1"></span>
      ${actionBtns}
    </div>
    <div style="background:${meta.bg};border-radius:12px;padding:16px 18px;margin-top:12px">
      <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
        <span style="width:9px;height:9px;border-radius:50%;background:var(--${meta.cls}-tx);flex:0 0 auto"></span>
        <span style="font-size:15px;font-weight:700;color:var(--${meta.cls}-tx)">${meta.label}</span>
        ${statusSub ? `<span class="hint">— ${statusSub}</span>` : ''}
      </div>
      ${statusDetail ? `<div class="hint" style="margin-top:9px;line-height:1.8">${statusDetail}</div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-flow:dense;gap:16px 22px;margin-top:16px">${cells.join('')}</div>
    </div>
    <div id="memInstallSteps"></div>
    <div id="memInstallHint" class="hint" style="margin-top:8px"></div>
  </div>
  <div class="card">
    <div style="display:flex;align-items:center;gap:10px">
      <h3 style="margin:0">模型配置</h3>
      <span style="flex:1"></span>
      <button class="btn sm" id="memTest">测试连接</button>
      <button class="btn sm primary" id="memSaveModel">保存配置</button>
    </div>
    <div class="desc" style="margin-top:6px">记忆的<b>提炼（vlm）与向量化（embedding）</b>走 OpenAI 协议端点，与机器人对话用的厂商档案相互独立（改档案不影响记忆）。建议变更后先 [测试连接] 双绿再保存。</div>
    ${modelFormHtml(model, m.endpoint)}
    <div id="memTestResult" class="hint" style="margin-top:8px"></div>
    <pre class="report" id="memTestReport" style="display:none;margin-top:6px"></pre>
  </div>
  ${off ? '</div>' : ''}`;

  // 总开关：即时保存；开启时确认 + 预检（服务/插件状态给出真实提示，指引指向服务状态卡）
  $('#memEnabled').onchange = async (e) => {
    const next = e.target.checked;
    if (next) {
      const blockers = [];
      if (!st.health?.healthy) {
        blockers.push(`OpenViking 服务不可达：${esc(st.health?.detail || '未知原因')}${state === 'stopped' ? '——开启后可在「服务状态」卡点「▶ 启动服务」拉起' : ''}`);
      }
      if (!st.plugin?.found) blockers.push('记忆插件未安装——开启后可在「服务状态」卡点「一键检查 / 修复」补装');
      const warnTxt = blockers.length
        ? `开启前请注意：<br>· ${blockers.join('<br>· ')}<br><br>仍可开启（保存配置，日志会在每条消息给出指引），确认继续？`
        : '开启后每个机器人的每条消息将自动：注入记忆召回（hooks）+ 按命名空间隔离读写。确认开启？';
      if (!(await confirmDialog({ title: '启用长期记忆', message: warnTxt, confirmText: '开启' }))) {
        e.target.checked = false;
        return;
      }
    }
    const old = (S.doc.memory && typeof S.doc.memory === 'object') ? S.doc.memory.enabled : undefined;
    if (!S.doc.memory || typeof S.doc.memory !== 'object') {
      S.doc.memory = { enabled: next, mode: 'remote', endpoint: DEFAULT_ENDPOINT };
    } else {
      S.doc.memory.enabled = next;
    }
    if (!await saveDoc()) {
      if (old === undefined) delete S.doc.memory;
      else S.doc.memory.enabled = old;
      e.target.checked = !next;
    }
  };

  // 刷新：整页重渲染（重新探活）
  const refreshBtnEl = $('#memRefresh');
  if (refreshBtnEl) refreshBtnEl.onclick = () => hooks.rerender();

  // 复制服务地址
  const copyBtn = $('#memCopy');
  if (copyBtn) copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(endpoint); toast('服务地址已复制'); }
    catch { toast('复制失败（浏览器未授权剪贴板）', true); }
  };

  // 启动服务已统一走 bindInstallActions 的启动流水线（检查 → 拉起探活 → 接入插件，stepper 实时进度）

  // 停止受管服务（危险确认；外部自管服务不显示此按钮）
  const stopBtn = $('#memStop');
  if (stopBtn) stopBtn.onclick = async () => {
    if (!(await confirmDialog({ title: '停止受管服务', message: '停止 LCB 托管的 OpenViking 服务？记忆功能将不可用（独立手动安装的服务不受影响，可随时重新拉起）。', confirmText: '停止' }))) return;
    try { await api('POST', '/api/memory/stop', {}); toast('已停止'); hooks.rerender(); } catch (e) { toast(e.message, true); }
  };

  bindModelForm(false);
  // 已安装视图：检查/修复门禁——受管 conf 已存在时放行（沿用现值重跑）；缺失时与向导同口径要模型三件套
  bindInstallActions(() => needModelFirst);
}

export const page = {
  id: 'memory',
  title: '记忆增强',
  icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  render: renderMemory,
};
