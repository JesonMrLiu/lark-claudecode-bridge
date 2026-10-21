// ============ 记忆增强（OpenViking 长期记忆，生命周期方案 §6.7/§6.8/§6.9 + 最终方案 v1.1） ============
// 页内双 Tab（最终方案 §六：「服务与配置」|「用户与密钥」，形态同配置页分栏；侧边栏不加一级导航）：
// - Tab1 服务与配置：双视图（未安装向导 / 已安装管理）——总开关 + 服务状态（五步流水线 stepper
//   + 启停/检查修复/刷新）+ 模型配置（P2 双端点：vlm 块与 embedding 块各自独立端点/Key）。
//   P1 保存即生效：模型变更保存后弹「立即生效」确认 → /api/memory/apply 重渲染 ov.conf + 重启服务。
// - Tab2 用户与密钥：一键初始化 / 用户列表（web / 机器人） / 打开记忆空间（密钥进剪贴板 + 自动
//   新标签开 1933，Ctrl+V 一次连接） / 复制·重置·删除（重置删除均二次确认，删除先备份）。
//   显示名称（✏️）：中文对照映射走 doc.memory.displayNames（LCB 侧，服务端无显示名字段）；
//   用户 ID 只读——OpenViking 无 rename 接口且 user_id 硬编码进密钥与数据目录，禁止修改。
//   api_key 模式但 web 用户未建时 Tab 亮红点「待初始化鉴权」（前置化浏览器 401 重定向类问题）。
// 配置读写走标准 doc 管道（saveDoc → PUT /api/config，secret 自动回填）；测试连接走
// /api/memory/test-connection（表单现值，不落盘）；安装/启停走 /api/memory/install|start|stop。
import { S, $, esc, api, toast, saveDoc, hooks, refresh } from '../core.js';
import { confirmDialog, openModal, closeModal } from '../ui.js';

/** 服务商预设（§6.8 填表助手：只预填已知值，全部可见可改）。预设只填主块（vlm）；
 *  向量块留空沿用主块——跨厂商组合时单独填向量端点/Key（P2 双端点拆分语义） */
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
  auth: '鉴权失败——api_key 模式下网页/机器人各需一把用户密钥。点「用户与密钥」Tab 一键初始化，或检查 ov.conf 的 root key 与本页保存的 API Key 是否一致。（若是在 1933 的 Studio 里登录被拒：要填的是 **Root 或账号管理员 API 密钥**，见「用户与密钥」Tab 顶部的「连接 OpenViking Studio」指引卡，一键复制即可）',
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

/** 页头说明行（卡片外，双 Tab 共用）：一句话定位 + 文档外链 */
const pageIntro = `<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:0 0 14px">
<!--  <span class="hint" style="font-size:12.5px">OpenViking 长期记忆：每条消息自动召回相关历史、会话归档自动提炼，按「记忆身份（OpenViking 用户）」隔离存储——每台机器人关联且仅关联一个身份，多台机器人关联同一身份即共享记忆（在「用户与密钥」Tab 管理）。</span>-->
  <span class="hint" style="font-size:12.5px">OpenViking 长期记忆：每条消息自动召回相关历史、会话归档自动提炼，按「记忆身份（OpenViking 用户）」隔离存储——每台机器人关联且仅关联一个身份。</span>
  <!--<a href="${DOC_URL}" target="_blank" rel="noreferrer" style="font-size:12.5px;flex:0 0 auto;margin-left:auto">查看文档 ↗</a>-->
</div>`;

// ============ 页内双 Tab（最终方案 §六：「服务与配置」|「用户与密钥」） ============

/** 当前 Tab（模块级：rerender 保持）；用户快照（红点判定 + Tab2 渲染数据） */
let activeTab = 'service';
let usersSnapshot = null;

/** 切 Tab（重渲染整个记忆页——S.doc/状态已在内存，切换零请求） */
function switchTab(tab) {
  activeTab = tab;
  hooks.rerender();
}

/** Tab 条：与「权限」页同款标准 .tabs 组件（下划线高亮，main.css 统一样式）；待初始化时 Tab2 亮红点 */
function tabBarHtml(authInitNeeded) {
  const dot = ' <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--danger);vertical-align:2px" title="待初始化鉴权：服务为 api_key 模式但网页端用户未创建"></span>';
  return `<div class="tabs">
    <button data-memtab="service" class="${activeTab === 'service' ? 'active' : ''}">服务与配置</button>
    <button data-memtab="users" class="${activeTab === 'users' ? 'active' : ''}">用户与密钥${authInitNeeded ? dot : ''}</button>
  </div>`;
}

function bindTabBar() {
  document.querySelectorAll('[data-memtab]').forEach((b) => {
    b.onclick = () => switchTab(b.dataset.memtab);
  });
}

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

/** 客户端接入状态标注（status.plugin.clientConfState）：插件侧启用判定 env 优先、文件兜底——
 *  与 LCB 侧「加载渠道」是两回事（加载渠道 ✓ 不代表启用 ✓）。missing 且记忆开启 = env 通道
 *  启用（LCB 每任务下发 OPENVIKING_MEMORY_ENABLED，无须任何文件） */
const CLIENT_CONF_LABEL = {
  'lcb-managed': '客户端配置 LCB 托管',
  'user-managed': '客户端配置本机自管',
  external: '外部 ov.conf 接入',
  missing: 'env 通道启用',
};

/** 记忆插件 cell 尾部的启用徽标：未启用红字提醒（全绿但 hooks 空转的历史盲区在此现形） */
function clientConfBadge(p) {
  if (!p) return '';
  if (p.clientEnabled === false) return ' <span class="hint" style="color:var(--warn-tx)">未启用（无 env、无配置文件）</span>';
  const label = p.clientConfState && CLIENT_CONF_LABEL[p.clientConfState];
  return label ? ` <span class="hint" title="插件侧启用判定：env 优先，客户端配置兜底（${esc(p.clientConfPath || '')}）">${esc(label)}</span>` : '';
}

// ============ 模型表单（双视图共用：渲染 + 绑定；P2 双端点拆分） ============

