// R3 出站脱敏引擎：所有离开 bridge 进程的文本（卡片/流式块/最终回复/caption）必经的
// 最后保险丝。定位与边界（方案 v3 §一）：
// - 兜得住「意外」：模型无意识复述凭证形字符串（key/token/PEM/JWT/长 hex）；
// - 兜不住「恶意」：被注入后刻意转述/编码/拆分——恶意的解在 R1（读不到）与 R4（工具不存在），
//   本模块是保险丝 + 审计采样点，不是安全保证本身。
// 金丝雀（canary）：主人在敏感路径附近埋的假密钥标记；一旦出现在任何出站文本 = 防线被穿透，
// 除脱敏外必须触发告警（调用方据 canary 标志处置）。
// ReDoS 对策：内置规则均为线性形态（无嵌套量词）；用户自定义正则限制条数与长度、预编译校验，
// 且逐规则计时超预算即放弃该规则（宁可漏一条自定义规则，不让 bridge 挂死）。

/** 单条脱敏规则（预编译） */
export interface RedactRule { id: string; re: RegExp }

/** 脱敏结果：脱敏后文本 + 命中规则 id 列表 + 是否命中金丝雀 */
export interface RedactResult { text: string; hits: string[]; canary: boolean }

/** 内置规则源（调试用可读形态；运行期统一 gi/less 编译） */
export const DEFAULT_REDACT_RULE_SOURCES: ReadonlyArray<{ id: string; source: string; flags: string }> = [
  // JWT（三段 base64url）
  { id: 'jwt', source: 'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', flags: 'g' },
  // Authorization: Bearer xxx / authorization: xxx
  { id: 'bearer', source: 'Authorization["\']?\\s*[:=]\\s*["\']?Bearer\\s+[A-Za-z0-9._~+/=-]{8,}', flags: 'gi' },
  // API key：sk- / sk-ant- / sk-cp- 等前缀（连字符在字符类内，覆盖全部变体）
  { id: 'api-key', source: '\\bsk-[A-Za-z0-9_-]{16,}\\b', flags: 'g' },
  // PEM 私钥块（全文量词封顶，防退化）
  { id: 'pem-key', source: '-----BEGIN[ A-Z]*PRIVATE KEY-----[\\s\\S]{0,4000}?-----END[ A-Z]*PRIVATE KEY-----', flags: 'g' },
  // 键值对形态：password=xxx / "api_key": "xxx" —— 只打码值，保留键名（上下文可读）
  {
    id: 'secret-kv',
    source: '\\b(password|passwd|pwd|secret|app_secret|appsecret|api_key|apikey|access_key|access_token|refresh_token|auth_token|client_secret|private_key|token)\\b["\']?\\s*[:=]\\s*["\']?([^\\s"\']{4,})',
    flags: 'gi',
  },
  // URL 内嵌凭证：https://user:pass@host
  { id: 'url-cred', source: '\\bhttps?://[^\\s/@:]+:[^\\s/@]{4,}@', flags: 'g' },
  // ≥32 位连续 hex（密钥/摘要常见形态；git SHA/UUID 会被误伤——已知误报，换取覆盖面）
  { id: 'hex-32', source: '\\b[a-f0-9]{32,}\\b', flags: 'gi' },
];

/** 默认金丝雀标记：命中即视为「防线被穿透」的证据 */
export const DEFAULT_CANARY_PATTERNS: readonly string[] = ['sk-canary-', 'lcb-canary-', 'CANARY-SECRET-'];

/** 命中后的统一掩码（完整丢弃，不保留前后缀——前缀本身也可能是敏感信息的一部分） */
export const REDACT_MASK = '******';

// 自定义规则护栏：条数/长度上限 + 单规则扫描时间预算（毫秒）
const MAX_CUSTOM_RULES = 20;
const MAX_CUSTOM_PATTERN_LENGTH = 200;
const RULE_TIME_BUDGET_MS = 250;

/** 编译内置规则（模块级单例：正则编译一次复用） */
const BUILTIN_RULES: readonly RedactRule[] = DEFAULT_REDACT_RULE_SOURCES.map(
  ({ id, source, flags }) => ({ id, re: new RegExp(source, flags) }),
);

/**
 * 编译用户自定义规则（config security.redact_patterns）：
 * 非法正则跳过并 warn（配置页能保存的自由文本，不能让一条坏正则拖垮出站链路）。
 */
