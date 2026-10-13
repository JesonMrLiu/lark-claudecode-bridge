// R1/R2 路径判定：红区（读黑名单，恒定 deny）与工作区边界（写白名单）。
// 形态说明（方案 v3 §三）：
// - Read/Grep/Glob/LS/Write/Edit/NotebookEdit 是结构化路径参数，这里做的是「完备可判」的
//   路径前缀/通配校验——这是砍掉（或收紧）Bash 之后 R1/R2 能成为硬约束的前提；
// - Bash 命令串只能做「特征探测」（命令文本含红区绝对路径字面量即 deny），是文档化的
//   best-effort 而非完备判定——命令替换/编码/脚本下载执行永远可能绕过，根治靠 OS 层沙箱。
// 平台语义：Windows 文件系统大小写不敏感 → 比较统一小写 + 分隔符归一为 /；其他平台保持大小写敏感。

import { homedir, platform } from 'node:os';
import { resolve, isAbsolute } from 'node:path';

export interface PathMatcher { id: string; re: RegExp }

/**
 * 内置默认红区（R1 读黑名单，config security.redzone.read 缺省值；配置即整体替换）。
 * 口径：凭证与身份的存储位置——bridge 自身配置/会话记录、lark-cli 授权 token、SSH/GPG/AWS、
 * 浏览器资料、通用凭证文件形态。对 deputy 恒定生效；主机器人不消费（主人读本机文件属合法自用，
 * 出站脱敏兜底）。误报取向：宁可多拦（双星加 .key 一类的密钥扩展名），分身工作区如需此类文件由主人显式调整清单。
 */
export const DEFAULT_REDZONE_READ_SOURCES: readonly string[] = [
  '~/.lark-claudecode-bridge/**',   // bridge config.yaml（app_secret）/ transcripts / plans；inbox 子目录被 R1 豁免（入站附件，见 GateSecurity.inboxRoot）
  '~/.lark-cli/**',                 // lark-cli 用户授权 token（R4 私人面互锁项）
  '~/.claude/**',                   // CLI 登录态 / OAuth / 本机 settings
  '~/.codex/**',
  '~/.ssh/**',
  '~/.aws/**',
  '~/.gnupg/**',
  '~/.netrc',
  '~/.git-credentials',
  '~/AppData/Local/Google/**',      // 浏览器资料（Cookies / Login Data）
  '~/AppData/Roaming/Google/**',
  '~/Library/Application Support/Google/Chrome/**',
  '~/.config/google-chrome/**',
  '**/credentials*',
  '**/id_rsa*',
  '**/secrets.*',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.enc',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
];

const CASE_INSENSITIVE = platform() === 'win32';

/** `~` 展开 + 绝对化 + 分隔符归一（/）+（Windows）小写。所有比较都走这一条漏斗 */
export function normalizeForCompare(p: string, cwd: string = process.cwd()): string {
  let abs = p.trim();
  if (abs === '~') abs = homedir();
  else if (abs.startsWith('~/') || abs.startsWith('~\\')) abs = joinHome(abs.slice(2));
  if (!isAbsolute(abs)) abs = resolve(cwd, abs);
  const norm = resolve(abs).replace(/\\/g, '/');
  return CASE_INSENSITIVE ? norm.toLowerCase() : norm;
}

function joinHome(rest: string): string {
  // path.join 在 Windows 接受 / 混排，这里统一用 resolve 兜住 `~\x` 与 `~/x`
  return resolve(homedir(), rest);
}

/**
 * 编译红区 glob 模式（config security.redzone.read）。支持：
 * - `~/` 前缀展开为用户主目录
 * - 双星加斜杠（`**` 后跟 `/`）匹配任意层级目录（含零层）；`*` 单段内通配
 * - 无通配模式按「目录前缀」语义：命中该路径本身与其下全部内容
 * 非法/空条目跳过（配置页自由文本，坏条目 warn 不拖垮启动）。
 */