function modelFormHtml(model, endpoint) {
  const secretVal = (v) => (v && typeof v === 'object' && v.secretSet) ? v.secretHint : '';
  // 向量块独立凭证展示：own=显式配置（输入框脱敏提示「留空不修改」）；未配置=沿用主块（提示现沿用值）
  const embOwn = !!model.embeddingKeyOwn;
  const embKeyHint = secretVal(model.embeddingApiKey);
  const embKeyPlaceholder = embOwn
    ? `已保存 ${embKeyHint || '••••'}，留空不修改`
    : embKeyHint ? `当前沿用主 Key ${embKeyHint}，填写后独立` : '留空沿用主 Key（可单独指定）';
  const embBasePlaceholder = model.embeddingApiBaseResolved || '留空沿用主端点';
  // 左右两栏面板（提炼主模型 | 向量模型）：用「权限」页同款 row-2col 响应式栅格，窄屏自动上下叠放
  const panel = (title, hint, inner) => `
    <div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px 4px;background:var(--field);min-width:0">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px">${title}
        <span class="hint" style="font-weight:400;margin-left:6px">${hint}</span></div>
      ${inner}
    </div>`;
  const fld = (label, inner, hint) => `
    <div style="margin-bottom:12px"><label>${label}</label>${inner}
      ${hint ? `<div class="hint" style="margin-top:3px">${hint}</div>` : ''}</div>`;
  return `
  <div class="row-2col" style="gap:16px;align-items:stretch">
    ${panel('提炼主模型配置', 'vlm · 会话归档时提炼记忆', `
      ${fld('服务商预设（填表助手，值可改）', `<select id="memProvider">
        <option value="">— 选择预设 —</option>
        ${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${model.provider === k ? 'selected' : ''}>${p.label}</option>`).join('')}
      </select>`, '选择后只预填空字段，已填值不覆盖（同时预填右侧向量模型名）')}
      ${fld('API 端点（api_base）', `<input type="text" id="memApiBase" value="${esc(model.apiBase || '')}" placeholder="https://…/v1">`, 'OpenAI 协议端点，与机器人对话用的厂商档案相互独立')}
      ${fld(`API Key ${secretVal(model.apiKey) ? `<span class="hint">已保存 ${esc(secretVal(model.apiKey))}，留空不修改</span>` : ''}`, `<input type="password" id="memApiKey" value="" placeholder="${esc(PRESETS[model.provider]?.key_hint || 'sk-…（本地端点可留空）')}">`)}
      ${fld('提炼模型（vlm）', `<input type="text" id="memVlm" value="${esc(model.vlmModel || '')}" placeholder="glm-4.7">`, '归档会话时提炼记忆的对话模型，可选更强档位')}
    `)}
    ${panel('向量模型配置', 'embedding · 向量化入库与召回', `
      ${fld('向量模型（embedding）', `<input type="text" id="memEmb" value="${esc(model.embeddingModel || '')}" placeholder="embedding-3">`, '测试连接会真调一次验证')}
      ${fld('向量端点（独立）', `<input type="text" id="memEmbBase" value="${esc(model.embeddingApiBase || '')}" placeholder="${esc(embBasePlaceholder)}">`, '跨厂商组合时单独指定（如主模型=glm + 向量=OpenAI 系）；留空沿用主端点')}
      ${fld('向量 Key（独立）', `<input type="password" id="memEmbKey" value="" placeholder="${esc(embKeyPlaceholder)}">`, '与主 Key 相同时留空即可；两块凭证互不影响（留空 = 不修改）')}
    `)}
  </div>
  <div class="row" style="margin-top:12px;align-items:end">
    <div style="flex:1;min-width:260px"><label>服务端点（OpenViking server）</label><input type="text" id="memEndpoint" value="${esc(endpoint || DEFAULT_ENDPOINT)}" placeholder="${DEFAULT_ENDPOINT}">
      <div class="hint" style="margin-top:3px">一般无须修改：一键安装自动回写；远程模式填外部服务地址</div></div>
  </div>`;
}

/** 绑定模型表单交互（预设联动 / 测试连接双绿 / 保存 + P1 立即生效）。isWizard 只影响保存后的
 *  提示文案；canApply（已安装视图）= 保存后检测到模型变更时提供「立即生效」 */
function bindModelForm(isWizard, canApply) {
  // 预设联动：只预填主块空字段（已手填的值不覆盖；向量块留空沿用——跨厂商组合才手填）
  $('#memProvider').onchange = (e) => {
    const p = PRESETS[e.target.value];
    if (!p) return;
    if (!$('#memApiBase').value.trim()) $('#memApiBase').value = p.api_base;
    if (!$('#memVlm').value.trim()) $('#memVlm').value = p.vlm_model;
    if (!$('#memEmb').value.trim()) $('#memEmb').value = p.embedding_model;
    $('#memApiKey').placeholder = p.key_hint || 'sk-…';
  };
  // 测试连接：表单现值直测（不落盘）——向量块留空回退主块现值，与渲染 ov.conf 同口径
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
        embedding_api_base: $('#memEmbBase').value.trim(),
        embedding_api_key: $('#memEmbKey').value.trim(),
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
  // 保存模型配置：写入 S.doc.memory（secret 空值保持脱敏对象 → 后端 applySecrets 按块独立回填）。
  // P1 保存即生效：已安装视图检测到模型实际变更 → 弹「立即生效」确认 → apply 流水线
  //（重渲染 ov.conf + 强制重启受管服务）——消灭「保存后还需手动检查修复」两步坑
  $('#memSaveModel').onclick = async () => {
    if (!S.doc.memory || typeof S.doc.memory !== 'object') S.doc.memory = {};
    const mem = S.doc.memory;
    const prev = (mem.model && typeof mem.model === 'object') ? mem.model : {};
    // 变更检测须在改 S.doc 前取原值（api_key 输入非空视为换 Key）
    const newApiBase = $('#memApiBase').value.trim();
    const newVlm = $('#memVlm').value.trim();
    const newEmb = $('#memEmb').value.trim();
    const newEmbBase = $('#memEmbBase').value.trim();
    const rawKey = $('#memApiKey').value.trim();
    const rawEmbKey = $('#memEmbKey').value.trim();
    const pv = $('#memProvider').value;
    const modelChanged = newApiBase !== (prev.api_base || '')
      || newVlm !== (prev.vlm_model || '')
      || newEmb !== (prev.embedding_model || '')
      || newEmbBase !== (prev.embedding_api_base || '')
      || (pv || '') !== (prev.provider || '')
      || !!rawKey || !!rawEmbKey;
    mem.endpoint = $('#memEndpoint').value.trim() || DEFAULT_ENDPOINT;
    const next = {
      ...prev,
      ...(pv ? { provider: pv } : {}),
      api_base: newApiBase,
      vlm_model: newVlm,
      embedding_model: newEmb,
    };
    if (!pv) delete next.provider;
    // 向量端点（非凭证）：留空 = 清除 → 沿用主端点（与输入框提示一致）
    if (!newEmbBase) delete next.embedding_api_base;
    else next.embedding_api_base = newEmbBase;
    mem.model = next;
    if (rawKey) mem.model.api_key = rawKey; // Key 空值保留脱敏对象 → applySecrets 回填主 Key（留空=不修改）
    if (rawEmbKey) mem.model.embedding_api_key = rawEmbKey; // 向量 Key 按块独立，同款回填
    if (!await saveDoc()) return;
    if (isWizard) {
      // 保存即解锁「⚡ 一键安装」：重渲染让 modelSaved 重新计算（不让用户对着灰按钮困惑到刷新）
      toast('模型配置已保存——「⚡ 一键安装」已解锁');
      hooks.rerender();
      return;
    }
    if (modelChanged && canApply) {
      const ok = await confirmDialog({
        title: '使新配置立即生效',
        message: '模型配置已保存。<br><br>记忆服务需<b>重新渲染配置并重启</b>才能应用新模型（运行中的进程不会热加载）。<br>立即生效？',
        confirmText: '立即生效',
      });
      if (ok) {
        await startPipeline('/api/memory/apply', '正在应用新模型配置（重渲染 → 重启服务 → 校验插件），本页实时显示进度')();
        return;
      }
      toast('已保存。稍后点「检查修复」或再次保存时选择「立即生效」即可应用');
      return;
    }
    toast('记忆模型配置已保存（未开启记忆时仅保存，打开开关后生效）');
  };
}

// ============ 安装流水线（双 Tab1 共用：水平 stepper + 轮询 + 进页恢复） ============

/** 模块级轮询句柄：rerender 不产生重复 interval（旧闭包继续刷新 DOM，gate 以最新渲染为准） */
let installTimer = null;
/** 已安装视图的门禁（受管 conf 缺失且模型未保存时禁「检查修复」）；向导视图 = 模型未保存禁安装 */
let installGateFn = () => false;

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

/** 安装状态渲染（P0：慢启动时「拉起/拉起受管服务」步骤保持 running 并实时显示「已等 N 秒」，
 *  不出现红叉——后端转后台续等，就绪自动续跑后续步骤） */
function renderInstallState(ist) {
  const box = $('#memInstallSteps');
  if (box) box.innerHTML = installStepsHtml(ist.steps);
  const failed = ist.steps.find((s) => s.status === 'failed');
  const hintEl = $('#memInstallHint');
  const kindTxt = ist.kind === 'start' ? '启动流水线' : ist.steps.some((s) => s.detail && s.detail.includes('重渲染')) ? '应用流水线' : '安装流水线';
  if (hintEl) hintEl.innerHTML = ist.running ? `${kindTxt}执行中…`
    : failed ? `<span style="color:var(--warn-tx)">「${esc(failed.title)}」失败：${esc(failed.detail || '')}——修正后可重跑（已就绪步骤自动跳过）</span>`
    : ist.finishedAt ? (ist.kind === 'start'
      ? '<span class="tag ok">启动完成</span> 服务已就绪、记忆插件已接入——LCB 接管的完整记忆链路即刻生效'
      : '<span class="tag ok">全部就绪</span> 配置已回写（endpoint / mode=embedded），机器人记忆即刻生效')
    : '';
  const btn = $('#memInstall');
  if (btn) btn.disabled = !!ist.running || installGateFn();
  ['memStart', 'memStop', 'memRefresh'].forEach((id) => { const b = $('#' + id); if (b) b.disabled = !!ist.running; });
}

const pollInstall = async () => {
  try {
    const ist = await api('GET', '/api/memory/install/status');
    renderInstallState(ist);
    if (!ist.running) {
      if (installTimer) { clearInterval(installTimer); installTimer = null; }
      // 回写改了 config.yaml：refresh 重拉 S.doc 再整页渲染（防止陈旧 doc 在下次保存时覆盖回写）
      refresh().catch(() => hooks.rerender());
      return;
    }
  } catch { /* 轮询失败静默重试 */ }
};

/** 发起流水线（安装 / 启动 / P1 立即生效共用）：POST + toast + 轮询 */
function startPipeline(path, runningMsg) {
  return async () => {
    try {
      await api('POST', path, {});
      toast(runningMsg);
      if (!installTimer) installTimer = setInterval(pollInstall, 2000);
      pollInstall();
    } catch (e) { toast(e.message, true); }
  };
}

/**
 * 绑定安装按钮 + 轮询 + 进页恢复。gate() = 额外禁用条件（向导：模型未保存时禁装——
 * 首装生成 ov.conf 需要模型三件套；已安装视图的「检查/修复」不受此限）。
 */
function bindInstallActions(gate) {
  installGateFn = gate;
  const installBtn = $('#memInstall');
  if (installBtn) installBtn.onclick = startPipeline('/api/memory/install', '安装流水线已启动（后台执行，本页实时显示进度）');
  // 启动服务：LCB 接管式启动流水线（检查 → 拉起探活 → 接入插件），同款 stepper 实时进度——
  // 结束即完整接管态，无须再点「检查修复」补插件
  const startBtn = $('#memStart');
  if (startBtn) startBtn.onclick = startPipeline('/api/memory/start', '启动流水线已开始（检查 → 拉起 → 接入插件，本页实时显示进度）');
  // 进页恢复（切页回来 / 安装刚结束）：在跑则继续轮询，刚结束则展示结果
  api('GET', '/api/memory/install/status').then((ist) => {
    if (ist.running || ist.finishedAt) {
      renderInstallState(ist);
      if (ist.running && !installTimer) installTimer = setInterval(pollInstall, 2000);
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
  // 用户快照（Tab2 数据 + 红点判定）；失败按 null（Tab2 内可重试），不阻塞 Tab1
  try { usersSnapshot = await api('GET', '/api/memory/users'); } catch { usersSnapshot = null; }

  const m = st.memory ?? { enabled: false, mode: 'remote', endpoint: DEFAULT_ENDPOINT };
  const model = m.model ?? {};
  const inst = st.install ?? {};
  const svcInstalled = !!inst.serverFound;
  const svcOk = !!st.health?.healthy;
  // 远程模式（endpoint 指向非本机）：不引导本地安装，进已安装视图管理外部服务
  const remoteConfigured = m.mode === 'remote' && !!m.endpoint && !isLocalHost(m.endpoint);
  const showWizard = !svcInstalled && !svcOk && !remoteConfigured;
  const authInitNeeded = !!usersSnapshot?.authInitNeeded;

  el.innerHTML = `${pageIntro}${tabBarHtml(authInitNeeded)}<div id="memTabBody"></div>`;
  bindTabBar();
  const body = $('#memTabBody');
  if (activeTab === 'users') return renderUsersTab(body, { st, m });
  if (showWizard) return renderWizard(body, { m, model, modelSaved: !!(model.apiBase && model.vlmModel && model.embeddingModel) });
  return renderInstalled(body, { st, m, model, inst, state: deriveState(st, svcInstalled), meta: STATE_META[deriveState(st, svcInstalled)] ?? STATE_META.error, remoteConfigured, authInitNeeded });
}

// ============ Tab1 · 未安装向导 ============

function renderWizard(el, { m, model, modelSaved }) {
  const epVal = (m.endpoint && m.endpoint !== DEFAULT_ENDPOINT) ? m.endpoint : '';
  el.innerHTML = `
  <div class="card">
    <div style="display:flex;align-items:center;gap:10px">
      <h3 style="margin:0">开始使用记忆增强</h3>
      <span style="flex:1"></span>
      <button class="btn primary sm" id="memInstall" ${modelSaved ? '' : 'disabled'} title="${modelSaved ? '自动完成安装与配置（检测/安装 uv → 服务 → 配置 → 拉起 → 插件）' : '请先在下方「模型配置」卡填写并保存（安装生成服务配置需要模型三件套）'}">⚡ 一键安装</button>
    </div>
    <div style="background:var(--primary-weak);border-radius:10px;padding:14px 16px">
      <b>未安装 OpenViking 服务</b>
      <div class="hint" style="margin-top:4px;line-height:1.7">点右上「⚡ 一键安装」自动完成安装与配置（检测/安装 uv 运行时 → 安装 OpenViking 服务 → 生成配置 → 拉起服务 → 接入记忆插件）。全程无须终端；已就绪部件自动跳过，可重复执行。安装完成后到「用户与密钥」Tab 一键初始化网页/机器人密钥。</div>
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
    <div class="desc" style="margin-top:6px">记忆的<b>提炼（vlm）与向量化（embedding）</b>走 OpenAI 协议端点，两块可各自独立端点与 Key（跨厂商组合），默认向量块沿用主块。建议先 [测试连接] 双绿，再保存并一键安装。</div>
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

