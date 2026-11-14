// 「记忆增强」tab 的后端逻辑（生命周期方案 §6.8，v2.3）：状态聚合 + 模型连接测试。
// 安全边界：root key / user key 永不返回浏览器（status 只含脱敏提示与 auth_mode）；
// test-connection 收到的 key 只在本次请求内转发到模型端点，不落盘不落日志。
import type { BridgeConfig } from '../types.js';
import { existsSync } from 'node:fs';
import {
  DEFAULT_MEMORY_ENDPOINT, MEMORY_PLUGIN_NAME, memoryEndpoint, probeMemoryHealth,
} from '../memory.js';
import {
  EXTERNAL_OV_CONF, MANAGED_OV_CONF, OVCLI_CONF, classifyClientConf, detectUv, getMemoryAutoStartReport, isManagedRunning, locateMemoryPlugin, managedStartedAt, resolveServerBin,
} from '../memory-installer.js';
import { maskSecret } from './config-api.js';

/** 承诺限时（安装探测里 uv 检测最坏要 spawn 子进程，超时按未检出降级，不拖慢 status） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`检测超时（>${ms}ms）`)), ms))]);
}

/**
 * 服务安装摘要（配置页四态状态机的探测源）：bin 存在性（uv → openviking-server）、conf 存在性
 * （受管 / 外部任一）、LCB 受管进程是否在跑。全程容错 + 限时——探测失败按「未检出」展示，
 * 不阻塞 status 其余字段。
 */
async function detectInstallSummary(): Promise<Record<string, unknown>> {
  const confFound = existsSync(MANAGED_OV_CONF) || existsSync(EXTERNAL_OV_CONF);
  let serverBin: string | null = null;
  try {
    const uv = await withTimeout(detectUv(), 8_000);
    serverBin = uv ? await withTimeout(resolveServerBin(uv), 8_000) : null;
  } catch { /* uv 不在/查询超时：按未装展示（一键安装会补齐运行时） */ }
  return {
    serverFound: !!serverBin,
    ...(serverBin ? { serverBin } : {}),
    confFound,
    managedRunning: isManagedRunning(),
    // 受管实例本次拉起时间（前端「运行时间」展示源；外部自管服务无从得知，不输出）
    ...(isManagedRunning() ? { managedSince: managedStartedAt() } : {}),
    // 最近一次「随 LCB 启动自动拉起记忆服务」的结果（自举失败时前端展示手动开启指引，
    // 免去用户对着「服务未运行」猜该去哪点）
    ...(getMemoryAutoStartReport() ? { autoStart: getMemoryAutoStartReport() } : {}),
  };
}

