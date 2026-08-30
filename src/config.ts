import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, type YAMLParseError } from 'yaml';
import type { BridgeConfig, FeishuAppConfig, PluginRef, TriggerRule } from './types.js';

/** LCB_CONFIG_DIR 环境变量可覆盖配置根目录（多租户分进程场景用；正常用户无须设置） */
export const CONFIG_DIR = join(process.env.LCB_CONFIG_DIR ?? homedir(), '.lark-claudecode-bridge');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

/** config.yaml 中单个 app 的原始形状（snake_case） */
interface RawApp {
  name?: string;
  app_id?: string;
  app_secret?: string;
  domain?: string;
  default_workspace?: string;
  concurrency?: unknown;
  append_system_prompt?: string;
  claude_config_dir?: string;
  env?: Record<string, string>;
  triggers?: Array<{ match?: string; rewrite?: string }>;
  plugins?: Array<{ name?: string; path?: string }>;
}

/** 触发词规则校验：match/rewrite 必须非空（错误消息带定位），顺序保持（按序首个命中生效） */
function normalizeTriggers(raw: RawApp['triggers'], where: string): TriggerRule[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${where} 的 triggers 必须为数组`);
  return raw.map((t, j): TriggerRule => {
    const match = typeof t?.match === 'string' ? t.match.trim() : '';
    const rewrite = typeof t?.rewrite === 'string' ? t.rewrite.trim() : '';
    if (!match) throw new Error(`${where} 的 triggers[${j}].match 不能为空`);
    if (!rewrite) throw new Error(`${where} 的 triggers[${j}].rewrite 不能为空`);
    // 无占位符合法但通常系笔误：用户输入会整个丢弃，warn 提示
    if (!rewrite.includes('{text}') && !rewrite.includes('{args}')) {
      console.warn(`[配置] ${where} 的 triggers[${j}].rewrite 不含 {text} / {args} 占位符，用户输入将不会传入（若非有意请修正）`);
    }
    return { match, rewrite };
  });
}

/** 插件引用校验：name/path 必须非空；路径不存在仅 warn（运行期外部目录可能挂载较晚，硬抛会阻断整个桥启动） */
function normalizePlugins(raw: RawApp['plugins'], where: string): PluginRef[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${where} 的 plugins 必须为数组`);
  return raw.map((p, j): PluginRef => {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    const path = typeof p?.path === 'string' ? p.path.trim() : '';
    if (!name) throw new Error(`${where} 的 plugins[${j}].name 不能为空`);
    if (!path) throw new Error(`${where} 的 plugins[${j}].path 不能为空`);
    if (!existsSync(path)) {
      console.warn(`[配置] ${where} 的 plugins[${j}](${name}) 路径当前不存在：${path}（若启动时仍缺失，将由 Claude Code 会话侧报错）`);
    }
    return { name, path };
  });
}

/**
 * 归一化应用列表：doc.apps 数组优先（并存旧 feishu 时 warn 忽略）；
 * 无 apps 有 feishu → 归一化为单元素数组（只在内存归一，不回写文件，保住用户手写注释）。
 * 每项逐字段校验，错误消息带 apps[i](name) 定位；appId 重复抛错（同一应用建两条长连接是配置错误）。
 */