③ 回到本页：保存模型配置 → 一键安装 → 「用户与密钥」一键初始化</pre>
      <div class="hint" style="margin-top:8px;line-height:1.9">常见问题：
· 启动失败 / 服务异常 → 点「一键检查 / 修复」重跑流水线（已就绪步骤自动跳过，不覆盖现有数据）；首装冷启动可能超过 1 分钟，流水线会转为后台等待并实时显示秒数，无需反复重试
· 鉴权失败 → 到「用户与密钥」Tab 一键初始化（api_key 模式下网页/机器人各需一把用户密钥）
· 支持哪些模型 → 任意 OpenAI 协议端点（智谱 / 方舟 / 中转 / Ollama 本地）；提炼与向量可分别指定
· 修改端口 → 模型配置里的「服务端点」；一键安装会自动避开占用端口</div>
    </details>
  </div>`;

  bindModelForm(true, false);
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

// ============ Tab1 · 已安装视图 ============

function renderInstalled(el, { st, m, model, inst, state, meta, remoteConfigured, authInitNeeded }) {
  const ver = st.health?.version;
  const endpoint = m.endpoint || DEFAULT_ENDPOINT;
  const authNote = st.authNote;
  const off = !m.enabled;

  // 状态行主文案 + 补充说明（running 一行收尾；其余态独立说明行带 detail + 行动建议）
  const statusSub = state === 'running' ? 'OpenViking 服务运行正常，记忆召回与归档已就绪'
    : state === 'stopped' ? '服务已安装，进程未运行——点右上「▶ 启动服务」一键拉起（自动检查配置 → 拉起探活 → 接入插件）'
      : '';
  // 鉴权失败态优先引导「用户与密钥」Tab（api_key 模式下 401 的正确解法是初始化用户密钥，而非改模型配置）
  const statusDetail = state === 'running' || state === 'stopped' ? ''
    : `${esc(st.health?.detail || '探活失败')}${REASON_HINT[st.health?.reason] ? `<br>➜ ${REASON_HINT[st.health.reason]}` : ''}`;
  const goUsersBtn = (state === 'auth' || authInitNeeded)
    ? '<button class="btn sm" id="memGoUsers" style="margin-top:8px">去 用户与密钥 →</button>' : '';

  // 信息网格：只渲染「有值」的列（隐藏字段不占列位）；运行方式用 mode 推导（embedded=LCB 受管安装）
  // 网格固定 3 列（一行 3 项；auto-fit 会在宽屏挤成 6 列）；地址列不跨列，长 URL 列内省略号截断防撑破；插件列值整体 nowrap 防拆行
  const cells = [
    infoCell('globe', '服务地址', `<span style="white-space:nowrap;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%"><code style="font-size:11.5px;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(endpoint)}</code><button class="btn sm" id="memCopy" title="复制服务地址" style="padding:2px 9px;flex:0 0 auto">⧉</button>${remoteConfigured ? '<span class="hint">远程</span>' : ''}</span>`),
    ...(state === 'running' && ver ? [infoCell('box', '版本', `v${esc(ver)}`)] : []),
    infoCell('server', '运行方式', m.mode === 'embedded'
      ? `LCB 受管${inst.managedRunning ? '' : ' <span class="hint">（未运行）</span>'}`
      : `外部自管 <span class="hint">非 LCB 拉起</span>`),
    // 运行时间不单独占格：上面「启动自举」已带（主人反馈 #2）
    // 随 LCB 启动的自动拉起结果：成功只作留痕，失败把「手动开启指引」摆到状态区
    // （自举失败不阻断 LCB，用户必须能从页面一眼看到该去哪手动起）
    ...(inst.autoStart ? [infoCell('clock', '启动自举', inst.autoStart.ready
      ? `<span style="color:var(--ok-tx);font-weight:600">✓</span> 随 LCB 自动拉起 <span class="hint">${esc(fmtSince(inst.autoStart.at))}</span>`
      : `<span style="color:var(--warn-tx);font-weight:600">⚠ 未就绪</span> <span class="hint" title="${esc(inst.autoStart.hint || '')}">${esc(inst.autoStart.detail)}</span>`
        + `${inst.autoStart.hint ? `<div class="hint" style="margin-top:2px">手动开启：${esc(inst.autoStart.hint)}</div>` : ''}`)] : []),
    ...(st.health?.authMode ? [infoCell('server', '鉴权模式', `${esc(st.health.authMode)}${authNote ? ` <span class="hint" title="${esc(authNote)}">ⓘ</span>` : ''}`)] : []),
    infoCell('spark', '记忆插件', (st.plugin?.found
      ? `<span style="white-space:nowrap;display:inline-flex;align-items:center;gap:6px"><span style="color:var(--ok-tx);font-weight:600">✓</span><code>${esc(st.plugin.name)}</code>${st.plugin.version ? `<span class="hint">v${esc(st.plugin.version)}</span>` : ''}${st.plugin.source && PLUGIN_SOURCE_LABEL[st.plugin.source] ? `<span class="hint" title="实际加载渠道：与机器人任务装配一致">${esc(PLUGIN_SOURCE_LABEL[st.plugin.source])}</span>` : ''}</span>`
      : '<span style="color:var(--warn-tx);font-weight:600">○ 未安装</span><span class="hint">「检查修复」可补装</span>') + clientConfBadge(st.plugin)),
  ];

  // 卡标题右按钮组：主行动随状态切换（启动/停止），刷新与检查修复常驻
  // 检查/修复门禁与向导一键安装同口径：受管 conf 缺失（= 重跑会走首装生成 ov.conf）且模型
  // 三件套未保存时禁用——把「缺模型」挡在点击之前，而不是让用户在「生成服务配置」步骤撞失败
  const needModelFirst = !inst.confFound && !modelSavedCheck(model);
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
      ${goUsersBtn}
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-flow:dense;gap:16px 22px;margin-top:16px">${cells.join('')}</div>
    </div>
    ${authInitNeeded ? `<div class="hint" style="margin-top:10px;padding:9px 14px;background:var(--warn-bg);color:var(--warn-tx);border-radius:10px">🔑 待初始化鉴权：服务为 api_key 模式但网页端用户尚未创建——浏览器打开记忆空间会 401。到「用户与密钥」Tab 点「一键初始化」即可。</div>` : ''}
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
    <div class="desc" style="margin-top:6px">记忆的<b>提炼（vlm）与向量化（embedding）</b>走 OpenAI 协议端点，两块可各自独立端点与 Key（跨厂商组合），默认向量块沿用主块。变更后先 [测试连接] 双绿再保存；保存后可「立即生效」。</div>
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
      if (authInitNeeded) blockers.push('网页端用户未创建（待初始化鉴权）——开启后到「用户与密钥」Tab 一键初始化');
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

  // 去「用户与密钥」Tab（入口联动：Tab1 只留跳转，不承载密钥操作——权限隔离）
  const goUsers = $('#memGoUsers');
  if (goUsers) goUsers.onclick = () => switchTab('users');

  // 停止受管服务（危险确认；外部自管服务不显示此按钮）
  const stopBtn = $('#memStop');
  if (stopBtn) stopBtn.onclick = async () => {
    if (!(await confirmDialog({ title: '停止受管服务', message: '停止 LCB 托管的 OpenViking 服务？记忆功能将不可用（独立手动安装的服务不受影响，可随时重新拉起）。', confirmText: '停止' }))) return;
    try { await api('POST', '/api/memory/stop', {}); toast('已停止'); hooks.rerender(); } catch (e) { toast(e.message, true); }
  };

  bindModelForm(false, true);
  // 已安装视图：检查/修复门禁——受管 conf 已存在时放行（沿用现值重跑）；缺失时与向导同口径要模型三件套
  bindInstallActions(() => needModelFirst);
}

