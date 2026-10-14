import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, type YAMLParseError } from 'yaml';
import type {
  BridgeConfig, CardConfig, ClaudeAuthMode, ClaudeConfig, ClaudeProfile, FeishuAppConfig, MemoryConfig, MemoryModelConfig,
  PermissionsConfig, PluginRef, SecurityConfig, ServerConfig, SessionConfig, SlashCommandDef, SlashCommandsConfig, TriggerRule, Workspace,
} from './types.js';

/** LCB_CONFIG_DIR 环境变量可覆盖配置根目录（多租户分进程场景用；正常用户无须设置） */
export const CONFIG_DIR = join(process.env.LCB_CONFIG_DIR ?? homedir(), '.lark-claudecode-bridge');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

/** 入站附件目录（用户发给 bot 的图片/文件下载落盘处）：gateway 下载（feishu-gateway.ts）与
 *  分身安全闸 R1 读豁免（index.ts securityGuard）共用单源；固定为 CONFIG_DIR 一级子目录 inbox */
export const INBOX_DIR = join(CONFIG_DIR, 'inbox');

/** 会话上下文超长提醒默认阈值（tokens）：约 200k 窗口的 75%，估算口径见 SessionConfig 注释 */
export const DEFAULT_CONTEXT_REMIND_TOKENS = 150000;

/** 会话行为段（整体可选）：context_remind_tokens 硬校验（非法值会让提醒永久误报/永不触发）；
 *  notify_sop 类型校验（非法值会让 SOP 注入/硬兜底配对错位）。
 *  生命周期方案新增键：resident_process / resident_idle_minutes / resident_max_processes
 *  （A2 常驻进程池）与 group_idle_reset_hours / group_max_turns / group_roll_notify
 *  （A3 群聊自动滚动），全部硬校验——非法值会让回收/滚动永久误触发或永不触发 */
