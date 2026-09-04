import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, type YAMLParseError } from 'yaml';
import type {
  BridgeConfig, ClaudeAuthMode, ClaudeConfig, ClaudeProfile, FeishuAppConfig, PermissionsConfig, PluginRef,
  ServerConfig, SlashCommandDef, SlashCommandsConfig, TriggerRule, Workspace, WorkspaceType,
} from './types.js';

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

const WORKSPACE_TYPES: ReadonlySet<string> = new Set(['code-dev', 'generic']);

/** 归一化工作区列表：name/path 必须非空；type 严格枚举（code-dev = 统一 plan mode + diff 收尾，generic = 缺省） */
function normalizeWorkspaces(raw: unknown): Workspace[] {
  const list = (Array.isArray(raw) ? raw : []) as Array<{ name?: unknown; path?: unknown; type?: unknown }>;
  if (list.length === 0) throw new Error('配置至少需要一个 workspaces 条目');
  return list.map((w, i): Workspace => {
    const name = typeof w?.name === 'string' ? w.name.trim() : '';
    const path = typeof w?.path === 'string' ? w.path.trim() : '';
    if (!name) throw new Error(`workspaces[${i}] 缺少 name，请检查 config.yaml`);
    if (!path) throw new Error(`workspaces[${i}](${name}) 缺少 path，请检查 config.yaml`);
    if (w.type === undefined || w.type === null) return { name, path };
    if (typeof w.type !== 'string' || !WORKSPACE_TYPES.has(w.type)) {
      throw new Error(`workspaces[${i}](${name}) 的 type 必须为 code-dev / generic（当前值：${String(w.type)}），请检查 config.yaml`);
    }
    return { name, path, type: w.type as WorkspaceType };
  });
}

/**
 * 归一化 permissions 白名单块（整体可选）：allow_tools 为免确认直通工具名（配置即整体替换内置默认，
 * 不与默认合并）；dangerous_commands 为 Bash 危险命令正则源串（此处 new RegExp 预编译校验，
 * 非法正则硬抛——带permissions[i]定位，运行期再抛会让所有 Bash 意外弹卡）。
 */
function normalizePermissions(doc: Record<string, unknown>): PermissionsConfig | undefined {
  const raw = doc.permissions;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('permissions 必须为对象（含 allow_tools / dangerous_commands），请检查 config.yaml');
  const p = raw as { allow_tools?: unknown; dangerous_commands?: unknown };
  const allowTools = p.allow_tools;
  if (allowTools !== undefined) {
    if (!Array.isArray(allowTools) || allowTools.some((t) => typeof t !== 'string' || !t.trim())) {
      throw new Error('permissions.allow_tools 必须为非空字符串数组，请检查 config.yaml');
    }
  }
  const dangerous = p.dangerous_commands;
  let dangerousCommands: RegExp[] = [];
  if (dangerous !== undefined) {
    if (!Array.isArray(dangerous)) throw new Error('permissions.dangerous_commands 必须为正则字符串数组，请检查 config.yaml');
    dangerousCommands = dangerous.map((s, i) => {
      if (typeof s !== 'string' || !s.trim()) throw new Error(`permissions.dangerous_commands[${i}] 必须为非空正则字符串，请检查 config.yaml`);
      try {
        // 统一 i flag 与内置 DEFAULT_DANGEROUS_COMMANDS 一致（大小写变体的危险命令同样命中；黑名单扩大仅偏安全方向）
        return new RegExp(s, 'i');
      } catch (e) {
        throw new Error(`permissions.dangerous_commands[${i}] 不是合法正则（"${s}"）：${(e as Error).message}`);
      }
    });
  }
  return {
    ...(allowTools !== undefined ? { allowTools: allowTools as string[] } : {}),
    ...(dangerous !== undefined ? { dangerousCommands } : {}),
  };
}

/** Web 配置页服务器段（整体可选）：host 缺省 127.0.0.1、port 硬校验（非法值会让 server 起不来） */
function normalizeServer(doc: Record<string, unknown>): ServerConfig | undefined {
  const raw = doc.server;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('server 必须为对象（含 enabled / host / port），请检查 config.yaml');
  const s = raw as { enabled?: unknown; host?: unknown; port?: unknown };
  let enabled = true;
  if (s.enabled !== undefined && s.enabled !== null) {
    if (typeof s.enabled !== 'boolean') throw new Error('server.enabled 必须为布尔值，请检查 config.yaml');
    enabled = s.enabled;
  }
  let host = '127.0.0.1';
  if (s.host !== undefined && s.host !== null) {
    if (typeof s.host !== 'string' || !s.host.trim()) throw new Error('server.host 必须为非空字符串，请检查 config.yaml');
    host = s.host.trim();
    // 默认只绑回环：放开到非回环地址意味着局域网可见（配置页能读写全部凭证），显式警示
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.warn(`[配置] server.host = ${host} 非回环地址：配置页将暴露给局域网（页面可读写 app_secret 等凭证），请确认网络环境可信`);
    }
  }
  let port = 17317;
  if (s.port !== undefined && s.port !== null) {
    port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`server.port 必须为 1-65535 的整数（当前值：${String(s.port)}），请检查 config.yaml`);
    }
  }
  return { enabled, host, port };
}