/** 模型三件套就绪判定（status 数据源：apiBase/vlmModel/embeddingModel） */
const modelSavedCheck = (model) => !!(model && model.apiBase && model.vlmModel && model.embeddingModel);

// ============ Tab2 · 用户与密钥（最终方案 §六） ============

/** 体量人性化 */
const fmtSize = (b) => (b === undefined || b === null) ? '—'
  : b < 1024 ? `${b} B`
    : b < 1048576 ? `${(b / 1024).toFixed(0)} KB`
      : `${(b / 1048576).toFixed(1)} MB`;

/** 最近活跃人性化（目录最大 mtime） */
const fmtActive = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 86400000) return '今天';
  const days = Math.floor(diff / 86400000);
  if (days < 30) return `${days} 天前`;
  return new Date(t).toLocaleDateString();
};

// ============ 记忆身份关联（identityMap：机器人 → OpenViking 用户） ============

/** doc.memory 兜底取段（granularity 同款口径）；identityMap / displayNames 均为可选 Record */
const memSeg = () => (S.doc.memory && typeof S.doc.memory === 'object') ? S.doc.memory : {};
/** 机器人生效记忆身份（与后端 resolveMemoryUid 同口径：显式映射优先，缺省 = 专属用户 uid=appId） */
const resolvedUid = (appId) => {
  const map = memSeg().identityMap;
  return (map && typeof map === 'object' ? (map[appId] || '').trim() : '') || appId;
};
/** uid 的中文显示名（doc.displayNames 显式条目；服务端 user_id 仅 ASCII，人可读对照以本映射为准） */
const uidDisplayName = (uid) => {
  const dn = memSeg().displayNames;
  return (dn && typeof dn === 'object' ? (dn[uid] || '').trim() : '') || '';
};
/** 关联到某 uid 的机器人（前端按 doc.identityMap 现算，与后端签发/下发同口径） */
const membersOf = (bots, uid) => bots.filter((b) => resolvedUid(b.appId) === uid);
/** 用户 ID 合法性（与后端 isValidUserId / OpenViking identifiers 同口径：仅 ASCII） */
const UID_RE = /^[A-Za-z0-9_.@-]{1,128}$/;
/** 列表排序：网页管理 → 共享（多成员）→ 机器人专属 → 其余（历史/未关联） */
const identityOrder = (r) => r.u.userId === 'web' ? 0 : r.members.length > 1 ? 1 : r.members.length === 1 ? 2 : 3;

/**
 * 用户行（按记忆身份渲染）：显示名优先（displayNames > 唯一成员机器人名 > 推导名 > uid），
 * 技术 ID 缩为 code；类型徽标与成员 chips 由前端按 identityMap + bots 现算（后端 kind 仅兜底）。
 * members = 关联到该 uid 的机器人列表（{appId, name}）
 */
function userRowHtml(u, members, bots) {
  const isWeb = u.userId === 'web';
  const disp = uidDisplayName(u.userId);
  const ownBot = bots.find((b) => b.appId === u.userId);
  // 历史聊天者：复合 ID（{appId}-{ou_xxx}）且无成员关联、无显示名（旧口径遗留身份）
  const isLegacyChat = !isWeb && members.length === 0 && !disp && !ownBot
    && bots.some((b) => u.userId.startsWith(`${b.appId}-`));
  const displayName = disp
    || (members.length === 1 ? (members[0].name || members[0].appId)
      : members.length > 1 ? '共享身份'
      : isWeb ? '网页管理'
      : ownBot ? (ownBot.name || ownBot.appId)
      : u.userId);
  let kindTag;
  if (isWeb) kindTag = '<span class="tag ok">网页管理</span>';
  else if (members.length > 1) kindTag = `<span class="tag warn">共享身份 × ${members.length}</span>`;
  else if (members.length === 1) kindTag = '<span class="tag info">机器人专属</span>';
  else if (isLegacyChat) kindTag = '<span class="tag off">历史聊天者</span>';
  else if (ownBot) kindTag = '<span class="tag ghost">历史身份</span>';
  else kindTag = '<span class="tag ghost">未关联</span>';
  const sharedWarning = members.length > 1
    ? `<span class="tag warn" title="重置密钥会使这 ${members.length} 台机器人的会话记忆暂不可用（下一条消息自动恢复）；删除前需先解除全部关联">⚠ 联动</span>`
    : '';
  const keyState = u.keyAvailable
    ? `密钥 <span title="脱敏显示，完整密钥经「复制 key / 打开记忆空间」按需放行">${esc(u.keyHint || '••••')}</span>`
    : '<span style="color:var(--warn-tx)">密钥未在库</span>';
  const meta = [fmtSize(u.sizeBytes), u.lastActive ? `活跃于 ${fmtActive(u.lastActive)}` : '暂无记忆数据'].filter(Boolean).join(' · ');
  const memberChips = members.length
    ? `<div class="chips">${members.map((b) => `<span class="chip" title="${esc(b.appId)}">🤖 ${esc(b.name || b.appId)}</span>`).join('')}</div>`
    : isWeb ? '' : `<div class="chips"><span class="chip src">${ownBot ? '未关联 · 历史记忆保留' : '暂无机器人关联 · 历史数据保留'}</span></div>`;
  const purpose = isWeb
    ? '用途：网页端（Studio 记忆空间 / 文件系统页）用它这把'
    : members.length > 1
      ? '用途：成员机器人共用这份记忆，互相可见、互相沉淀'
      : members.length === 1
        ? '用途：该机器人的专属记忆（会话由 LCB 自动注入，无须手填）'
        : ownBot
          ? '用途：该机器人的历史记忆保留于此；在下方关联区重新关联即可继续使用'
          : isLegacyChat ? '历史聊天者身份（{appId}-{ou_xxx} 旧口径）' : '';
  return `<div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
    <span style="width:8px;height:8px;border-radius:50%;background:var(--ok-tx);flex:0 0 auto"></span>
    <div style="min-width:220px;flex:1">
      <div style="font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${esc(displayName)}
        <span class="hint"><code style="font-size:11px" title="用户 ID 由 OpenViking 绑定在密钥与数据目录中（服务端无改名接口），不支持修改；中文对照请点「编辑」修改显示名称">${esc(u.userId)}</code></span>
        ${kindTag}${sharedWarning}
        <span class="hint">${keyState}</span>
      </div>
      ${memberChips}
      <div class="hint" style="margin-top:3px">${meta}${purpose ? ` · ${esc(purpose)}` : ''}</div>
    </div>
    <button class="btn sm primary" data-open="${esc(u.userId)}" title="以「${esc(displayName)}」的身份进入记忆空间：该密钥进剪贴板并自动打开 Studio 文件系统页，粘贴一次即连接${members.length > 1 ? `（共享身份：打开的是这 ${members.length} 台机器人共用的记忆）` : ''}">打开记忆空间</button>
    <button class="btn sm" data-copy="${esc(u.userId)}" title="复制密钥（脱敏显示，此操作会留痕）">⧉ 复制key</button>
    <button class="btn sm" data-rename="${esc(u.userId)}" title="编辑中文显示名称（仅本页展示；用户 ID 不支持修改）">编辑</button>
    <button class="btn sm" data-reset="${esc(u.userId)}" title="重签密钥：旧密钥立即失效${members.length > 1 ? `，影响全部 ${members.length} 台关联机器人` : ''}">重置</button>
    <button class="btn sm danger" data-del="${esc(u.userId)}" title="删除用户与记忆（先自动备份本地数据）">删除</button>
  </div>`;
}