/** GET /api/memory/status 响应：服务探活 + 插件加载状态 + per-bot ns 摘要（全部只读） */
export async function memoryStatus(config: BridgeConfig): Promise<Record<string, unknown>> {
  const memory = config.memory;
  // 探活始终执行（未开启也探）：用户「配好 endpoint 还没开」时页面即能预览服务状态
  const endpoint = memory ? memoryEndpoint(memory) : DEFAULT_MEMORY_ENDPOINT;
  const health = await probeMemoryHealth(endpoint);
  // 插件检测与 executeTask 装配同口径（locateMemoryPlugin 三渠道定位；managed 副本未被引用
  // 不计入——运行时不会加载它，报了会与实际装配错位）。历史缺陷：只看 marketplace 自动发现，
  // CLI 卸载清掉登记后，config.yaml 显式引用仍在正常工作的插件被误报「未安装」
  // 客户端启用状态（插件 isPluginEnabled 口径的近似）：env 通道（memory.enabled → OPENVIKING_
  // MEMORY_ENABLED 强制启用）+ 文件通道（外部 ov.conf / LCB 骨架 / 用户手配 ovcli.conf）。
  // 历史盲区：此前只展示 LCB 侧加载渠道，「一键安装完成、状态灯全绿但 hooks 实际静默空转」
  // 不可见（插件启用判定根本不看 LCB 的身份三键 env）
  const client = classifyClientConf({ ovcli: OVCLI_CONF, ovConf: EXTERNAL_OV_CONF });
  const clientEnabled = memory?.enabled === true
    || client.state === 'external' || client.state === 'lcb-managed' || client.state === 'user-managed';
  let plugin: Record<string, unknown> = {
    found: false, name: MEMORY_PLUGIN_NAME,
    clientEnabled, clientConfState: client.state, clientConfPath: client.path,
  };
  try {
    const located = await locateMemoryPlugin(config);
    if (located) {
      plugin = {
        found: true, name: MEMORY_PLUGIN_NAME,
        ...(located.version ? { version: located.version } : {}),
        ...(located.marketplace ? { marketplace: located.marketplace } : {}),
        path: located.path,
        // 加载渠道（前端据此标注来源）：marketplace=CLI 安装启用；explicit=config.yaml 显式引用
        source: located.where,
        clientEnabled, clientConfState: client.state, clientConfPath: client.path,
      };
    }
  } catch { /* 插件发现全程容错（plugin-discovery 契约）：失败按未发现展示 */ }
  return {
    memory: memory
      ? {
        enabled: memory.enabled,
        mode: memory.mode,
        ...(memory.endpoint ? { endpoint: memory.endpoint } : { endpoint: DEFAULT_MEMORY_ENDPOINT }),
        ...(memory.version ? { version: memory.version } : {}),
        ...(memory.account ? { account: memory.account } : {}),
        ...(memory.granularity ? { granularity: memory.granularity } : {}),
        apiKey: maskSecret(memory.apiKey),
        model: memory.model
          ? {
            ...(memory.model.provider ? { provider: memory.model.provider } : {}),
            ...(memory.model.apiBase ? { apiBase: memory.model.apiBase } : {}),
            apiKey: maskSecret(memory.model.apiKey),
            ...(memory.model.vlmModel ? { vlmModel: memory.model.vlmModel } : {}),
            ...(memory.model.embeddingModel ? { embeddingModel: memory.model.embeddingModel } : {}),
            // P2 双端点拆分：向量块独立凭证的展示数据（own = 是否显式配置；未配置 = 沿用主块，
            // 前端据此显示「沿用主端点/主 Key」而非诱导重复填写；resolved = 渲染 ov.conf 的实际生效值）
            ...(memory.model.embeddingApiBase ? { embeddingApiBase: memory.model.embeddingApiBase } : {}),
            embeddingApiBaseResolved: memory.model.embeddingApiBase ?? memory.model.apiBase,
            embeddingApiKey: maskSecret(memory.model.embeddingApiKey ?? memory.model.apiKey),
            embeddingKeyOwn: !!memory.model.embeddingApiKey,
            // 意图模型块（可选）：回退口径与渲染 ov.conf 一致——端点/Key 未配置时 resolved 值 =
            // 主块现值（页面展示「已沿用主块」，模型名留空 = 未启用，上游自动回退 vlm）
            ...(memory.model.queryPlannerModel ? { queryPlannerModel: memory.model.queryPlannerModel } : {}),
            queryPlannerApiBaseResolved: memory.model.queryPlannerApiBase ?? memory.model.apiBase,
            queryPlannerApiKeyResolved: maskSecret(memory.model.queryPlannerApiKey ?? memory.model.apiKey),
            queryPlannerKeyOwn: !!memory.model.queryPlannerApiKey,
            // Rerank 块（可选）：不展示回退值（Key/端点均不回退主块），模型名空 = 未启用（纯向量召回）
            ...(memory.model.rerankModel ? { rerankModel: memory.model.rerankModel } : {}),
            ...(memory.model.rerankApiBase ? { rerankApiBase: memory.model.rerankApiBase } : {}),
            rerankApiKey: maskSecret(memory.model.rerankApiKey),
            rerankKeyOwn: !!memory.model.rerankApiKey,
          }
          : undefined,
      }
      : { enabled: false, mode: 'remote', endpoint: DEFAULT_MEMORY_ENDPOINT },
    health,
    // auth_mode 语义提示（页面直出）：dev=本机回环免鉴权（身份经 X-OpenViking-User header 隔离）；
    // api_key=user key 已由 LCB 自动签发（B1）——key 明细不出进程
    authNote: health.authMode === 'api_key'
      ? 'api_key 模式：LCB 已为每个机器人自动签发独立 user key（root key 不出本进程）'
      : health.authMode === 'dev'
        ? 'dev 模式（本机默认）：服务仅回环可达、免鉴权，机器人身份经命名空间 header 隔离'
        : undefined,
    plugin,
    // 安装摘要（页面据此渲染「一键安装 / 启动服务 / 停止」唯一主行动，消除状态与动作错位）
    install: await detectInstallSummary(),
    bots: config.apps.map((a) => ({
      name: a.name,
      appId: a.appId,
      role: a.role ?? 'primary',
      // 记忆 ns 用户轴前缀（完整 user = 前缀 + 飞书 userId，群聊按人隔离）
      userPrefix: `${a.appId}-`,
      ...(a.role === 'deputy' && a.allowedPlugins !== undefined
        ? {
          allowedPlugins: a.allowedPlugins,
          // §6.9 L1：白名单不含记忆插件时由 LCB 装配时自动注入（页面如实标注而非静默改写配置）
          memoryPluginInjected: !a.allowedPlugins.includes(MEMORY_PLUGIN_NAME),
        }
        : {}),
    })),
  };
}

