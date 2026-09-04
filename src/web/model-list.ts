// 模型列表拉取（Web 配置页「拉取模型」按钮）。厂商无关：模型可能来自 Anthropic 官方、
// OpenAI 风格中转站或任意兼容网关，故 URL 拼接兼容带/不带 /v1 的 base、认证头双发、
// 响应形状宽容解析。纯函数与 fetch 分离（fetchFn 可注入，测试免网络）。

export type ModelCredType = 'auth_token' | 'api_key';

export interface ModelFetchParams {
  baseUrl: string;
  credType: ModelCredType;
  credential: string;
}

export const DEFAULT_MODEL_BASE = 'https://api.anthropic.com';

/** body 明文凭证优先；空/缺省回落磁盘 claude 段（带 profile_name 时回落该档案）；两处皆无 → error（联合类型便于路由层直接 400） */
export function resolveModelFetchParams(
  body: { base_url?: unknown; auth_token?: unknown; api_key?: unknown; profile_name?: unknown },
  disk: {
    baseUrl?: string; authToken?: string; apiKey?: string;
    profiles?: Array<{ name: string; authToken?: string; apiKey?: string; baseUrl?: string }>;
  } | undefined,
): ModelFetchParams | { error: string } {
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  // 档案编辑抽屉场景：body.profile_name 指定档案，磁盘回落取该档案（而非顶层）的凭证与 base_url
  const pname = pick(body.profile_name);
  const prof = pname ? disk?.profiles?.find((p) => p.name === pname) : undefined;
  let baseUrl = pick(body.base_url);
  if (!baseUrl) baseUrl = (pname ? prof?.baseUrl : undefined) ?? disk?.baseUrl ?? DEFAULT_MODEL_BASE;
  const bToken = pick(body.auth_token);
  const bKey = pick(body.api_key);
  // pname 命中档案时严格用档案凭证（档案选了哪种类型就按哪种，顶层不混入）；否则回落顶层
  const dToken = (pname && prof ? prof.authToken : disk?.authToken)?.trim() || undefined;
  const dKey = (pname && prof ? prof.apiKey : disk?.apiKey)?.trim() || undefined;
  // 优先级：body 明文（用户刚输入、尚未保存，按其选择的类型）> 磁盘（档案/顶层，token 型先于 key 型）
  if (bToken) return { baseUrl, credType: 'auth_token', credential: bToken };
  if (bKey) return { baseUrl, credType: 'api_key', credential: bKey };
  if (dToken) return { baseUrl, credType: 'auth_token', credential: dToken };
  if (dKey) return { baseUrl, credType: 'api_key', credential: dKey };
  return {
    error: '未找到可用凭证：请在表单填入 Auth Token / API Key 后重试（无须先保存），或保存 managed 模式凭证。'
      + 'inherit 模式使用本机 ~/.claude 登录，页面无法代取其凭证。',
  };
}

/** GET 模型列表的 URL+请求头：双发认证头（OpenAI 风格认 Bearer、Anthropic 风格认 x-api-key），
 *  anthropic-version 对非 Anthropic 网关是未知头、按惯例忽略，无害 */
export function buildModelListRequest(p: ModelFetchParams): { url: string; headers: Record<string, string> } {
  const base = p.baseUrl.replace(/\/+$/, ''); // 剥尾部斜杠
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  return {
    url,
    headers: {
      Accept: 'application/json',
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${p.credential}`,
      'x-api-key': p.credential,
    },
  };
}

/** 宽容解析多形状模型列表：{data:[{id}]}（OpenAI/Anthropic 通用）/ {data:["id"]} / {models:[...]} / {result:[...]} */
export function parseModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('无法识别的响应格式（期望 JSON 对象含 data/models 数组）');
  }
  const candidates = (payload as Record<string, unknown>).data
    ?? (payload as Record<string, unknown>).models
    ?? (payload as Record<string, unknown>).result;
  if (!Array.isArray(candidates)) {
    throw new Error('无法识别的响应格式（期望 data/models 数组）');
  }
  const ids = new Set<string>();
  for (const item of candidates) {
    const id = typeof item === 'string' ? item
      : (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string')
        ? (item as Record<string, string>).id
        : undefined;
    if (id?.trim()) ids.add(id.trim());
  }
  return [...ids].sort();
}

/** 实际拉取：全局 fetch（Node≥20 自带），AbortController 超时；非 2xx 抛带状态码+截断 body 的 Error */
export async function fetchModelList(
  p: ModelFetchParams,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<string[]> {
  const { url, headers } = buildModelListRequest(p);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'GET', headers, signal: controller.signal });
  } catch (e) {
    throw new Error(`模型列表请求失败：${e instanceof Error ? e.message : String(e)}（请检查 BASE_URL 可达性；也可直接手动填写模型名）`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`模型列表拉取失败：HTTP ${res.status} ${text.slice(0, 200)}（也可直接手动填写模型名）`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON（前 200 字符：${text.slice(0, 200) || '(空)'}）；也可直接手动填写模型名`);
  }
  const models = parseModelList(payload);
  if (!models.length) throw new Error('响应中没有模型条目；也可直接手动填写模型名');
  return models;
}