export function compilePathPatterns(sources: readonly string[]): PathMatcher[] {
  const out: PathMatcher[] = [];
  for (const [i, raw] of sources.entries()) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      out.push({ id: raw, re: compileOne(raw) });
    } catch (e) {
      console.warn(`[security] 红区模式 #${i + 1} 编译失败已忽略（${raw}）：`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

function compileOne(raw: string): RegExp {
  let p = raw.trim().replace(/\\/g, '/');
  // 尾部 /** ：目录前缀语义（命中目录本身 + 其下全部内容），先摘掉再按无通配收尾
  const dirPrefix = p.endsWith('/**') || p === '~' || !p.endsWith('*');
  if (p.endsWith('/**')) p = p.slice(0, -3);
  // ~ 展开（含 ~\ 与裸 ~）
  if (p === '~') p = normalizeForCompare('~');
  else if (p.startsWith('~/')) p = normalizeForCompare(p);
  else if (!p.startsWith('/') && !/^[a-zA-Z]:\//.test(p) && !p.startsWith('**/')) {
    // 相对模式：按「任意层级下匹配」语义处理（如 credentials* → **/credentials*）
    p = `**/${p}`;
  }
  let re = '';
  // 是否以段内通配收尾（收尾通配 = 精确深度语义，不得追加目录前缀后缀）
  let trailingWildcard = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // `**/`：零或多层目录；`**` 其余形态按同义处理
        if (p[i + 2] === '/') { re += '(?:[^/]+/)*'; trailingWildcard = true; i += 2; }
        else { re += '.*'; trailingWildcard = true; i++; }
      } else {
        re += '[^/]*';
        trailingWildcard = true;
      }
      continue;
    }
    re += /[.+^${}()|[\]\\?]/.test(ch) ? `\\${ch}` : ch;
    trailingWildcard = false;
  }
  // 目录前缀语义（尾部 /**、裸 ~、无任何通配）：同时命中路径本身与其下全部内容；
  // 以段内通配收尾的（dir/*、**/credentials*）保持精确深度，不追加
  if (dirPrefix && !trailingWildcard) re += '(?:/.*)?';
  return new RegExp(`^${re}$`, CASE_INSENSITIVE ? 'i' : '');
}

/** 路径命中红区则返回命中的模式（审计/日志用），未命中返回 null */
export function matchRedzone(p: string, matchers: readonly PathMatcher[], cwd: string = process.cwd()): string | null {
  if (!p) return null;
  const norm = normalizeForCompare(p, cwd);
  for (const m of matchers) {
    if (m.re.test(norm)) return m.id;
    m.re.lastIndex = 0;
  }
  return null;
}

/** 路径是否落在任一允许根之下（分隔符边界对齐，防 /ws-a 前缀误配 /ws-ab） */
export function isUnderAnyRoot(p: string, roots: readonly string[], cwd: string = process.cwd()): boolean {
  if (!p) return false;
  const norm = normalizeForCompare(p, cwd);
  return roots.some((r) => {
    const root = normalizeForCompare(r, cwd);
    return norm === root || norm.startsWith(root.endsWith('/') ? root : `${root}/`);
  });
}

/** canUseTool 各文件工具的路径参数抽取（Grep/Glob/LS 的 path 可缺省 → 缺省即任务 cwd，由调用方补齐） */
const TOOL_PATH_FIELDS: Record<string, readonly string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['path'],
  Glob: ['path'],
  LS: ['path'],
};