/** Claude 认证段（整体可选）：mode 缺省 inherit；managed 下两凭证并存硬抛（会被 API 拒绝且意图不明） */
function normalizeClaude(doc: Record<string, unknown>): ClaudeConfig | undefined {
  const raw = doc.claude;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('claude 必须为对象（含 mode / auth_token / api_key / base_url / model），请检查 config.yaml');
  const c = raw as { mode?: unknown; auth_token?: unknown; api_key?: unknown; base_url?: unknown; model?: unknown };
  let mode: ClaudeAuthMode = 'inherit';
  if (c.mode !== undefined && c.mode !== null) {
    if (c.mode !== 'inherit' && c.mode !== 'managed') {
      throw new Error(`claude.mode 必须为 inherit / managed（当前值：${String(c.mode)}），请检查 config.yaml`);
    }
    mode = c.mode;
  }
  const str = (v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new Error('claude 段的字段必须为字符串，请检查 config.yaml');
    const t = v.trim();
    return t ? t : undefined;
  };
  const authToken = str(c.auth_token);
  const apiKey = str(c.api_key);
  if (authToken && apiKey) {
    throw new Error('claude.auth_token 与 claude.api_key 只能二选一（并存时 API 侧凭证歧义），请检查 config.yaml');
  }
  const baseUrl = str(c.base_url);
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    console.warn(`[配置] claude.base_url = ${baseUrl} 不以 http(s):// 开头，请确认是否漏写协议`);
  }
  // managed 无凭证：允许落盘（首次进配置页的中间态），启动时 auth-precheck 会再提示
  if (mode === 'managed' && !authToken && !apiKey) {
    console.warn('[配置] claude.mode = managed 但未配置 auth_token / api_key：请在 Web 配置页填写，否则 Claude 任务将无法认证');
  }
  const model = str(c.model);
  // 多厂商档案库（不直接生效；Web 页「设为当前」拷贝到顶层）。校验与顶层同则：凭证二选一、http(s) 协议
  const profilesRaw = (raw as { profiles?: unknown }).profiles;
  let profiles: ClaudeProfile[] | undefined;
  if (profilesRaw !== undefined && profilesRaw !== null) {
    if (!Array.isArray(profilesRaw)) throw new Error('claude.profiles 必须为数组，请检查 config.yaml');
    const seenNames = new Set<string>();
    profiles = [];
    profilesRaw.forEach((e, i) => {
      const where = `claude.profiles[${i}]`;
      if (typeof e !== 'object' || e === null || Array.isArray(e)) throw new Error(`${where} 必须为对象（name + 凭证/BaseUrl/模型），请检查 config.yaml`);
      const p = e as Record<string, unknown>;
      const name = str(p.name);
      if (!name) throw new Error(`${where} 缺少 name（档案名，显示用），请检查 config.yaml`);
      const pAuthToken = str(p.auth_token);
      const pApiKey = str(p.api_key);
      if (pAuthToken && pApiKey) {
        throw new Error(`${where}（${name}）的 auth_token 与 api_key 只能二选一，请检查 config.yaml`);
      }
      const pBaseUrl = str(p.base_url);
      if (pBaseUrl && !/^https?:\/\//.test(pBaseUrl)) {
        console.warn(`[配置] ${where}（${name}）的 base_url = ${pBaseUrl} 不以 http(s):// 开头，请确认是否漏写协议`);
      }
      const pModel = str(p.model);
      // 候选模型集：字符串数组，trim 去空去重（页面点选切换用，不直接生效）
      const pModelsRaw = p.models;
      let pModels: string[] | undefined;
      if (pModelsRaw !== undefined && pModelsRaw !== null) {
        if (!Array.isArray(pModelsRaw)) throw new Error(`${where}（${name}）的 models 必须为字符串数组，请检查 config.yaml`);
        const seenModels = new Set<string>();
        for (const m of pModelsRaw) {
          if (typeof m !== 'string') throw new Error(`${where}（${name}）的 models 必须为字符串数组，请检查 config.yaml`);
          const t = m.trim();
          if (t) seenModels.add(t);
        }
        pModels = seenModels.size ? [...seenModels] : undefined;
      }
      if (!pAuthToken && !pApiKey && !pBaseUrl && !pModel && !pModels) {
        console.warn(`[配置] ${where}（${name}）除名字外全为空，已剔除`);
        return;
      }
      if (seenNames.has(name)) {
        console.warn(`[配置] ${where} 档案名 "${name}" 重复，已忽略后条`);
        return;
      }
      seenNames.add(name);
      profiles!.push({ name, ...(pAuthToken ? { authToken: pAuthToken } : {}), ...(pApiKey ? { apiKey: pApiKey } : {}),
        ...(pBaseUrl ? { baseUrl: pBaseUrl } : {}), ...(pModel ? { model: pModel } : {}), ...(pModels ? { models: pModels } : {}) });
    });
    if (!profiles.length) profiles = undefined;
  }
  return { mode, ...(authToken ? { authToken } : {}), ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}),
    ...(profiles ? { profiles } : {}) };
}