function normalizeApps(doc: Record<string, unknown>, workspaceNames: string[]): FeishuAppConfig[] {
  const rawApps: RawApp[] = [];
  const isLegacy = !Array.isArray(doc.apps);
  if (!isLegacy) {
    rawApps.push(...(doc.apps as RawApp[]));
    if (doc.feishu != null) console.warn('[配置] 检测到 apps 与旧 feishu 并存，已忽略 feishu（apps 优先）');
  } else if (doc.feishu != null && typeof doc.feishu === 'object') {
    rawApps.push(doc.feishu as RawApp);
  }
  if (rawApps.length === 0) throw new Error('配置缺少 apps（或旧版 feishu）应用凭证，请先运行 lcb setup');

  const seenAppIds = new Set<string>();
  const apps = rawApps.map((raw, i): FeishuAppConfig => {
    const appId = typeof raw.app_id === 'string' ? raw.app_id.trim() : '';
    const name = (typeof raw.name === 'string' && raw.name.trim()) || appId;
    const where = `apps[${i}]${name ? `(${name})` : ''}`;
    if (!appId) throw new Error(`${where} 缺少 app_id，请检查 config.yaml`);
    if (!raw.app_secret) throw new Error(`${where} 缺少 app_secret，请检查 config.yaml`);
    if (seenAppIds.has(appId)) {
      throw new Error(`${where} 的 app_id "${appId}" 重复：同一应用建两条长连接会导致事件错乱，请检查 config.yaml`);
    }
    seenAppIds.add(appId);
    if (raw.default_workspace && !workspaceNames.includes(raw.default_workspace)) {
      throw new Error(`${where} 的 default_workspace "${raw.default_workspace}" 不在 workspaces 列表中`);
    }
    let concurrency: number | undefined;
    if (raw.concurrency !== undefined && raw.concurrency !== null) {
      // 非法值必须在此处抛错：NaN/0 透传给 Semaphore 会导致任务永远拿不到许可（死锁）
      concurrency = Number(raw.concurrency);
      if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 100) {
        throw new Error(`${where} 的 concurrency 必须为 1-100 的数字（当前值：${String(raw.concurrency)}），请检查 config.yaml`);
      }
    }
    // claude_config_dir 已废弃：所有机器人一律共享本机 ~/.claude（模型设置/登录态/MCP/skills/插件），
    // 机器人间仅靠 sessions.<appId>.json 做会话隔离。检测到旧键仅 warn 不报错，保证存量配置平滑升级
    if (typeof raw.claude_config_dir === 'string' && raw.claude_config_dir.trim()) {
      console.warn(
        `[配置] ${where} 的 claude_config_dir 已废弃：本版起所有机器人一律使用 ~/.claude`
        + `（共享本机模型设置/登录态/MCP/skills/插件，仅会话池隔离），该配置项将被忽略`,
      );
    }
    return {
      name,
      appId,
      appSecret: raw.app_secret,
      domain: raw.domain === 'lark' ? 'lark' : 'feishu',
      defaultWorkspace: raw.default_workspace,
      concurrency,
      appendSystemPrompt: raw.append_system_prompt,
      env: raw.env && typeof raw.env === 'object' ? raw.env : undefined,
      triggers: normalizeTriggers(raw.triggers, where),
      plugins: normalizePlugins(raw.plugins, where),
    };
  });
  // name 重复仅 warn：纯显示用途，不影响路由与隔离
  const names = new Set<string>();
  for (const a of apps) {
    if (names.has(a.name)) console.warn(`[配置] 应用名称 "${a.name}" 重复，仅影响显示，不影响功能`);
    names.add(a.name);
  }
  return apps;
}

export function loadConfig(path: string = CONFIG_PATH): BridgeConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`找不到配置文件 ${path}，请先运行 lcb setup`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`配置文件 YAML 语法错误：${(e as YAMLParseError).message}`);
  }
  const workspaces = (doc.workspaces ?? []) as Array<{ name: string; path: string }>;
  if (workspaces.length === 0) throw new Error('配置至少需要一个 workspaces 条目');
  const defaults = (doc.defaults ?? {}) as { workspace: string };
  if (!workspaces.some((w) => w.name === defaults.workspace)) {
    throw new Error(`defaults.workspace "${defaults.workspace}" 不在 workspaces 列表中`);
  }
  // 非法值必须在此处抛错：NaN/0 透传给 Semaphore 会导致任务永远拿不到许可（死锁）
  const concurrency = Number(doc.concurrency ?? 3);
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error(`concurrency 必须为 1-100 的数字（当前值：${String(doc.concurrency)}），请检查 config.yaml`);
  }
  const apps = normalizeApps(doc, workspaces.map((w) => w.name));
  const transcriptsRaw = (doc.transcripts ?? {}) as { retention_days?: unknown };
  const retentionDays = Number(transcriptsRaw.retention_days ?? 0);
  return {
    apps,
    workspaces,
    defaults: { workspace: defaults.workspace },
    concurrency,
    // 缺省/0/非法 = 永久保留，不默认删用户数据
    transcripts: Number.isFinite(retentionDays) && retentionDays > 0 ? { retentionDays } : undefined,
  };
}

/** 热重载比较：任一 app 的凭证/名称/工作区/并发/配置目录/人格变化即视为需重启的变更（顺序敏感） */
export function sameApps(a: FeishuAppConfig[], b: FeishuAppConfig[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.appId === y.appId && x.appSecret === y.appSecret && x.name === y.name
      && x.domain === y.domain && x.defaultWorkspace === y.defaultWorkspace
      && x.concurrency === y.concurrency
      && x.appendSystemPrompt === y.appendSystemPrompt
      && JSON.stringify(x.env ?? {}) === JSON.stringify(y.env ?? {});
  });
}
