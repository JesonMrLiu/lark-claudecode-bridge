// 机器人级厂商档案（apps[].profile / profile_model）的运行期解析与 per-bot settings 文件生成。
//
// 为什么认证不走 taskEnv 注入：生效目录 settings.json 的 env 块优先于子进程 env（CLI 官方
// 优先级，Step 0 实测 R1 证实）——bot 档案的 ANTHROPIC_* 若走 buildTaskEnv 会被托管/本机
// settings 的同名键压制。改走 CLI `--settings <file>`（命令行层，优先级最高，Step 0 实测
// R2 证实压制 user settings env）：本模块按档案惰性生成仅含认证键的 settings 文件，
// executor 经 SDK options.extraArgs 注入。模型不走此通道（防两套真相）：经 executor
// opts.model（--model 参数，同为命令行层）路由。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';
import type { BridgeConfig, ClaudeProfile, FeishuAppConfig } from './types.js';

/** app.profile → 档案对象；未配置或档案不存在返回 undefined（调用方 warn 回退全局，不 fail） */
export function resolveAppProfile(config: BridgeConfig, app: FeishuAppConfig): ClaudeProfile | undefined {
  if (!app.profile) return undefined;
  return config.claude?.profiles?.find((p) => p.name === app.profile);
}

/**
 * bot 生效模型：profileModel（须在档案候选集内，否则 warn 忽略防串档案）> 档案默认 model >
 * undefined（跟随全局）。候选集口径与 claude-profile.ts switchProfile 一致：models + 档案默认 model
 */
export function resolveAppProfileModel(config: BridgeConfig, app: FeishuAppConfig): string | undefined {
  const prof = resolveAppProfile(config, app);
  if (!prof) return undefined;
  const override = app.profileModel?.trim();
  if (override) {
    const candidates = new Set([...(prof.models ?? []), ...(prof.model ? [prof.model] : [])]);
    if (candidates.has(override)) return override;
    console.warn(
      `[app-profile] 机器人 ${app.name || app.appId} 的 profile_model "${override}" 不在档案 "${prof.name}" 候选模型中，已忽略（回退档案默认模型）`,
    );
  }
  return prof.model;
}

/** 档案名 → 安全文件名片段：Windows 保留字符替换 + md5 短后缀防 sanitized 碰撞 */
function profileFileStem(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'profile';
  return `${safe}-${createHash('md5').update(name).digest('hex').slice(0, 8)}`;
}

/**
 * 生成 per-bot 档案 settings 文件（内容仅认证键），返回绝对路径。
 * - 互斥凭证镜像 applyProfileToClaudeDoc 语义：档案用 authToken 时显式置 ANTHROPIC_API_KEY=""
 *   （反之亦然）——命令行层 env 压制生效目录 env，空串把生效目录可能残留的另一键对冲为未设，
 *   防双键并存（CLI 对 AUTH_TOKEN/API_KEY 并存的取舍未定义，显式清空最稳）
 * - baseUrl 未配置（官方 API）不写键：bot 档案留空 = 沿用生效目录值（不主动清除全局配的端点
 *   属保守语义；需要纯官方端点的档案请在档案里显式配官方地址）
 * - 内容未变不写盘：与磁盘现值比较（跨进程重启也不无谓重写，遵循 managed 热重载先比较再写的惯例）
 */
export function ensureProfileSettingsFile(prof: ClaudeProfile, baseDir: string = CONFIG_DIR): string {
  const dir = join(baseDir, 'claude-apps');
  mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {};
  if (prof.authToken) {
    env.ANTHROPIC_AUTH_TOKEN = prof.authToken;
    env.ANTHROPIC_API_KEY = '';
  } else if (prof.apiKey) {
    env.ANTHROPIC_API_KEY = prof.apiKey;
    env.ANTHROPIC_AUTH_TOKEN = '';
  }
  if (prof.baseUrl) env.ANTHROPIC_BASE_URL = prof.baseUrl;
  const path = join(dir, `${profileFileStem(prof.name)}.settings.json`);
  const text = JSON.stringify({ env }, null, 2) + '\n';
  let prev = '';
  try {
    prev = readFileSync(path, 'utf8');
  } catch { /* 首次生成：无旧文件 */ }
  if (prev !== text) writeFileSync(path, text, 'utf8');
  return path;
}
