// lcb setup 引导式配置向导
// 交互层（readline 问答）与序列化层（answersToConfig / toYamlDocument）分离：
// 序列化层是纯函数，tests/cli.test.ts 直接单测；交互层留给手动冒烟
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'yaml';
import type { BridgeConfig } from '../types.js';
import { asker } from './asker.js';
import { defaultPermissionsDoc, defaultServerDoc } from '../config-defaults.js';

/** 向导收集到的原始答案（apps 支持多机器人） */
export interface SetupAnswers {
  apps: Array<{ name?: string; appId: string; appSecret: string }>;
  workspaces: Array<{ name: string; path: string; type?: 'code-dev' | 'generic' }>;
  defaultWorkspace: string;
}

/** App ID 形状（Task 6 遗留建议：不符仅警告，不阻止） */
export const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/;

/**
 * 答案 → 运行时配置对象。
 * 默认工作区名不在列表时回退到第一个工作区（防手滑回车写出非法默认值）。
 */
export function answersToConfig(a: SetupAnswers): BridgeConfig {
  const first = a.workspaces[0]?.name ?? '';
  const ws = a.defaultWorkspace || first;
  return {
    apps: a.apps.map((app) => ({
      name: app.name?.trim() || app.appId,
      appId: app.appId,
      appSecret: app.appSecret,
    })),
    workspaces: a.workspaces,
    defaults: { workspace: a.workspaces.some((w) => w.name === ws) ? ws : first },
    concurrency: 3,
  };
}

/**
 * 配置 → 可写盘的 YAML 文档。
 * ⚠️ 键名必须用 snake_case（apps[].app_id / app_secret）——loadConfig 按此形状解析，
 * 直接 stringify(camelCase 的 BridgeConfig) 会写出 loadConfig 读不回的配置。
 * permissions / server 段预置完整默认值（页面可增删），保证新用户开箱即得可调的白名单。
 */
export function toYamlDocument(cfg: BridgeConfig): Record<string, unknown> {
  return {
    apps: cfg.apps.map((app) => ({
      ...(app.name !== app.appId ? { name: app.name } : {}),
      app_id: app.appId,
      app_secret: app.appSecret,
      ...(app.domain === 'lark' ? { domain: 'lark' } : {}),
    })),
    workspaces: cfg.workspaces,
    defaults: { workspace: cfg.defaults.workspace },
    concurrency: cfg.concurrency,
    permissions: defaultPermissionsDoc(),
    server: defaultServerDoc(),
  };
}

export async function runSetup(configPath: string): Promise<void> {
  const { ask, close } = asker(process.stdin, process.stdout);
  console.log('🛠 lcb setup — 引导式配置\n');
  if (existsSync(configPath)) {
    const overwrite = await ask(`配置已存在 ${configPath}，覆盖？(y/N)`, 'n');
    if (overwrite.toLowerCase() !== 'y') {
      close();
      console.log('已取消');
      return;
    }
    // 覆盖提示：已有多个应用时明确告知（增量管理请改用 lcb app add）
    try {
      const raw = readFileSync(configPath, 'utf8');
      const count = (raw.match(/^ {2}- (?:name:|app_id:)/gm) ?? []).length || (raw.match(/^feishu:/m) ? 1 : 0);
      if (count > 1) console.log(`⚠️ 将覆盖现有配置（含 ${count} 个应用）；只想增删应用请改用 lcb app add`);
    } catch { /* 读取失败不影响覆盖流程，写盘时自然暴露 */ }
  }
  console.log('\n请先在飞书开放平台完成（详见 README）：\n'
    + '  1. 创建企业自建应用并添加机器人能力\n'
    + '  2. 开通权限 im:message / im:message:send_as_bot / im:resource / contact:user.base:readonly\n'
    + '  3. 事件订阅选「长连接」，添加 im.message.receive_v1\n'
    + '  4. 卡片交互配置选「长连接」\n');
  const apps: SetupAnswers['apps'] = [];
  for (let i = 0; ; i++) {
    const appId = await ask(i === 0
      ? '第一个应用的 App ID (cli_ 开头，形如 cli_aabbccddeeff0011)'
      : '再添一个应用的 App ID（直接回车结束添加）');
    if (!appId) {
      if (i === 0) {
        console.log('至少需要一个应用，已退出');
        close();
        return;
      }
      break;
    }
    // 空值（EOF 截断/直接回车）不警告——后续必填校验会让流程退出，此处无需噪声
    if (!APP_ID_RE.test(appId)) console.warn(`⚠️ App ID ${appId} 不符合常见形状 cli_ + 16 位十六进制，请确认（不阻止继续）`);
    const name = await ask('应用名字（显示用，如「素材收集」，回车默认取 App ID）');
    const appSecret = await ask('App Secret');
    apps.push(name ? { name, appId, appSecret } : { appId, appSecret });
  }
  const workspaces: SetupAnswers['workspaces'] = [];
  let defaultWorkspace = '';
  for (let i = 0; ; i++) {
    const name = await ask(i === 0 ? '第一个工作区名字（如 demo）' : '再添一个工作区名字（直接回车结束）');
    if (!name) break;
    const path = await ask(`工作区 ${name} 的本机路径`);
    // 类型决定开发工作流：code-dev = 统一 plan mode（先出计划→飞书批准）+ 收尾汇总 diff 卡片
    const type = await ask(`工作区 ${name} 类型（code-dev=代码开发 / generic=通用，回车默认 generic）`, 'generic');
    const normalized: 'code-dev' | 'generic' = type.trim() === 'code-dev' ? 'code-dev' : 'generic';
    workspaces.push({ name, path, ...(normalized === 'code-dev' ? { type: normalized } : {}) });
    if (!defaultWorkspace) defaultWorkspace = name;
  }
  if (workspaces.length === 0) {
    console.log('至少需要一个工作区，已退出');
    close();
    return;
  }
  const pick = await ask('默认工作区', defaultWorkspace);
  defaultWorkspace = workspaces.some((w) => w.name === pick) ? pick : defaultWorkspace;
  const cfg = answersToConfig({ apps, workspaces, defaultWorkspace });
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringify(toYamlDocument(cfg)), 'utf8');
  close();
  console.log(`\n✅ 配置已写入 ${configPath}（${apps.length} 个应用）\n下一步：lcb start 启动；lcb app add 可继续追加机器人`);
}