function normalizeSession(doc: Record<string, unknown>): SessionConfig | undefined {
  const raw = doc.session;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('session 必须为对象（含 context_remind_tokens / notify_sop），请检查 config.yaml');
  const s = raw as {
    context_remind_tokens?: unknown; notify_sop?: unknown; tool_hint?: unknown;
    resident_process?: unknown; resident_idle_minutes?: unknown; resident_max_processes?: unknown;
    group_idle_reset_hours?: unknown; group_max_turns?: unknown; group_roll_notify?: unknown;
  };
  const out: SessionConfig = {};
  if (s.context_remind_tokens !== undefined && s.context_remind_tokens !== null) {
    const n = Number(s.context_remind_tokens);
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
      throw new Error(`session.context_remind_tokens 必须为 0-10000000 的整数（0 = 关闭提醒；当前值：${String(s.context_remind_tokens)}），请检查 config.yaml`);
    }
    out.contextRemindTokens = n;
  }
  // notify_sop：缺省=true（开启 SOP 软约束 + 硬兜底），false = 完全关闭。type 校验保证不传字符串/数字过来配对错位
  if (s.notify_sop !== undefined && s.notify_sop !== null) {
    if (typeof s.notify_sop !== 'boolean') {
      throw new Error(`session.notify_sop 必须为 boolean（true = 启用，false = 关闭；当前值：${String(s.notify_sop)}），请检查 config.yaml`);
    }
    out.notifySop = s.notify_sop;
  }
  // tool_hint：缺省=true（注入工具可用性说明，对抗 dynamic tool loading 自查误判），false = 关闭
  if (s.tool_hint !== undefined && s.tool_hint !== null) {
    if (typeof s.tool_hint !== 'boolean') {
      throw new Error(`session.tool_hint 必须为 boolean（true = 启用，false = 关闭；当前值：${String(s.tool_hint)}），请检查 config.yaml`);
    }
    out.toolHint = s.tool_hint;
  }
  // resident_process：缺省=true（同通道常驻复用 CLI 子进程），false = 每消息冷启（旧行为）
  if (s.resident_process !== undefined && s.resident_process !== null) {
    if (typeof s.resident_process !== 'boolean') {
      throw new Error(`session.resident_process 必须为 boolean（true = 启用，false = 关闭；当前值：${String(s.resident_process)}），请检查 config.yaml`);
    }
    out.residentProcess = s.resident_process;
  }
  // resident_idle_minutes：空闲回收阈值（分钟），0 = 不自动回收；缺省 60（消费侧 ?? 兜底）
  if (s.resident_idle_minutes !== undefined && s.resident_idle_minutes !== null) {
    const n = Number(s.resident_idle_minutes);
    if (!Number.isInteger(n) || n < 0 || n > 10_080) {
      throw new Error(`session.resident_idle_minutes 必须为 0-10080 的整数（0 = 不自动回收；当前值：${String(s.resident_idle_minutes)}），请检查 config.yaml`);
    }
    if (n === 0) console.warn('[配置] session.resident_idle_minutes = 0：常驻进程将不被空闲回收（仅受 resident_max_processes 上限约束），注意内存占用');
    out.residentIdleMinutes = n;
  }
  // resident_max_processes：池上限（按 app 统计），缺省 = 该 app 并发数（消费侧兜底）
  if (s.resident_max_processes !== undefined && s.resident_max_processes !== null) {
    const n = Number(s.resident_max_processes);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new Error(`session.resident_max_processes 必须为 1-100 的整数（当前值：${String(s.resident_max_processes)}），请检查 config.yaml`);
    }
    out.residentMaxProcesses = n;
  }
  // group_idle_reset_hours：群聊空闲滚动阈值（小时），0 = 关闭；缺省 4（消费侧 ?? 兜底）
  if (s.group_idle_reset_hours !== undefined && s.group_idle_reset_hours !== null) {
    const n = Number(s.group_idle_reset_hours);
    if (!Number.isFinite(n) || n < 0 || n > 720) {
      throw new Error(`session.group_idle_reset_hours 必须为 0-720 的数字（0 = 关闭空闲滚动；当前值：${String(s.group_idle_reset_hours)}），请检查 config.yaml`);
    }
    out.groupIdleResetHours = n;
  }
  // group_max_turns：群聊轮次滚动阈值（任务数），0 = 关闭；缺省 30（消费侧 ?? 兜底）
  if (s.group_max_turns !== undefined && s.group_max_turns !== null) {
    const n = Number(s.group_max_turns);
    if (!Number.isInteger(n) || n < 0 || n > 1000) {
      throw new Error(`session.group_max_turns 必须为 0-1000 的整数（0 = 关闭轮次滚动；当前值：${String(s.group_max_turns)}），请检查 config.yaml`);
    }
    out.groupMaxTurns = n;
  }
  // group_roll_notify：滚动后首条回复尾部轻注记，缺省 true
  if (s.group_roll_notify !== undefined && s.group_roll_notify !== null) {
    if (typeof s.group_roll_notify !== 'boolean') {
      throw new Error(`session.group_roll_notify 必须为 boolean（true = 带轻注记，false = 关闭；当前值：${String(s.group_roll_notify)}），请检查 config.yaml`);
    }
    out.groupRollNotify = s.group_roll_notify;
  }
  return out;
}

/** 卡片展示段（整体可选）：width 严格枚举（default = 飞书默认宽度；fill = 撑满聊天窗口） */
function normalizeCard(doc: Record<string, unknown>): CardConfig | undefined {
  const raw = doc.card;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('card 必须为对象（含 width），请检查 config.yaml');
  const c = raw as { width?: unknown };
  if (c.width === undefined || c.width === null) return {};
  if (c.width !== 'default' && c.width !== 'fill') {
    throw new Error(`card.width 必须为 default / fill（当前值：${String(c.width)}），请检查 config.yaml`);
  }
  return { width: c.width };
}

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
  triggers?: Array<{ match?: string; rewrite?: string; ask_detail?: unknown }>;
  plugins?: Array<{ name?: string; path?: string }>;
  role?: string;
  profile?: string;
  profile_model?: string;
  bash_mode?: unknown;
  allowed_skills?: unknown;
  allowed_plugins?: unknown;
  allowed_workspaces?: unknown;
}