/**
 * 「连接 1933 网页控制台」指引卡 —— 回答两个问题：① Studio 那个框填哪把钥匙；② 为什么进去之后
 * 身份显示 default 且切不了。
 *
 * 起因（用户实测卡点）：
 *  - 登录框要「Root 或账号管理员 API 密钥」，而本页此前没有任何 root key 线索，唯一长得像的
 *    「模型配置 → API Key」是模型厂商 key，填进去必 401；
 *  - 用 Root key 进去后身份恒为 default，切不动 → 误以为「LCB 没按机器人隔离」。
 *
 * 事实（实弹探针 + Studio 前端文案双向确认）：
 *  - **Root key 是单段 48 字符**（无 account/user 段），代表 default 账号的管理员；Studio 明说
 *    「当前服务器模式不支持切换身份」，且「切换身份」不改 Root 管理凭证 → Root 登录态就是 default，
 *    这是 Studio 的设计，不是 LCB 隔离失效；
 *  - **用户 key 是三段 base64url(account).user.secret**，每个机器人一把（user 段 = appId）；
 *    服务端磁盘 `data/viking/default/user/{appId}/` 一机一目录，记忆物理隔离。
 *  → 所以「看某个机器人的记忆」必须用**那个机器人的用户 key 登录**，不是「在 Root 里切换」。
 */
function studioGuideCardHtml(rk, endpoint) {
  const srcLabel = rk?.source === 'config' ? 'config.yaml 的 memory.api_key'
    : rk?.source === 'ov-conf' ? '受管 ov.conf 的 server.root_api_key' : '';
  const stateHtml = rk?.configured
    ? `<span class="tag ok">✓ 已配置</span> <span class="hint">来源：${esc(srcLabel)}；查看行为会留痕</span>`
    : '<span class="tag err">✗ 未配置</span> <span class="hint">请到「服务与配置」点「检查修复」重新生成</span>';
  // 精简（主人反馈）：hover 悬浮塞不下格式化长文 → ⓘ 改为「点击弹说明弹窗」，悬浮只留一句话
  return `<div class="card" style="margin-top:12px">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <b style="font-size:13.5px">🌐 连接 OpenViking Studio（${esc((endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ''))}/studio）</b>
      <button class="btn sm ghost" id="memGuideInfo" title="Root 密钥与用户密钥的区别、如何进入某个机器人的记忆空间">ⓘ 连接说明</button>
      <span style="flex:1"></span>
      <button class="btn sm" id="memCopyRoot" title="复制 Root 密钥到剪贴板（查看行为留痕）" ${rk?.configured ? '' : 'disabled style="opacity:.5;cursor:not-allowed"'}>⧉ 复制 Root 密钥</button>
      <button class="btn sm primary" id="memOpenStudio" title="复制 Root 密钥 → 打开 Studio 新标签 → 在「Root 或账号管理员 API 密钥」框 Ctrl+V 即可进入">打开 Studio 并复制</button>
    </div>
    <div id="memRootStatus" class="hint" style="margin-top:6px;line-height:1.7"></div>
  </div>
  <template id="memGuideState">${stateHtml}</template>`;
}

/** 「连接说明」弹窗（点击 ⓘ 打开；富文本排版，替代塞不下也看不清的 hover 长提示） */
function openStudioGuideModal() {
  const stateHtml = document.getElementById('memGuideState')?.innerHTML || '';
  openModal({
    title: '连接 OpenViking Studio 说明',
    width: 'min(560px,92vw)',
    bodyHtml: `
      <div class="sub-title">方式一 · 管理员（Root 密钥）</div>
      <div class="desc" style="margin:0 0 4px">用于<b>管理</b>：列出用户、复制/重置他人密钥、账号设置。用它登录后，Studio 里的身份<b>固定显示为 <code>default</code> 且无法切换</b>——这是 Studio 的设计（管理员凭证不含具体用户身份），<b>不代表机器人记忆没隔离</b>。</div>
      <div class="sub-title" style="margin-top:14px">方式二 · 查看某个机器人的记忆（该机器人的用户密钥）</div>
      <div class="desc" style="margin:0 0 4px">在下方用户列表点那一行<b>「打开记忆空间」</b>：密钥自动进剪贴板并打开该身份的记忆页，粘贴一次即可进入。每个机器人一把独立密钥、一机一目录，数据物理隔离。</div>
      <div class="banner warn" style="margin-top:12px"><span>⚠️ 两种登录态<b>不能互相切换</b>：看 A 机器人就用 A 的密钥进。<br>⚠️ <b>不要</b>把「模型配置」里的模型厂商 API Key（智谱等）填进 Studio——那是调模型用的，与鉴权无关，填了必 401。</span></div>
      <div class="hint" style="margin-top:12px">Root 密钥状态：${stateHtml}</div>`,
    footHtml: `<span class="sp"></span><button class="btn primary" id="mgOk">知道了</button>`,
  });
  $('#mgOk').onclick = closeModal;
}

/** Tab2 主渲染：一键初始化 + Studio 接入指引 + 用户列表（网页管理 / 机器人分组）+ 粒度向导 */
function renderUsersTab(el, { st, m }) {
  const u = usersSnapshot;
  const healthy = !!st.health?.healthy;
  const apiKeyMode = st.health?.authMode === 'api_key';
  const gran = (S.doc.memory && typeof S.doc.memory === 'object' && S.doc.memory.granularity) || 'bot';

  let bodyHtml;
  if (!u) {
    bodyHtml = `<div class="card"><div class="hint">用户列表加载失败（服务未运行或请求异常）。</div>
      <button class="btn sm" id="memUsersRetry" style="margin-top:10px">重试</button></div>`;
  } else if (!healthy) {
    bodyHtml = `<div class="card">
      <div style="background:var(--warn-bg);border-radius:10px;padding:14px 16px">
        <b>服务未运行</b>
        <div class="hint" style="margin-top:4px;line-height:1.7">${esc(u.error || st.health?.detail || 'OpenViking 服务不可达')}——请先到「服务与配置」Tab 拉起服务，再回到本页管理用户与密钥。</div>
      </div></div>`;
  } else if (!apiKeyMode) {
    bodyHtml = `<div class="card">
      <div style="background:var(--off-bg);border-radius:10px;padding:14px 16px">
        <b>当前为 ${esc(u.authMode || 'dev')} 模式：无须用户密钥</b>
        <div class="hint" style="margin-top:4px;line-height:1.7">本机回环免鉴权，机器人身份经命名空间隔离（显式关联的身份固定为映射 uid）——浏览器打开记忆空间可直接访问。部署走向多人共享 / 出现敏感内容隔离需求时，配置 root_api_key 切换到 api_key 模式后，回本页即可管理用户与密钥。</div>
      </div>
      ${bindingCardHtml(st.bots || [])}
      ${granularityCardHtml(gran)}</div>`;
  } else {
    const bots = st.bots || [];
    // 记忆身份单列表（v4 原型形态）：按 成员数 排序（网页管理 → 共享 → 专属 → 历史/未关联）
    const rows = u.users
      .map((x) => ({ u: x, members: membersOf(bots, x.userId) }))
      .sort((a, b) => identityOrder(a) - identityOrder(b));
    bodyHtml = `<div class="card">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0">用户与密钥</h3>
        <span class="hint">${esc(String(u.users.length))} 个用户 · 合计 ${fmtSize(u.totalBytes)} 记忆数据</span>
        <span style="flex:1"></span>
        <button class="btn sm primary" id="memUserCreate" title="新建 OpenViking 用户（可填中文显示名称，仅本页展示）">＋ 新建用户</button>
        <button class="btn sm" id="memUsersRefresh">↻ 刷新</button>
      </div>
      <div class="desc" style="margin-top:6px">记忆身份 = OpenViking 用户（账号 <code>${esc(m.account || 'default')}</code> 下）。每台机器人<b>关联且仅关联一个</b>身份，会话记忆读写该身份——多台机器人关联同一身份即共享记忆。
        <span class="tip" style="vertical-align:-1px" data-tip="密钥落盘已加密；1933 网页右上角身份显示的是技术 ID（服务端仅支持 ASCII、无显示名字段），中文对照以本页「显示名称」为准——点用户行「编辑」可修改。用户 ID 由 OpenViking 绑定在密钥与数据目录中，不支持修改。">ⓘ</span></div>
      ${u.authInitNeeded ? `<div class="hint" style="margin-top:10px;padding:9px 14px;background:var(--warn-bg);color:var(--warn-tx);border-radius:10px">🔑 待初始化鉴权：网页端用户尚未创建，浏览器打开记忆空间会 401——LCB 启动已包含 web 用户自动签发，稍候点「↻ 刷新」；持续缺失请检查服务与 root key。</div>` : ''}
      ${u.users.length === 0 && !u.authInitNeeded ? '<div class="hint" style="margin-top:12px">暂无用户——点「＋ 新建用户」创建，或由 LCB 启动时自动补签。</div>' : ''}
      ${studioGuideCardHtml(u.rootKey, m.endpoint)}
      <div style="margin-top:6px">${rows.map((r) => userRowHtml(r.u, r.members, bots)).join('')}</div>
      ${bindingCardHtml(bots)}
      ${granularityCardHtml(gran)}
    </div>`;
  }
  el.innerHTML = bodyHtml;
  bindUsersTabActions(el, { m, st });
}