export function compileCustomRules(sources?: string[]): RedactRule[] {
  if (!sources?.length) return [];
  const out: RedactRule[] = [];
  for (const [i, raw] of sources.entries()) {
    if (out.length >= MAX_CUSTOM_RULES) break;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    if (raw.length > MAX_CUSTOM_PATTERN_LENGTH) {
      console.warn(`[security] 自定义脱敏正则 #${i + 1} 超过 ${MAX_CUSTOM_PATTERN_LENGTH} 字符，已忽略`);
      continue;
    }
    try {
      out.push({ id: `custom-${i + 1}`, re: new RegExp(raw, 'g') });
    } catch (e) {
      console.warn(`[security] 自定义脱敏正则 #${i + 1} 编译失败已忽略（${raw.slice(0, 40)}…）：`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/**
 * 对单段文本执行脱敏。规则依次扫描，命中区间统一替换为 REDACT_MASK（完整丢弃）；
 * 逐规则计时，超预算放弃该规则剩余扫描（防用户正则灾难性回溯挂死出站链路）。
 */
export function redactText(text: string, rules: readonly RedactRule[] = [], canaryPatterns: readonly string[] = DEFAULT_CANARY_PATTERNS): RedactResult {
  // 金丝雀先于脱敏检测：标记本身长得像密钥，脱敏后再查就永远查不到了
  const lowered = text.toLowerCase();
  const canary = (canaryPatterns ?? []).some((p) => p && lowered.includes(p.toLowerCase()));
  const hits: string[] = [];
  let out = text;
  for (const rule of [...BUILTIN_RULES, ...rules]) {
    const t0 = Date.now();
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string;
      if (Date.now() - t0 > RULE_TIME_BUDGET_MS) return match; // 超预算：本条不再打码（保命优先）
      hits.push(rule.id);
      // secret-kv 规则保留键名只打码值：第二捕获组 = 值本身（键保留，上下文可读）
      if (rule.id === 'secret-kv') {
        const value = args[2];
        if (typeof value === 'string' && value.length > 0) {
          return `${match.slice(0, match.length - value.length)}${REDACT_MASK}`;
        }
      }
      return REDACT_MASK;
    });
    rule.re.lastIndex = 0; // g 标记正则跨调用复用时必须复位（字符串 replace 内部虽会管，防御性复位）
  }
  return { text: out, hits, canary };
}

/**
 * 递归脱敏任意 JSON 结构（卡片对象/数组/字符串）：只改写字符串叶子，结构保持不变。
 * 用于网关出口的深度兜底——进度卡流式正文、diff 卡片、结果卡、notify 文本全部经此。
 */
export function redactDeep<T>(value: T, rules: readonly RedactRule[] = [], canaryPatterns: readonly string[] = DEFAULT_CANARY_PATTERNS): { value: T; hits: string[]; canary: boolean } {
  const hits: string[] = [];
  let canary = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactText(v, rules, canaryPatterns);
      if (r.hits.length) hits.push(...r.hits);
      if (r.canary) canary = true;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, hits, canary };
}

/** 脱敏器门面：内置 + 自定义规则编译产物，供网关 / wiring 复用 */
export class Redactor {
  constructor(private rules: RedactRule[], private canaryPatterns: readonly string[]) {}
  text(text: string): RedactResult { return redactText(text, this.rules, this.canaryPatterns); }
  deep<T>(value: T): { value: T; hits: string[]; canary: boolean } { return redactDeep(value, this.rules, this.canaryPatterns); }
}

/** Redactor 配置源（config security 段的相关字段） */
export interface RedactorConfig { redactPatterns?: string[]; canaryPatterns?: string[] }

// 配置键 → 编译产物 memo：热重载 mutate config.security 后键变化即自动重编译，
// 未变化时零开销复用（出站链路每张卡都要走，编译不能反复发生）
const redactorCache = new Map<string, Redactor>();

/** 按配置取脱敏器（模块级 memo，同一份配置只编译一次） */
export function getRedactor(cfg?: RedactorConfig): Redactor {
  const key = JSON.stringify({ r: cfg?.redactPatterns ?? [], c: cfg?.canaryPatterns ?? [] });
  let r = redactorCache.get(key);
  if (!r) {
    r = new Redactor(compileCustomRules(cfg?.redactPatterns), cfg?.canaryPatterns ?? DEFAULT_CANARY_PATTERNS);
    if (redactorCache.size > 16) redactorCache.clear();
    redactorCache.set(key, r);
  }
  return r;
}