/** 抽取工具入参中的候选路径（未声明路径参数的工具返回空数组） */
export function extractToolPaths(toolName: string, input: Record<string, unknown>): string[] {
  const fields = TOOL_PATH_FIELDS[toolName];
  if (!fields) return [];
  const out: string[] = [];
  for (const f of fields) {
    const v = input[f];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out;
}

/** 写红线约束的写工具集合（Edit/Write/NotebookEdit 之外无落盘写语义） */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Bash 命令串红区特征探测（best-effort，见文件头说明）：
 * - 把命令文本中的 `~/` 引用展开后，检查是否包含任一红区模式的「字面前缀」（模式首个通配符之前
 *   的字面部分，如 `~/.ssh/**` → `<home>/.ssh/`）；
 * - 纯通配开头（如双星开头再接 credentials）无稳定字面前缀，跳过——此类交给出站脱敏兜底。
 * inboxRoot（入站附件豁免根）传入时：命中字面前缀后须命令串中该前缀的每一处出现都指向 inbox
 * 根内才豁免该模式，任一处不指向仍命中——fail-closed，不扩大既有绕过面。
 * 命中返回模式串，未命中返回 null。
 */
export function bashHitsRedzone(
  command: string,
  matchers: readonly PathMatcher[],
  inboxRoot?: string,
): string | null {
  if (!command) return null;
  const expanded = command.replace(/(^|[\s"'=;(])~([/\\])/g, (_m, pre: string, sep: string) => `${pre}${homedir()}${sep}`);
  const norm = normalizeForCompare(expanded);
  const inboxNorm = inboxRoot ? normalizeForCompare(inboxRoot) : '';
  for (const m of matchers) {
    const literal = literalPrefix(m.id);
    if (!literal || !norm.includes(literal)) continue;
    if (inboxNorm && allOccurrencesUnderInbox(norm, literal, inboxNorm)) continue; // 全部指向 inbox → 豁免该模式
    return m.id;
  }
  return null;
}

/** Bash token 断字字符集（豁免的 fail-closed 边界）：inbox 根之后紧跟这些字符视为引用结束；
 *  其余字符（含 : = * ? $ 等 shell 合法文件名成分）一律视为路径成分 → 不豁免回退 deny */
const BASH_TOKEN_BREAK = new Set([' ', '\t', '\n', '\r', '"', "'", '`', ';', '&', '|', '<', '>', '(', ')', ',']);

/** literal 在 norm 中的每一处出现是否都指向 inbox 根内（含根本身）：
 *  - 出现处须完整匹配 inboxNorm 前缀（~/.ssh/inbox 一类「第一段恰好叫 inbox」的无关模式引用不会误豁免）；
 *  - inboxNorm 之后须为 /（子路径）、串尾（根本身）或断字符；inbox2 / inbox:x 等视为不同路径 → false。
 *  已知边界（与文件头 best-effort 口径一致）：`inbox/../config.yaml` 回溯、命令替换编码不在字面探测
 *  能力内（R1 结构化路径侧因 normalizeForCompare 走 resolve 折叠 .. 无此问题），根治靠 OS 层沙箱 */
function allOccurrencesUnderInbox(norm: string, literal: string, inboxNorm: string): boolean {
  for (let i = norm.indexOf(literal); i !== -1; i = norm.indexOf(literal, i + literal.length)) {
    if (!norm.startsWith(inboxNorm, i)) return false;
    const c = norm[i + inboxNorm.length];
    if (c !== undefined && c !== '/' && !BASH_TOKEN_BREAK.has(c)) return false;
  }
  return true;
}

/** 模式串首个通配符前的字面前缀（归一化；无有效字面前缀返回 ''） */
function literalPrefix(pattern: string): string {
  const cut = pattern.replace(/\\/g, '/').split('*')[0]!.replace(/[?]+$/, '');
  if (!cut || cut === '/' || cut.endsWith(':')) return '';
  return normalizeForCompare(cut.endsWith('/') ? cut : `${cut}/`);
}

// 模块级编译缓存：红区模式源串 → 编译产物（模式列表小且变更低频，键取序列化串）
const matcherCache = new Map<string, PathMatcher[]>();

/** 带缓存的红区编译：同一份模式串（JSON 键）只编译一次，decide 热路径零重复开销 */
export function cachedPathMatchers(sources: readonly string[]): PathMatcher[] {
  const key = JSON.stringify(sources);
  let m = matcherCache.get(key);
  if (!m) {
    m = compilePathPatterns(sources);
    if (matcherCache.size > 32) matcherCache.clear(); // 防热重载频繁变更导致的无界增长
    matcherCache.set(key, m);
  }
  return m;
}