/** 粒度向导卡（方案 §六：默认 bot 级；「升级到 bot×人」开关 = 增量升级意向，不动既有 key 与记忆） */
const granularityCardHtml = (gran) => `
  <div class="card" style="margin-top:14px;">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <b style="font-size:13.5px">记忆粒度</b>
      <span class="hint">${gran === 'bot-user' ? '已选择：bot × 人（每位聊天者独立空间）' : '当前：每 bot 一把密钥（默认，单机自用零损失）'}</span>
      <span style="flex:1"></span>
      <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
        <span class="hint">升级到 bot×人（暂不支持升级）</span>
        <!-- 我暂时把这个开关关掉，暂时不开放开启 -->
        <!--<label class="switch"><input type="checkbox" id="memGran" ${gran === 'bot-user' ? 'checked' : ''}><span class="track"></span></label>-->
      </label>
    </div>
    <div class="hint" style="margin-top:8px;line-height:1.8">升级属<b>增量演进</b>：不影响既有密钥与记忆、会话不中断，仅为新聊天者追加独立签发。
      <span class="tip" style="vertical-align:-1px" data-tip="建议触发条件（任一出现即升级）：同一 bot 服务 2 人以上且内容敏感；出现「记忆是谁写的」追溯需求；部署走向团队共享。">ⓘ</span></div>
  </div>`;

/**
 * 「飞书机器人 → 记忆身份」关联卡：每台机器人一个下拉（关联且仅关联一个用户；多台关联同一
 * 用户 = 共享记忆）。选择只暂存（行内亮「保存」），保存经确认弹窗写 doc.identityMap → saveDoc
 * 落盘 → memory 热重载自动重签（新 uid 由签发路径自动建户）→ 下一条消息生效。
 * 选项：我的专属用户（不存在也保留，标「待创建」）→ 其他可用用户 → ➕ 新建共享身份并绑定（弹窗）。
 * web / 历史聊天者身份不可作为关联目标（前者网页专用，后者是旧口径遗留）。
 */
function bindingCardHtml(bots) {
  if (!bots.length) return '';
  const users = usersSnapshot?.users ?? [];
  const isLegacyChat = (uid) => bots.some((b) => uid.startsWith(`${b.appId}-`) && uid !== b.appId);
  const eligible = users.filter((x) => x.userId !== 'web' && !isLegacyChat(x.userId));
  const rowsHtml = bots.map((b) => {
    const cur = resolvedUid(b.appId);
    const opts = [];
    const hasOwn = users.some((x) => x.userId === b.appId);
    opts.push(`<option value="${esc(b.appId)}" ${cur === b.appId ? 'selected' : ''}>${esc(b.appId)}（我的专属用户${hasOwn ? '' : ' · 待创建'}）</option>`);
    for (const x of eligible) {
      if (x.userId === b.appId) continue;
      const n = membersOf(bots, x.userId).length;
      const disp = uidDisplayName(x.userId);
      const label = `${disp || x.userId}（${[disp ? x.userId : null, n ? `${n} 台关联` : '未关联'].filter(Boolean).join(' · ')}）`;
      opts.push(`<option value="${esc(x.userId)}" ${cur === x.userId ? 'selected' : ''}>${esc(label)}</option>`);
    }
    opts.push('<option value="__new__">➕ 新建共享身份并绑定…</option>');
    const mates = membersOf(bots, cur).filter((x) => x.appId !== b.appId);
    const curDisp = uidDisplayName(cur);
    const curDesc = cur === b.appId
      ? `当前：关联专属用户 <code>${esc(cur)}</code>（独立记忆，互不可见）`
      : `当前：关联${curDisp ? `「${esc(curDisp)}」` : ''} <code>${esc(cur)}</code>${mates.length ? `（与 ${esc(mates.map((x) => x.name || x.appId).join('、'))} 共用）` : '（暂无同伴）'}`;
    return `<div data-bindrow="${esc(b.appId)}" style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
      <div style="min-width:200px;flex:1">
        <div style="font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${esc(b.name || b.appId)}
          <span class="hint"><code style="font-size:11px">${esc(b.appId)}</code></span>
        </div>
        <div class="hint" style="margin-top:2px">${curDesc}</div>
      </div>
      <select data-bindsel="${esc(b.appId)}" style="width:260px" title="每台机器人只能关联一个 OpenViking 用户；多台关联同一用户即共享记忆">${opts.join('')}</select>
      <button class="btn sm primary" data-savebind="${esc(b.appId)}" hidden>保存</button>
    </div>`;
  }).join('');
  return `<div style="margin-top:16px">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <b style="font-size:13.5px">飞书机器人 → 记忆身份</b>
      <button class="btn sm ghost" id="memBindInfo" title="关联规则、共享记忆语义、生效与迁移">ⓘ 分配说明</button>
    </div>
    <div class="desc" style="margin-top:4px">为每台机器人选择要<b>关联</b>的 OpenViking 用户：一台机器人只能关联一个用户；多台关联同一用户即共享记忆（互相可见、互相沉淀）。保存后下一条消息生效，运行中的会话自动重建。</div>
    <div style="margin-top:4px">${rowsHtml}</div>
  </div>`;
}

/**
 * 新建用户弹窗（v4 原型形态；bindTo 传 appId = 创建并关联到该机器人）。
 * 创建走 POST /api/memory/users/create（Admin API 建户 + 密钥入保险库）；显示名称写
 * doc.displayNames、关联写 doc.identityMap，一并 saveDoc 落盘（memory 热重载自动重签生效）。
 * 校验失败红字留在弹窗内；Enter 提交 / Esc 关闭。
 */
function openCreateModal(bindTo, bindToName) {
  openModal({
    title: '新建 OpenViking 用户',
    width: 'min(520px,92vw)',
    bodyHtml: `
      ${bindTo ? `<div class="banner info" style="margin-bottom:8px"><span>创建后将关联到机器人：<b>${esc(bindToName || bindTo)}</b>（下一条消息生效）</span></div>` : ''}
      <label class="fld" style="margin-top:0">用户 ID（记忆身份标识 · 仅字母/数字/_ . @ -）</label>
      <input type="text" id="muDlgUid" placeholder="如 shared-work" autocomplete="off">
      <div id="muDlgErr" style="display:none;color:var(--err-tx);font-size:12px;margin-top:5px"></div>
      <label class="fld">显示名称（可空 · 中文友好名，仅本页展示）</label>
      <input type="text" id="muDlgDisp" placeholder="如：日常共享记忆" autocomplete="off">
      <div class="hint" style="margin-top:12px">创建后自动签发密钥；密钥仅在「复制 key / 打开记忆空间」时放行并留痕。OpenViking 的用户 ID 仅支持 ASCII——中文请填「显示名称」。</div>`,
    footHtml: `<span class="sp"></span><button class="btn" id="muDlgCancel">取消</button><button class="btn primary" id="muDlgOk">${bindTo ? '创建并关联' : '创建并签发密钥'}</button>`,
  });
  const uidEl = $('#muDlgUid');
  const dispEl = $('#muDlgDisp');
  const errEl = $('#muDlgErr');
  const okBtn = $('#muDlgOk');
  const close = () => closeModal();
  const submit = async () => {
    const uid = uidEl.value.trim();
    const fail = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };
    if (!UID_RE.test(uid)) return fail('仅允许字母、数字、下划线、点、@、连字符，长度 1–128（如 shared-work）');
    if ((usersSnapshot?.users ?? []).some((x) => x.userId === uid)) return fail(`用户 ${uid} 已存在`);
    okBtn.disabled = true;
    okBtn.textContent = '创建中…';
    try {
      const r = await api('POST', '/api/memory/users/create', { user_id: uid });
      if (!r.ok) {
        okBtn.disabled = false;
        okBtn.textContent = bindTo ? '创建并关联' : '创建并签发密钥';
        return fail(r.error || '创建失败');
      }
    } catch (e) {
      okBtn.disabled = false;
      okBtn.textContent = bindTo ? '创建并关联' : '创建并签发密钥';
      return fail(e.message);
    }
    // 显示名称与关联走配置 doc 管道落盘（一次 saveDoc 同时持久化；memory 热重载自动重签）
    if (!S.doc.memory || typeof S.doc.memory !== 'object') S.doc.memory = {};
    const dispName = dispEl.value.trim();
    if (dispName) {
      if (!S.doc.memory.displayNames || typeof S.doc.memory.displayNames !== 'object') S.doc.memory.displayNames = {};
      S.doc.memory.displayNames[uid] = dispName;
    }
    if (bindTo) {
      if (!S.doc.memory.identityMap || typeof S.doc.memory.identityMap !== 'object') S.doc.memory.identityMap = {};
      S.doc.memory.identityMap[bindTo] = uid;
    }
    close();
    if (dispName || bindTo) await saveDoc();
    else toast(`已创建用户 ${uid} 并签发密钥（密钥在库加密存储）`);
    usersSnapshot = await api('GET', '/api/memory/users').catch(() => null);
    hooks.rerender();
  };
  okBtn.onclick = submit;
  $('#muDlgCancel').onclick = close;
  uidEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  dispEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  uidEl.focus();
}