/** 单项连接测试结果 */
export interface ConnCheck { ok: boolean; detail: string }

/** OpenAI 协议 embeddings 真调一次（最小输入）；2xx + data[0].embedding 非空才算绿 */
async function checkEmbedding(apiBase: string, apiKey: string | undefined, model: string): Promise<ConnCheck> {
  try {
    const res = await fetch(`${apiBase.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: 'lcb-connectivity-test' }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ embedding?: unknown }>; error?: { message?: string } };
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}${body.error?.message ? `：${body.error.message}` : ''}` };
    }
    if (!Array.isArray(body.data) || !body.data[0]?.embedding) {
      return { ok: false, detail: `响应无 embedding 数据（model=${model} 是否为向量模型？）` };
    }
    return { ok: true, detail: `向量维度 ${Array.isArray(body.data[0].embedding) ? body.data[0].embedding.length : '?'}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? (e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时（>15s）' : e.message) : String(e) };
  }
}

/** OpenAI 协议 chat/completions 真调一次（max_tokens=8）；2xx + choices[0] 才算绿 */
async function checkVlm(apiBase: string, apiKey: string | undefined, model: string): Promise<ConnCheck> {
  try {
    const res = await fetch(`${apiBase.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '连通性测试，请回复 OK' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}${body.error?.message ? `：${body.error.message}` : ''}` };
    }
    if (!Array.isArray(body.choices) || !body.choices[0]?.message) {
      return { ok: false, detail: '响应无 choices（模型名或端点路径是否正确？）' };
    }
    return { ok: true, detail: `模型已应答（${typeof body.choices[0].message.content === 'string' ? body.choices[0].message.content.slice(0, 20) : 'ok'}）` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? (e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时（>20s）' : e.message) : String(e) };
  }
}

/** Rerank 真调一次（最小 query×2 documents；OpenViking 同款请求形状：直接 POST 完整 URL，
 *  flat body {model, query, documents}）；2xx + results 非空数组才算绿。
 *  api_base 是完整请求 URL（含 /rerank 路径）——与主块 base URL 语义不同，不在这里补路径 */
async function checkRerank(apiUrl: string, apiKey: string | undefined, model: string): Promise<ConnCheck> {
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, query: '连通性测试', documents: ['文档一：连通性测试文档', '文档二：无关文档'], top_n: 2 }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { results?: unknown; error?: { message?: string } };
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}${body.error?.message ? `：${body.error.message}` : ''}` };
    }
    if (!Array.isArray(body.results) || body.results.length === 0) {
      return { ok: false, detail: '响应无 results（端点是否为完整 rerank URL？模型名是否为重排模型？）' };
    }
    return { ok: true, detail: `重排已应答（返回 ${body.results.length} 条结果）` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? (e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时（>20s）' : e.message) : String(e) };
  }
}

/**
 * POST /api/memory/test-connection：模型表单 [测试连接] 后端（§6.8 双绿门禁）。
 * body 为表单现值（不落盘）——用户可先测通再保存/开启；双绿 = embedding 与 vlm 各真调一次。
 * P2 双端点拆分：embedding 块可用独立端点/Key（embedding_api_base / embedding_api_key），
 * 表单留空分别回退主块现值——与渲染 ov.conf 的回退口径完全一致（测什么就是什么）。
 * Ollama 等零 Key 端点：api_key 可空（不带 Authorization 头）。key 只进本次请求，不落日志。
 * saved：配置中已保存的 Key——输入框脱敏不回显，表单 Key 留空时回退已保存值测试
 * （否则已配置过的用户点测试必 401）；表单填了新值则测新值（换 Key 前先验证）。
 * 向量块回退链：表单向量 Key → 已保存向量 Key → 表单主 Key → 已保存主 Key。
 * 可选块（不入门禁，只报告）：意图模型（query_planner，chat/completions 同款检查，端点/Key
 * 表单留空回退主块已保存值——与渲染 ov.conf 的回退口径一致）；rerank（三件任一填写即测，
 * 完整 URL 直 POST——留空 = 未配置报「未配置」不算失败）。主配置双绿照旧门禁。
 */