/** 斜杠命令名合法性（飞书侧注册约束）：1-32 位字母/数字/下划线/连字符。extra 解析与 Web 远端 create 端点共用 */
export const SLASH_COMMAND_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 斜杠命令同步段（整体可选）：extra 为自定义透传命令；与内置命令的重名在 expectedCommands 合并时处理（内置优先） */
function normalizeSlashCommands(doc: Record<string, unknown>): SlashCommandsConfig | undefined {
  const raw = doc.slash_commands;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('slash_commands 必须为对象（含 extra 数组），请检查 config.yaml');
  const extraRaw = (raw as { extra?: unknown }).extra;
  if (extraRaw === undefined || extraRaw === null) return {};
  if (!Array.isArray(extraRaw)) throw new Error('slash_commands.extra 必须为数组，请检查 config.yaml');
  const seen = new Set<string>();
  const extra: SlashCommandDef[] = [];
  extraRaw.forEach((e, i) => {
    const where = `slash_commands.extra[${i}]`;
    let command = typeof e?.command === 'string' ? e.command.trim() : '';
    const description = typeof e?.description === 'string' ? e.description.trim() : '';
    if (!command) throw new Error(`${where} 缺少 command，请检查 config.yaml`);
    if (command.startsWith('/')) {
      command = command.slice(1); // 飞书侧注册用裸名，容错剥离
      console.warn(`[配置] ${where} 的 command 不应带 / 前缀（飞书斜杠命令注册用裸名），已自动剥离`);
    }
    if (!SLASH_COMMAND_RE.test(command)) {
      throw new Error(`${where} 的 command "${command}" 须为 1-32 位字母/数字/下划线/连字符`);
    }
    if (!description) throw new Error(`${where} 缺少 description（飞书指令面板展示用），请检查 config.yaml`);
    if (seen.has(command)) {
      console.warn(`[配置] ${where} 的 command "${command}" 重复，已忽略后条`);
      return;
    }
    seen.add(command);
    const icon = typeof e?.icon === 'string' && e.icon.trim() ? e.icon.trim() : undefined;
    extra.push(icon ? { command, description, icon } : { command, description });
  });
  return { extra };
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
  return parseConfigText(raw, path);
}

/**
 * 从 YAML 文本解析配置（loadConfig 的字符串版）：Web 配置页 PUT /api/config 写盘前
 * 的内存校验复用同一套 normalize 逻辑，保证「页面能保存的」与「启动能加载的」完全一致。
 */
export function parseConfigText(raw: string, pathForError: string = CONFIG_PATH): BridgeConfig {
  let doc: Record<string, unknown>;
  try {
    doc = parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`配置文件 YAML 语法错误：${(e as YAMLParseError).message}（${pathForError}）`);
  }
  const workspaces = normalizeWorkspaces(doc.workspaces);
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
  // 可选段统一模式：normalize 返回 undefined = 段未配置，不落键
  const section = <T>(v: T | undefined, key: string): Record<string, T> => (v === undefined ? {} : { [key]: v });
  const server = normalizeServer(doc);
  const claude = normalizeClaude(doc);
  const slashCommands = normalizeSlashCommands(doc);
  return {
    apps,
    workspaces,
    defaults: { workspace: defaults.workspace },
    concurrency,
    // 缺省/0/非法 = 永久保留，不默认删用户数据
    transcripts: Number.isFinite(retentionDays) && retentionDays > 0 ? { retentionDays } : undefined,
    // 权限白名单：未配置的字段由消费侧（permission-gate）回退内置默认
    ...section(normalizePermissions(doc), 'permissions'),
    ...section(server, 'server'),
    ...section(claude, 'claude'),
    ...section(slashCommands, 'slashCommands'),
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