/**
 * 修改显示名弹窗（用户行「编辑」按钮入口）：displayNames 是 LCB 侧中文对照映射（doc.memory.displayNames，
 * 仅本页与列表展示）。用户 ID 锁定只读——OpenViking 0.5.0 无 rename 接口，且 user_id 硬编码在
 * 每把密钥（base64url(account).user.secret）与数据目录（data/viking/<账号>/user/<uid>/）里，
 * 改 ID 即全部密钥失效、历史记忆失联，故只放开显示名。清空保存 = 删除映射条目（列表回落为
 * 机器人名/技术 ID）；落盘走 saveDoc（与新建弹窗同管道），成功后重拉用户快照重渲染。
 */
function openRenameModal(uid) {
  const cur = uidDisplayName(uid);
  openModal({
    title: '修改显示名称',
    width: 'min(520px,92vw)',
    bodyHtml: `
      <label class="fld" style="margin-top:0">用户 ID（只读 · OpenViking 身份标识）</label>
      <div style="display:flex;align-items:center;gap:8px">
        <code style="font-size:12.5px;padding:9px 12px;background:rgba(127,127,127,.08);border-radius:8px;flex:1;user-select:text;overflow-wrap:anywhere">${esc(uid)}</code>
        <span class="tip" data-tip="用户 ID 由 OpenViking 硬编码进每把用户密钥（base64url(账号).用户.密钥）与数据目录（data/viking/账号/user/ID），服务端无改名接口——修改即密钥全部失效、历史记忆失联。因此锁定只读，中文对照请改下方显示名称。">ⓘ</span>
      </div>
      <label class="fld">显示名称（可空 · 中文友好名，仅本页展示）</label>
      <input type="text" id="muRenDisp" placeholder="如：日常共享记忆" value="${esc(cur)}" maxlength="64" autocomplete="off">
      <div class="hint" style="margin-top:12px">清空并保存 = 删除显示名称，列表回落为机器人名 / 技术 ID。改名不影响密钥、记忆数据与机器人关联。</div>`,
    footHtml: `<span class="sp"></span><button class="btn" id="muRenCancel">取消</button><button class="btn primary" id="muRenOk">保存</button>`,
  });
  const dispEl = $('#muRenDisp');
  const okBtn = $('#muRenOk');
  const close = () => closeModal();
  const submit = async () => {
    const next = dispEl.value.trim();
    if (next === cur) return close(); // 无变更：直接关（不空转落盘）
    if (!S.doc.memory || typeof S.doc.memory !== 'object') S.doc.memory = {};
    if (!S.doc.memory.displayNames || typeof S.doc.memory.displayNames !== 'object') S.doc.memory.displayNames = {};
    if (next) S.doc.memory.displayNames[uid] = next;
    else delete S.doc.memory.displayNames[uid];
    close();
    await saveDoc(); // 失败已有 toast（displayNames 改动留在内存编辑态，可再次保存）
    try { usersSnapshot = await api('GET', '/api/memory/users'); } catch { /* 保持旧快照 */ }
    hooks.rerender();
  };
  okBtn.onclick = submit;
  $('#muRenCancel').onclick = close;
  dispEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  dispEl.focus();
  dispEl.select();
}

/** 「分配说明」弹窗（关联卡 ⓘ）：关联规则 / 共享语义 / 生效与迁移 / 联动风险 */
function openBindInfoModal() {
  openModal({
    title: '机器人 → 记忆身份 · 分配说明',
    width: 'min(560px,92vw)',
    bodyHtml: `
      <div class="sub-title">关联规则</div>
      <div class="desc" style="margin:0">每台飞书机器人<b>只能关联一个</b> OpenViking 用户；缺省关联自己的专属用户（uid = appId）。</div>
      <div class="sub-title" style="margin-top:14px">共享记忆</div>
      <div class="desc" style="margin:0">多台机器人关联<b>同一个</b>用户即共享记忆：互相可见、互相沉淀（A 机器人记住的事，B 机器人也能召回）。</div>
      <div class="sub-title" style="margin-top:14px">生效与迁移</div>
      <div class="desc" style="margin:0">· 保存后<b>下一条消息生效</b>，运行中的会话自动重建，无须重启桥接器<br>· <b>历史记忆不迁移</b>：改关联只影响之后的新记忆，原用户的记忆原地保留</div>
      <div class="banner warn" style="margin-top:12px"><span>⚠️ 共享用户被多台机器人关联时，重置 / 删除会影响<b>所有</b>关联它的机器人：重置密钥后成员会话记忆暂不可用（自动恢复）；删除前需先解除全部关联。</span></div>`,
    footHtml: `<span class="sp"></span><button class="btn primary" id="muBindOk">知道了</button>`,
  });
  $('#muBindOk').onclick = closeModal;
}