export interface MemoryConnReport {
  embedding: ConnCheck; vlm: ConnCheck;
  queryPlanner?: ConnCheck;
  rerank?: ConnCheck;
  ok: boolean;
}
export async function testMemoryConnection(body: {
  api_base?: unknown; api_key?: unknown; vlm_model?: unknown; embedding_model?: unknown;
  embedding_api_base?: unknown; embedding_api_key?: unknown;
  query_planner_model?: unknown; query_planner_api_base?: unknown; query_planner_api_key?: unknown;
  rerank_model?: unknown; rerank_api_base?: unknown; rerank_api_key?: unknown;
}, saved?: { apiKey?: string; embeddingApiKey?: string; queryPlannerApiKey?: string; rerankApiKey?: string }): Promise<MemoryConnReport> {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const apiBase = str(body.api_base);
  const apiKey = str(body.api_key) || saved?.apiKey?.trim() || undefined;
  const vlmModel = str(body.vlm_model);
  const embeddingModel = str(body.embedding_model);
  // 向量块独立值：表单填写优先，留空回退（端点回退主端点；Key 回退主 Key）——与 renderOvConf 同口径
  const embeddingApiBase = str(body.embedding_api_base) || apiBase;
  const embeddingApiKey = str(body.embedding_api_key) || saved?.embeddingApiKey?.trim() || apiKey;
  const bad = (detail: string): ConnCheck => ({ ok: false, detail });
  if (!apiBase) {
    const e = bad('api_base 未填写');
    return { embedding: e, vlm: e, ok: false };
  }
  if (!/^https?:\/\//.test(apiBase)) {
    const e = bad('api_base 必须以 http(s):// 开头');
    return { embedding: e, vlm: e, ok: false };
  }
  if (embeddingApiBase && !/^https?:\/\//.test(embeddingApiBase)) {
    const e = bad('向量端点必须以 http(s):// 开头');
    return { embedding: e, vlm: { ok: true, detail: '未检测' }, ok: false };
  }
  const embedding = embeddingModel
    ? await checkEmbedding(embeddingApiBase, embeddingApiKey, embeddingModel)
    : bad('embedding 模型未填写');
  const vlm = vlmModel
    ? await checkVlm(apiBase, apiKey, vlmModel)
    : bad('vlm 模型未填写');
  // ---- 可选块（并行真调，结果只报告不计入门禁）----
  // 意图模型：表单留空回退主块现值（与 renderOvConf 渲染回退完全一致——测的就是生效值）；
  // Key 回退链：表单 → 已保存意图 Key → 主 Key（表单 → 已保存主 Key，由 apiKey 变量承接）
  const qpModel = str(body.query_planner_model);
  const qpApiBase = str(body.query_planner_api_base) || apiBase;
  const qpApiKey = str(body.query_planner_api_key) || saved?.queryPlannerApiKey?.trim() || apiKey;
  const queryPlanner = qpModel
    ? await checkVlm(qpApiBase, qpApiKey, qpModel)
    : undefined;
  // Rerank：模型/端点/Key 任一有值即测（表单留空回退已保存值）；端点必须是完整 URL（含 /rerank）
  const rrModel = str(body.rerank_model) || '';
  const rrApiBase = str(body.rerank_api_base);
  const rrApiKey = str(body.rerank_api_key) || saved?.rerankApiKey?.trim() || undefined;
  const rerank = (rrModel || rrApiBase || rrApiKey)
    ? (!rrApiBase || !/^https?:\/\//.test(rrApiBase) || !rrModel || !rrApiKey)
      ? bad('Rerank 三件（模型 / 完整 URL 端点 / Key）需齐全才可启用——将不渲染该段')
      : await checkRerank(rrApiBase, rrApiKey, rrModel)
    : undefined;
  return {
    embedding, vlm,
    ...(queryPlanner ? { queryPlanner } : {}),
    ...(rerank ? { rerank } : {}),
    ok: embedding.ok && vlm.ok,
  };
}