/** 字符串数组归一化：非数组硬抛（带定位），元素 trim 并剔除空串 */
function normalizeStringArray(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${where} 必须为字符串数组，请检查 config.yaml`);
  const arr = (raw as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  if ((raw as unknown[]).length > 0 && arr.length === 0) throw new Error(`${where} 不能全为空字符串`);
  return arr;
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
    // 无占位符时斜杠形态命中会自动把用户参数追加到改写结果末尾（triggers.ts），warn 提示确认是否符合预期
    if (!rewrite.includes('{text}') && !rewrite.includes('{args}')) {
      console.warn(`[配置] ${where} 的 triggers[${j}].rewrite 不含 {text} / {args} 占位符，斜杠命中时用户参数将自动追加在改写结果末尾（需精确控制位置请改用占位符）`);
    }
    // ask_detail 两段式触发：仅 true 时写入（缺省/false 不产键，YAML 干净）；非布尔真值不认（宽松归一，误配不炸）
    if (t?.ask_detail === true) return { match, rewrite, askDetail: true };
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

/** 归一化工作区列表：name/path 必须非空。
 * type 字段已废弃（#6：统一通用模式 + /plan 命令通道级切换计划模式，diff 收尾改为
 * git 仓库自动判定）——旧配置携带 type 仅 warn 忽略，不报错、不再生效 */
function normalizeWorkspaces(raw: unknown): Workspace[] {
  const list = (Array.isArray(raw) ? raw : []) as Array<{ name?: unknown; path?: unknown; type?: unknown }>;
  if (list.length === 0) throw new Error('配置至少需要一个 workspaces 条目');
  return list.map((w, i): Workspace => {
    const name = typeof w?.name === 'string' ? w.name.trim() : '';
    const path = typeof w?.path === 'string' ? w.path.trim() : '';
    if (!name) throw new Error(`workspaces[${i}] 缺少 name，请检查 config.yaml`);
    if (!path) throw new Error(`workspaces[${i}](${name}) 缺少 path，请检查 config.yaml`);
    if (w.type !== undefined && w.type !== null) {
      console.warn(`[配置] workspaces[${i}](${name}) 的 type 已废弃（统一通用模式；计划模式请在飞书发 /plan 按通道切换），该配置项将被忽略`);
    }
    return { name, path };
  });
}

/**
 * 归一化 permissions 白名单块（整体可选）：allow_tools 为免确认直通工具名（配置即整体替换内置默认，
 * 不与默认合并）；dangerous_commands 为 Bash 危险命令正则源串（此处 new RegExp 预编译校验，
 * 非法正则硬抛——带permissions[i]定位，运行期再抛会让所有 Bash 意外弹卡）；
 * allow_all_tools 为「全部工具免确认」开关（缺省开，消费侧回退 DEFAULT_ALLOW_ALL_TOOLS）。
 */
function normalizePermissions(doc: Record<string, unknown>): PermissionsConfig | undefined {
  const raw = doc.permissions;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('permissions 必须为对象（含 allow_all_tools / allow_tools / dangerous_commands），请检查 config.yaml');
  const p = raw as { allow_tools?: unknown; dangerous_commands?: unknown; allow_all_tools?: unknown };
  const allowAllTools = p.allow_all_tools;
  // 缺省/null 视为未配置（消费侧回退内置默认「开」）；其余非布尔一律硬抛——
  // 引号包裹的 'false' 在 YAML 里是字符串，若被静默当真值处理会让用户以为已关闭而实际全放行
  if (allowAllTools !== undefined && allowAllTools !== null && typeof allowAllTools !== 'boolean') {
    throw new Error('permissions.allow_all_tools 必须为布尔值（true / false，勿加引号），请检查 config.yaml');
  }
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
    ...(typeof allowAllTools === 'boolean' ? { allowAllTools } : {}),
    ...(allowTools !== undefined ? { allowTools: allowTools as string[] } : {}),
    ...(dangerous !== undefined ? { dangerousCommands } : {}),
  };
}

/**
 * 安保段归一化（整体可选；方案 v3 红线轴）：redzone.read 为 glob 模式串数组（运行期编译，
 * 空数组 = 关闭 R1——显式关闭是主人的权利，但分身误配为空会失去红区保护，warn 提示）；
 * redact_patterns 为自定义脱敏正则源串（此处预编译校验，非法条目 warn 跳过——运行期再失败
 * 会静默漏规则，配置期提示一次）；canary_patterns 为金丝雀标记串。
 */
function normalizeSecurity(doc: Record<string, unknown>): SecurityConfig | undefined {
  const raw = doc.security;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('security 必须为对象（含 redzone / redact_patterns / canary_patterns），请检查 config.yaml');
  const s = raw as { redzone?: unknown; redact_patterns?: unknown; canary_patterns?: unknown };
  const out: SecurityConfig = {};
  if (s.redzone !== undefined && s.redzone !== null) {
    if (typeof s.redzone !== 'object') throw new Error('security.redzone 必须为对象（含 read 数组），请检查 config.yaml');
    const read = (s.redzone as { read?: unknown }).read;
    if (read !== undefined && read !== null) {
      if (!Array.isArray(read) || read.some((x) => typeof x !== 'string' || !x.trim())) {
        throw new Error('security.redzone.read 必须为非空字符串数组（glob 模式，支持 ~ / ** / *），请检查 config.yaml');
      }
      const list = (read as string[]).map((x) => x.trim()).filter(Boolean);
      out.redzone = { read: list };
      if (list.length === 0) console.warn('[配置] security.redzone.read 为空数组：R1 读红线已关闭（分身将可读取全盘），请确认是否预期');
    }
  }
  const redact = s.redact_patterns;
  if (redact !== undefined && redact !== null) {
    if (!Array.isArray(redact)) throw new Error('security.redact_patterns 必须为正则字符串数组，请检查 config.yaml');
    const compiled: string[] = [];
    (redact as unknown[]).forEach((x, i) => {
      if (typeof x !== 'string' || !x.trim()) throw new Error(`security.redact_patterns[${i}] 必须为非空正则字符串，请检查 config.yaml`);
      try {
        new RegExp(x); // 预编译校验（运行期 compileCustomRules 会再兜一层）
        compiled.push(x);
      } catch (e) {
        console.warn(`[配置] security.redact_patterns[${i}] 不是合法正则（"${x.slice(0, 40)}"），已忽略：${(e as Error).message}`);
      }
    });
    if (compiled.length) out.redactPatterns = compiled;
  }
  const canary = s.canary_patterns;
  if (canary !== undefined && canary !== null) {
    if (!Array.isArray(canary) || canary.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new Error('security.canary_patterns 必须为非空字符串数组，请检查 config.yaml');
    }
    out.canaryPatterns = (canary as string[]).map((x) => x.trim()).filter(Boolean);
  }
  return Object.keys(out).length ? out : undefined;
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

/** 开机自启意图段（整体可选）：仅记录用户开关选择；实际注册状态以 OS 查询为权威（web/autostart.ts） */
function normalizeAutostart(doc: Record<string, unknown>): { enabled?: boolean } | undefined {
  const raw = doc.autostart;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('autostart 必须为对象（含 enabled），请检查 config.yaml');
  const a = raw as { enabled?: unknown };
  if (a.enabled !== undefined && a.enabled !== null && typeof a.enabled !== 'boolean') {
    throw new Error('autostart.enabled 必须为布尔值，请检查 config.yaml');
  }
  return { ...(typeof a.enabled === 'boolean' ? { enabled: a.enabled } : {}) };
}

/**
 * 长期记忆段（整体可选；生命周期方案 §6.6）：enabled 缺省 false（零开销）；mode 缺省 remote——
 * embedded 由 B3 安装器接管（受管服务/自动分配端口），此前显式 remote 或缺省都指向外部已跑的
 * server。段内字段全部硬校验：enabled/mode 类型错会让「开关记忆」语义错位，endpoint 非法 URL
 * 会让探活/env 透传指向错误目标。缺省 enabled=false 时其余字段仍解析保存（用户先填表单后开启，
 * B2 配置页 [测试连接] 双绿门禁的前置形态）。
 */
function normalizeMemory(doc: Record<string, unknown>): MemoryConfig | undefined {
  const raw = doc.memory;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('memory 必须为对象（含 enabled / mode / endpoint），请检查 config.yaml');
  const m = raw as {
    enabled?: unknown; mode?: unknown; version?: unknown; endpoint?: unknown;
    account?: unknown; api_key?: unknown; model?: unknown; granularity?: unknown;
  };
  let enabled = false;
  if (m.enabled !== undefined && m.enabled !== null) {
    if (typeof m.enabled !== 'boolean') {
      throw new Error(`memory.enabled 必须为 boolean（true = 开启记忆；当前值：${String(m.enabled)}），请检查 config.yaml`);
    }
    enabled = m.enabled;
  }
  let mode: MemoryConfig['mode'] = 'remote';
  if (m.mode !== undefined && m.mode !== null) {
    if (m.mode !== 'embedded' && m.mode !== 'remote') {
      throw new Error(`memory.mode 必须为 embedded / remote（当前值：${String(m.mode)}），请检查 config.yaml`);
    }
    mode = m.mode;
  }
  const str = (v: unknown, key: string): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new Error(`memory.${key} 必须为字符串，请检查 config.yaml`);
    const t = v.trim();
    return t ? t : undefined;
  };
  const version = str(m.version, 'version');
  const endpoint = str(m.endpoint, 'endpoint');
  if (endpoint && !/^https?:\/\//.test(endpoint)) {
    throw new Error(`memory.endpoint 必须为 http(s):// 开头的 URL（当前值：${endpoint}），请检查 config.yaml`);
  }
  const account = str(m.account, 'account');
  const apiKey = str(m.api_key, 'api_key');
  // 记忆粒度（最终方案 §三 决策 2）：bot（缺省）/ bot-user（升级意向，增量演进不改既有 key）
  let granularity: MemoryConfig['granularity'];
  if (m.granularity !== undefined && m.granularity !== null) {
    if (m.granularity !== 'bot' && m.granularity !== 'bot-user') {
      throw new Error(`memory.granularity 必须为 bot / bot-user（当前值：${String(m.granularity)}），请检查 config.yaml`);
    }
    granularity = m.granularity;
  }
  // model 子段：B2 配置页消费（渲染 ov.conf），此处仅形状校验 + 透传——与厂商档案零耦合，不读 claude 段
  let model: MemoryModelConfig | undefined;
  if (m.model !== undefined && m.model !== null) {
    if (typeof m.model !== 'object') throw new Error('memory.model 必须为对象（含 provider / api_base / api_key / vlm_model / embedding_model），请检查 config.yaml');
    const mm = m.model as Record<string, unknown>;
    let provider: MemoryModelConfig['provider'];
    const rawProvider = str(mm.provider, 'model.provider');
    if (rawProvider) {
      if (rawProvider !== 'glm' && rawProvider !== 'volcengine' && rawProvider !== 'openai-compatible' && rawProvider !== 'ollama') {
        throw new Error(`memory.model.provider 必须为 glm / volcengine / openai-compatible / ollama（当前值：${rawProvider}），请检查 config.yaml`);
      }
      provider = rawProvider;
    }
    model = {
      ...(provider ? { provider } : {}),
      ...(str(mm.api_base, 'model.api_base') ? { apiBase: str(mm.api_base, 'model.api_base')! } : {}),
      ...(str(mm.api_key, 'model.api_key') ? { apiKey: str(mm.api_key, 'model.api_key')! } : {}),
      ...(str(mm.vlm_model, 'model.vlm_model') ? { vlmModel: str(mm.vlm_model, 'model.vlm_model')! } : {}),
      ...(str(mm.embedding_model, 'model.embedding_model') ? { embeddingModel: str(mm.embedding_model, 'model.embedding_model')! } : {}),
      // 双端点拆分（最终方案 §五-P2）：向量块独立端点/Key，缺省沿用主块（渲染 ov.conf 时回退）
      ...(str(mm.embedding_api_base, 'model.embedding_api_base') ? { embeddingApiBase: str(mm.embedding_api_base, 'model.embedding_api_base')! } : {}),
      ...(str(mm.embedding_api_key, 'model.embedding_api_key') ? { embeddingApiKey: str(mm.embedding_api_key, 'model.embedding_api_key')! } : {}),
    };
    if (Object.keys(model).length === 0) model = undefined;
  }
  return {
    enabled,
    mode,
    ...(version ? { version } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(account ? { account } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(granularity ? { granularity } : {}),
  };
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
  // 模型名 1M 上下文后缀归一：统一折叠为官方小写格式 [1m]（如 glm-5.3[1M] → glm-5.3[1m]）。
  // 顶层 model 与档案 model/models 全走此漏斗——保证 use-profile 候选集精确匹配两端一致，
  // 折叠必须发生在 models 去重之前（否则 [1M]/[1m] 两条并存逃过去重）
  const normModel = (s: string | undefined): string | undefined =>
    s ? s.replace(/\[1m\]$/i, '[1m]') : s;
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
  const model = normModel(str(c.model));
  // managed 模式显式环境变量（MCP 工具依赖的自定义变量；领土 4 键不在此生效，buildManagedSettings 入口过滤）
  const envRaw = (raw as { env?: unknown }).env;
  let env: Record<string, string> | undefined;
  if (envRaw !== undefined && envRaw !== null) {
    if (typeof envRaw !== 'object' || Array.isArray(envRaw)) {
      throw new Error('claude.env 必须为「KEY: 值」映射对象，请检查 config.yaml');
    }
    const picked: Record<string, string> = {};
    for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new Error(`claude.env.${k} 的值必须为字符串，请检查 config.yaml`);
      if (v.trim()) picked[k] = v;
    }
    if (Object.keys(picked).length) env = picked;
  }
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
      const pModel = normModel(str(p.model));
      // 候选模型集：字符串数组，trim 去空去重（页面点选切换用，不直接生效）；
      // 每条先经 normModel 折叠 [1m] 后缀再去重
      const pModelsRaw = p.models;
      let pModels: string[] | undefined;
      if (pModelsRaw !== undefined && pModelsRaw !== null) {
        if (!Array.isArray(pModelsRaw)) throw new Error(`${where}（${name}）的 models 必须为字符串数组，请检查 config.yaml`);
        const seenModels = new Set<string>();
        for (const m of pModelsRaw) {
          if (typeof m !== 'string') throw new Error(`${where}（${name}）的 models 必须为字符串数组，请检查 config.yaml`);
          const t = normModel(m.trim());
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
    ...(env ? { env } : {}), ...(profiles ? { profiles } : {}) };
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
    // 角色模型：primary（缺省）主机器人——全技能/全插件/全工作区，配对码准入；
    // deputy 分身——艾特即用供他人使用。权限轴语义（方案 v3）：白单未配置 = 全给
    // （技能全开/插件全开/工作区=全部已配置工作区），安保由红线轴（security 红区 +
    // R2 工作区外写拦截 + Bash 三态 + 出站脱敏）恒定承担，不依赖白单收窄
    let role: 'primary' | 'deputy' = 'primary';
    if (raw.role !== undefined && raw.role !== null) {
      if (raw.role !== 'primary' && raw.role !== 'deputy') {
        throw new Error(`${where} 的 role 必须为 primary / deputy（当前值：${String(raw.role)}），请检查 config.yaml`);
      }
      role = raw.role;
    }
    // Bash 三态：仅 deputy 消费（主机器人 Bash 永远可用，行为由全局 permissions 管）
    let bashMode: 'off' | 'confirm' | 'trusted' | undefined;
    if (raw.bash_mode !== undefined && raw.bash_mode !== null) {
      if (raw.bash_mode !== 'off' && raw.bash_mode !== 'confirm' && raw.bash_mode !== 'trusted') {
        throw new Error(`${where} 的 bash_mode 必须为 off / confirm / trusted（当前值：${String(raw.bash_mode)}），请检查 config.yaml`);
      }
      if (role !== 'deputy') {
        console.warn(`[配置] ${where} 非 deputy 角色，bash_mode 不生效（主机器人 Bash 由全局 permissions 约束），已忽略`);
      } else {
        bashMode = raw.bash_mode;
      }
    }
    let allowedSkills: string[] | undefined;
    let allowedPlugins: string[] | undefined;
    let allowedWorkspaces: string[] | undefined;
    if (role === 'deputy') {
      // 白单全部可选：未配置 = 全给（权限轴）。配置了才按白名单收窄；工作区名单仍校验拼写
      allowedSkills = normalizeStringArray(raw.allowed_skills, `${where} 的 allowed_skills`);
      allowedPlugins = normalizeStringArray(raw.allowed_plugins, `${where} 的 allowed_plugins`);
      allowedWorkspaces = normalizeStringArray(raw.allowed_workspaces, `${where} 的 allowed_workspaces`);
      const unknownWs = (allowedWorkspaces ?? []).filter((w) => !workspaceNames.includes(w));
      if (unknownWs.length) {
        throw new Error(`${where} 的 allowed_workspaces 含未在 workspaces 列表中定义的工作区：${unknownWs.join('、')}`);
      }
    } else if (raw.allowed_skills !== undefined || raw.allowed_plugins !== undefined || raw.allowed_workspaces !== undefined || bashMode !== undefined) {
      console.warn(`[配置] ${where} 非 deputy 角色，allowed_skills / allowed_plugins / allowed_workspaces / bash_mode 不生效（仅分身角色支持能力限定），已忽略`);
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
      // 机器人级厂商档案：宽松归一（仅 trim）；档案名是否存在在运行期解析（app-profile.ts），
      // 此处校验会让「先配 app 后建档案」的顺序成为非法（配置页两页独立保存）
      profile: typeof raw.profile === 'string' && raw.profile.trim() ? raw.profile.trim() : undefined,
      profileModel: typeof raw.profile_model === 'string' && raw.profile_model.trim() ? raw.profile_model.trim() : undefined,
      role,
      bashMode,
      allowedSkills,
      allowedPlugins,
      allowedWorkspaces,
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
  const session = normalizeSession(doc);
  return {
    apps,
    workspaces,
    defaults: { workspace: defaults.workspace },
    concurrency,
    // 缺省/0/非法 = 永久保留，不默认删用户数据
    transcripts: Number.isFinite(retentionDays) && retentionDays > 0 ? { retentionDays } : undefined,
    // 权限白名单：未配置的字段由消费侧（permission-gate）回退内置默认
    ...section(normalizePermissions(doc), 'permissions'),
    ...section(normalizeSecurity(doc), 'security'),
    ...section(server, 'server'),
    ...section(claude, 'claude'),
    ...section(slashCommands, 'slashCommands'),
    ...section(session, 'session'),
    ...section(normalizeCard(doc), 'card'),
    ...section(normalizeAutostart(doc), 'autostart'),
    ...section(normalizeMemory(doc), 'memory'),
  };
}

/** 热重载比较：任一 app 的凭证/名称/工作区/并发/配置目录/人格/角色能力变化即视为需重启的变更（顺序敏感）。
 *  env 与 profile/profileModel 不参与比较——均已纳入热重载 mutate 清单，executeTask 每任务
 *  现读解析（app-profile.ts / buildTaskEnv），改完下一条消息即生效。
 *  role/allowed_* 必须参与比较：分身的准入/技能/插件/工作区锁定语义须与长连接生命周期一致，
 *  热切换会造成「gateway 还是旧 app 语义、createBridge 已按新 role 收敛」的半新半旧状态 */
export function sameApps(a: FeishuAppConfig[], b: FeishuAppConfig[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.appId === y.appId && x.appSecret === y.appSecret && x.name === y.name
      && x.domain === y.domain && x.defaultWorkspace === y.defaultWorkspace
      && x.concurrency === y.concurrency
      && x.appendSystemPrompt === y.appendSystemPrompt
      && x.role === y.role
      && x.bashMode === y.bashMode
      && JSON.stringify(x.allowedSkills) === JSON.stringify(y.allowedSkills)
      && JSON.stringify(x.allowedPlugins) === JSON.stringify(y.allowedPlugins)
      && JSON.stringify(x.allowedWorkspaces) === JSON.stringify(y.allowedWorkspaces);
  });
}