function bindUsersTabActions(el, { m, st }) {
  const endpoint = (m.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');

  const reload = async () => {
    try { usersSnapshot = await api('GET', '/api/memory/users'); } catch { usersSnapshot = null; }
    hooks.rerender();
  };

  const retry = $('#memUsersRetry');
  if (retry) retry.onclick = reload;

  const refreshBtn = $('#memUsersRefresh');
  if (refreshBtn) refreshBtn.onclick = reload;

  // —— 新建用户弹窗入口（卡片头「＋ 新建用户」） ——
  const createBtn = $('#memUserCreate');
  if (createBtn) createBtn.onclick = () => openCreateModal();

  // —— 关联卡：选择只暂存（行内亮「保存」）→ 确认 → identityMap 落盘（热重载自动重签生效） ——
  const bots = st.bots || [];
  const bindInfoBtn = $('#memBindInfo');
  if (bindInfoBtn) bindInfoBtn.onclick = openBindInfoModal;
  el.querySelectorAll('select[data-bindsel]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const appId = sel.dataset.bindsel;
      const row = el.querySelector(`[data-bindrow="${CSS.escape(appId)}"]`);
      const saveBtn = row?.querySelector('[data-savebind]');
      if (!saveBtn) return;
      if (sel.value === '__new__') {
        // 弹窗创建：先把下拉回退到当前关联，创建成功后统一刷新
        sel.value = resolvedUid(appId);
        openCreateModal(appId, bots.find((b) => b.appId === appId)?.name);
      } else {
        saveBtn.hidden = sel.value === resolvedUid(appId);
      }
    });
  });
  el.querySelectorAll('[data-savebind]').forEach((btn) => {
    btn.onclick = async () => {
      const appId = btn.dataset.savebind;
      const sel = el.querySelector(`select[data-bindsel="${CSS.escape(appId)}"]`);
      if (!sel) return;
      const from = resolvedUid(appId);
      const target = sel.value;
      if (!target || target === from || target === '__new__') return;
      const botName = bots.find((b) => b.appId === appId)?.name || appId;
      const dispOf = (uid) => uidDisplayName(uid) || (usersSnapshot?.users ?? []).find((x) => x.userId === uid)?.userId || uid;
      const others = (uid) => membersOf(bots, uid).filter((b) => b.appId !== appId);
      const uidDesc = (uid) => uid === appId
        ? `专属用户 <b>${esc(uid)}</b>（独立记忆）`
        : `用户 <b>${esc(dispOf(uid))}</b>（当前关联：${esc(others(uid).map((b) => b.name || b.appId).join('、')) || '无'}）`;
      if (!(await confirmDialog({
        title: '确认更改关联的用户',
        message: `${esc(botName)}：<code>${esc(from)}</code> → ${uidDesc(target)}<br><br>· 一台机器人只能关联一个用户，保存后即改为关联新用户<br>· 下一条消息生效，运行中的会话自动重建<br>· <b>历史记忆不迁移</b>：原用户的既有记忆原地保留，随时可用「打开记忆空间」查看`,
        confirmText: '保存',
      }))) { sel.value = from; return; }
      if (!S.doc.memory || typeof S.doc.memory !== 'object') S.doc.memory = {};
      if (!S.doc.memory.identityMap || typeof S.doc.memory.identityMap !== 'object') S.doc.memory.identityMap = {};
      S.doc.memory.identityMap[appId] = target;
      if (await saveDoc()) await reload();
      else sel.value = from;
    };
  });

  // Root 密钥放行 → 剪贴板 →（可选）打开 Studio。后端顺带做了「拿这把 key 实打服务端」的校验，
  // 结果直接回显在卡片里：拷贝即用，不必等 Studio 报 401 才回头猜是哪把钥匙不对
  const showRootResult = (r) => {
    const box = $('#memRootStatus');
    if (!box) return;
    if (r.valid === false) {
      box.innerHTML = `<span style="color:var(--danger)">⚠ ${esc(r.validDetail || '这把 Root 密钥未通过服务端校验')}</span>`;
    } else if (r.valid) {
      box.innerHTML = `<span style="color:var(--ok-tx)">✓ 这把 Root 密钥已通过服务端校验，可直接粘贴</span>`;
    }
  };
  const fetchRootKey = async () => {
    const r = await api('POST', '/api/memory/users/reveal-root', {});
    if (!r.ok || !r.key) { toast(r.error || 'Root 密钥未配置', true); return null; }
    showRootResult(r);
    return r.key;
  };
  const copyRoot = async () => {
    try {
      const key = await fetchRootKey();
      if (!key) return;
      try { await navigator.clipboard.writeText(key); } catch { return toast('Root 密钥已放行但剪贴板不可用——请手动复制', true); }
      toast('Root 密钥已复制（查看行为已留痕）——到 Studio 的「Root 或账号管理员 API 密钥」框 Ctrl+V');
    } catch (e) { toast(e.message, true); }
  };
  const openStudio = async () => {
    try {
      const key = await fetchRootKey();
      if (!key) return;
      let copied = true;
      try { await navigator.clipboard.writeText(key); } catch { copied = false; }
      window.open(`${endpoint}/studio`, '_blank', 'noopener');
      toast(copied
        ? 'Root 密钥已复制并打开 Studio——在「Root 或账号管理员 API 密钥」框 Ctrl+V 即可进入'
        : '已打开 Studio（剪贴板不可用，请手动填写 Root 密钥）');
    } catch (e) { toast(e.message, true); }
  };
  const copyRootBtn = $('#memCopyRoot');
  if (copyRootBtn) copyRootBtn.onclick = copyRoot;
  const openStudioBtn = $('#memOpenStudio');
  if (openStudioBtn) openStudioBtn.onclick = openStudio;
  // 指引卡内的「复制 Root 密钥」（同一 handler，多入口）
  el.querySelectorAll('[data-root-copy]').forEach((b) => { b.onclick = copyRoot; });
  // ⓘ 连接说明 → 点击弹富文本弹窗（hover 塞不下长文案）
  const guideBtn = $('#memGuideInfo');
  if (guideBtn) guideBtn.onclick = openStudioGuideModal;

  // 打开记忆空间（最终方案 §三 决策 5）：密钥进剪贴板 → 自动新标签开 Web Studio 文件系统页
  //（深链 /studio/filesystem 直落记忆目录树，避开默认的 VikingBot 标签——那是 OpenViking
  //  自带的 Agent 对话功能，需 --with-bot 启动，与记忆浏览无关）。未连接的浏览器会被
  //  Studio 引导到连接设置页，粘贴一次即可。
  const openSpace = async (uid) => {
    try {
      const r = await api('POST', '/api/memory/users/reveal', { user_id: uid });
      if (!r.ok || !r.key) return toast(r.error || '密钥获取失败', true);
      try { await navigator.clipboard.writeText(r.key); } catch { return toast('密钥已放行但剪贴板不可用——请在浏览器地址栏手动粘贴', true); }
      window.open(`${endpoint}/studio/filesystem`, '_blank', 'noopener');
      toast('密钥已复制到剪贴板——在打开的页面粘贴一次（Ctrl+V）即可连接');
    } catch (e) { toast(e.message, true); }
  };

  const copyKey = async (uid) => {
    try {
      const r = await api('POST', '/api/memory/users/reveal', { user_id: uid });
      if (!r.ok || !r.key) return toast(r.error || '密钥获取失败', true);
      await navigator.clipboard.writeText(r.key);
      toast(`已复制 ${uid} 的密钥（查看行为已留痕）`);
    } catch (e) { toast(e.message, true); }
  };

  const resetKey = async (uid) => {
    // 共享身份联动提示：被多台机器人关联时，重置会影响全部成员的会话记忆（自动恢复）
    const linked = membersOf(st.bots || [], uid);
    const linkedNote = linked.length > 1
      ? `<br><br>⚠ 该身份被 <b>${esc(linked.map((b) => b.name || b.appId).join('、'))}</b> 共 ${linked.length} 台机器人关联：重置后它们的会话记忆将暂不可用（下一条消息自动恢复）。`
      : '';
    if (!(await confirmDialog({
      title: '重置密钥', danger: true,
      message: `确定重置 <b>${esc(uid)}</b> 的密钥？<br><br>旧密钥将<b>立即失效</b>——所有使用此密钥的一方（浏览器连接、已打开的记忆空间、机器人会话）需同步更新并重启会话。${linkedNote}`,
      confirmText: '重置',
    }))) return;
    try {
      const r = await api('POST', '/api/memory/users/reset', { user_id: uid });
      if (!r.ok || !r.key) return toast(r.error || '重置失败', true);
      try { await navigator.clipboard.writeText(r.key); toast('新密钥已生成并复制到剪贴板（旧密钥已失效）'); }
      catch { toast('新密钥已生成（旧密钥已失效；剪贴板不可用，可稍后复制）'); }
    } catch (e) { toast(e.message, true); }
  };

  const delUser = async (uid) => {
    // 关联防呆：仍有机器人关联该身份时禁止删除（先改关联，防止成员机器人集体失忆）
    const linked = membersOf(st.bots || [], uid);
    if (linked.length > 0) {
      return toast(`无法删除：${esc(linked.map((b) => b.name || b.appId).join('、'))} 仍关联着该用户，请先在下方改关联到其他用户`, true);
    }
    if (!(await confirmDialog({
      title: '删除用户', danger: true,
      message: `确定删除 <b>${esc(uid)}</b>？<br><br>该用户的服务端数据将被异步清理；删除前会自动把本地记忆目录打包备份到 <code>openviking/backups/</code>（备份失败会中止删除）。`,
      confirmText: '删除',
    }))) return;
    try {
      const r = await api('POST', '/api/memory/users/delete', { user_id: uid });
      toast(r.ok ? (r.detail || '已删除') : (r.error || r.detail || '删除失败'), !r.ok);
      // 顺手清理中文对照映射（displayNames 是 LCB 侧条目，用户已删则映射无主，残留会在列表
      // 「显示名优先」链路里变成幽灵名字；清理失败不回滚删除本身——残留无害，仅展示层冗余）
      if (r.ok && S.doc?.memory && typeof S.doc.memory === 'object'
        && S.doc.memory.displayNames && typeof S.doc.memory.displayNames === 'object'
        && uid in S.doc.memory.displayNames) {
        delete S.doc.memory.displayNames[uid];
        await saveDoc();
      }
    } catch (e) { toast(e.message, true); }
    await reload();
  };

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open],[data-copy],[data-reset],[data-del],[data-rename]');
    if (!t) return;
    if (t.dataset.open) return void openSpace(t.dataset.open);
    if (t.dataset.copy) return void copyKey(t.dataset.copy);
    if (t.dataset.reset) return void resetKey(t.dataset.reset);
    if (t.dataset.del) return void delUser(t.dataset.del);
    if (t.dataset.rename) return void openRenameModal(t.dataset.rename);
  });

  const granEl = $('#memGran');
  if (granEl) granEl.onchange = async (e) => {
    const next = e.target.checked ? 'bot-user' : 'bot';
    if (!S.doc.memory || typeof S.doc.memory !== 'object') S.doc.memory = {};
    const old = S.doc.memory.granularity;
    S.doc.memory.granularity = next;
    if (await saveDoc()) {
      toast(next === 'bot-user'
        ? '已记录升级意向：bot×人（增量生效——既有密钥与记忆不动，新聊天者独立签发）'
        : '已回到每 bot 一把密钥');
    } else {
      S.doc.memory.granularity = old;
      e.target.checked = !e.target.checked;
    }
  };
}

export const page = {
  id: 'memory',
  title: '记忆增强',
  // desc: 'OpenViking 长期记忆：自动召回历史、归档提炼，按机器人命名空间隔离',
  desc: '',
  legend: false,
  icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  render: renderMemory,
};
