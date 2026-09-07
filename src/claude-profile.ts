// 厂商档案切换内核：配置页「设为当前」按钮（web/server.ts 的 /api/claude/use-profile）与
// 飞书端 /model-profile 命令共用的落盘逻辑。放在 web 层之外，避免 session → web 反向依赖。
// 语义（cc-switch 同款）：档案仅是配置库，切换 = 把档案的凭证/base_url/模型整体拷贝到
// claude 段顶层四字段（互斥凭证同步清理），mode 与 profiles 原样保留；managed 模式下
// 立即重写托管目录 settings.json → 后续任务即生效，inherit 模式只更新顶层值暂不生效。
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { loadConfig, parseConfigText } from './config.js';
import { initManagedClaudeDir } from './claude-config.js';
import type { BridgeConfig, ClaudeConfig, ClaudeProfile } from './types.js';

export type SwitchProfileResult =
  | { ok: true; message: string; name: string; effectiveModel?: string }
  | { ok: false; status: 400 | 404 | 500; error: string };

/** 顶层四字段整体替换（纯函数，单测友好）：档案未配置的字段从顶层清除，保证切换干净 */
export function applyProfileToClaudeDoc(
  oldClaude: Record<string, unknown>,
  prof: ClaudeProfile,
  effModel?: string,
): Record<string, unknown> {
  const newClaude: Record<string, unknown> = { ...oldClaude };
  if (prof.authToken) { newClaude.auth_token = prof.authToken; delete newClaude.api_key; }
  else if (prof.apiKey) { newClaude.api_key = prof.apiKey; delete newClaude.auth_token; }
  else { delete newClaude.auth_token; delete newClaude.api_key; }
  if (prof.baseUrl) newClaude.base_url = prof.baseUrl; else delete newClaude.base_url;
  if (effModel) newClaude.model = effModel; else delete newClaude.model;
  return newClaude;
}

/** 档案是否为当前生效（进程内有凭证明文，可精确比较；web 前端脱敏模型才用尾 4 位近似） */
export function isProfileActive(claude: ClaudeConfig | undefined, p: ClaudeProfile): boolean {
  if (!claude) return false;
  const tokenMatch = p.authToken ? claude.authToken === p.authToken
    : p.apiKey ? claude.apiKey === p.apiKey
    : !claude.authToken && !claude.apiKey;
  return tokenMatch && (p.baseUrl ?? undefined) === claude.baseUrl;
}

/** 原子写（tmp + rename）：与 web/server.ts 的 writeAtomic 同款实现，独立内联避免反向依赖 */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/**
 * 切换当前生效档案：校验 → 保注释改写 claude 段顶层四字段 → 内存校验 → 原子写盘 →
 * managed 模式立即同步托管 settings.json。configPath 可注入（测试），缺省用 CONFIG_PATH。
 */
export function switchProfile(
  configPath: string,
  name: string,
  modelOverride?: string,
): SwitchProfileResult {
  let config: BridgeConfig;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    return { ok: false, status: 500, error: `配置加载失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const prof = config.claude?.profiles?.find((p) => p.name === name);
  if (!prof) {
    return { ok: false, status: 404, error: `档案 "${name}" 不存在（新增/修改档案后须先保存再切换）` };
  }
  // 可选 model 覆盖（档案候选模型点选切换）：须属于该档案 models 候选集或其默认模型，防手滑串档案
  const model = modelOverride?.trim();
  if (model) {
    const candidates = new Set([...(prof.models ?? []), ...(prof.model ? [prof.model] : [])]);
    if (!candidates.has(model)) {
      return {
        ok: false, status: 400,
        error: `模型 "${model}" 不在档案 "${name}" 的候选模型中（${[...candidates].join('、') || '空'}）`,
      };
    }
  }
  const effModel = model || prof.model;
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  const oldJs = doc.toJS() as Record<string, unknown>;
  const oldClaude = (oldJs.claude && typeof oldJs.claude === 'object' && !Array.isArray(oldJs.claude) ? oldJs.claude : {}) as Record<string, unknown>;
  doc.set('claude', applyProfileToClaudeDoc(oldClaude, prof, effModel));
  const text = doc.toString();
  let after: BridgeConfig;
  try {
    after = parseConfigText(text, configPath);
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
  }
  writeAtomic(configPath, text);
  // managed 模式即时重写托管 settings.json（后续任务即生效）；inherit 由提示说明
  if (after.claude?.mode === 'managed') initManagedClaudeDir(after);
  return {
    ok: true,
    name,
    ...(effModel ? { effectiveModel: effModel } : {}),
    message: `已切换到档案「${name}」${effModel ? `（模型 ${effModel}）` : ''}${after.claude?.mode === 'managed' ? '，managed 模式下对后续任务即生效' : '，当前 inherit 模式：顶层值已更新，切到 managed 后生效'}`,
  };
}
