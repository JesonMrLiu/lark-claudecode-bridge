// src/types.ts 全量内容（本任务一次性写齐）
/** 触发词规则：match 命中后把消息改写为 rewrite 再入队（{text}=原文全文，{args}=去首 token 的剩余参数） */
export interface TriggerRule { match: string; rewrite: string }
/** 显式加载的本地插件（path 指含 .claude-plugin/plugin.json 的插件目录） */
export interface PluginRef { name: string; path: string }
export interface FeishuAppConfig {
  /** 显示名（日志前缀 / /status / lcb app list），缺省 = appId */
  name: string;
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
  /** 该 app 的默认工作区（须在 workspaces 列表内），缺省回退 defaults.workspace */
  defaultWorkspace?: string;
  /** 该 app 的并发上限（1-100），缺省用全局 concurrency */
  concurrency?: number;
  /** 可选人格补充，直通 SDK options.appendSystemPrompt（多机器人差异化定位的主要手段） */
  appendSystemPrompt?: string;
  /** per-app 环境变量，合并进 Claude Code 子进程环境。
   *  注意：本机 ~/.claude/settings.json 的 env 块会被 CLI 自行应用且优先级更高，
   *  此处适合放 settings.json 里没有的键；模型/认证等已在本机配置的无须重复配 */
  env?: Record<string, string>;
  /** 触发词映射：按数组顺序首个命中生效；不配置 = 行为零变化。match 以 / 开头=首 token 精确匹配，否则=关键词包含 */
  triggers?: TriggerRule[];
  /** 显式加载的本地插件目录列表（插件目录须含 .claude-plugin/plugin.json）。
   *  通常无须配置：~/.claude 已启用的 marketplace 插件由 plugin-discovery 自动加载；
   *  显式配置用于开发期直指源码目录（同名时优先于自动发现） */
  plugins?: PluginRef[];
}
/** 工作区场景类型：code-dev = 代码开发（统一 plan mode + diff 收尾），generic = 通用（缺省） */
export type WorkspaceType = 'code-dev' | 'generic';
export interface Workspace { name: string; path: string; type?: WorkspaceType }
/** 权限白名单配置：字段可选——未配置的字段回退内置默认（读工具 + Bash + 危险命令表，见 permission-gate）。
 *  allowTools 配置即整体替换内置默认（不与默认合并）；dangerousCommands 为 Bash 危险命令正则（命中弹确认卡） */
export interface PermissionsConfig { allowTools?: string[]; dangerousCommands?: RegExp[] }
/** Web 配置页服务器（lcb start / lcb ui 内嵌，node:http 零依赖）：enabled/host/port 均为启动时读取，改动需重启 */
export interface ServerConfig { enabled?: boolean; host?: string; port?: number }
export type ClaudeAuthMode = 'inherit' | 'managed';
/**
 * Claude 认证与模型配置。inherit = 共享本机 ~/.claude（0.4 起默认行为，登录态/settings 全继承）；
 * managed = bridge 自管目录（~/.lark-claudecode-bridge/claude/），authToken/apiKey/baseUrl/model
 * 写入该目录 settings.json 的 env 块——完全摆脱对本机 claude login 的依赖
 */
export interface ClaudeConfig {
  mode?: ClaudeAuthMode;
  /** ANTHROPIC_AUTH_TOKEN（Bearer，中转站常用）；与 apiKey 二选一 */
  authToken?: string;
  /** ANTHROPIC_API_KEY（x-api-key）；与 authToken 二选一 */
  apiKey?: string;
  /** ANTHROPIC_BASE_URL（第三方中转端点；官方 API 留空） */
  baseUrl?: string;
  /** 写 settings.json 顶层 model + env.ANTHROPIC_MODEL */
  model?: string;
}
/** 飞书斜杠命令注册定义（同步到开放平台 app_slash_commands；command 不含 / 前缀） */
export interface SlashCommandDef { command: string; description: string; icon?: string }
/** 斜杠命令同步配置：extra 为用户自定义透传命令（内置命令集见 commands.SLASH_COMMAND_META，始终参与同步） */
export interface SlashCommandsConfig { extra?: SlashCommandDef[] }
export interface BridgeConfig {
  /** 多飞书应用（多机器人）：每 app 一条独立 WS 长连接 + 独立会话池（sessions.<appId>.json）。
   *  全部 app 共享本机 ~/.claude：模型设置/登录态/user MCP/skills/插件统一继承，仅会话池隔离 */
  apps: FeishuAppConfig[];
  workspaces: Workspace[];
  defaults: { workspace: string };
  concurrency: number;
  /** 对话落盘清理策略；缺省/0 = 永久保留 */
  transcripts?: { retentionDays?: number };
  /** 权限白名单；缺省用 permission-gate 的内置默认（读工具 + Bash + 危险命令表） */
  permissions?: PermissionsConfig;
  /** Web 配置页服务器；缺省 enabled=true / 127.0.0.1:17317（随 lcb start 常驻） */
  server?: ServerConfig;
  /** Claude 认证模式；缺省 inherit（共享 ~/.claude） */
  claude?: ClaudeConfig;
  /** 飞书斜杠命令同步；缺省仅内置命令集 */
  slashCommands?: SlashCommandsConfig;
}
export interface IncomingMessage {
  chatId: string; chatType: 'p2p' | 'group'; userId: string; text: string; messageId: string;
  /** image 消息 / post 内嵌图片的 image_key（gateway 下载后把本地路径注记拼进 text，下游不再消费此字段） */
  imageKeys?: string[];
}
/** parseIncomingMessage 对「明确发给机器人但不支持的消息类型」的拒绝信息（p2p 场景上层回提示；群聊保持静默 null） */
export interface RejectedMessage {
  rejected: { kind: 'unsupported-type'; chatId: string; chatType: 'p2p' | 'group'; messageType: string };
}
/** 卡片回调决策：allow/deny/allow-session 为写工具确认卡；plan-* 为计划确认卡（feedback = 按意见修改时的用户输入） */
export type CardDecision = 'allow' | 'deny' | 'allow-session' | 'plan-approve' | 'plan-revise' | 'plan-reject';
export interface CardActionValue { requestId: string; decision: CardDecision; feedback?: string }
export interface CardActionEvent { value: CardActionValue; operatorId: string; openMessageId: string }
/**
 * card.action.trigger 回调的返回体：非空时由 gateway 透传给飞书。
 * toast 为客户端弹窗提示；card 为回调响应内联新卡片，飞书收到响应后同步替换
 * 被点击的卡片（3 秒内响应有效）——仅发起人有效点击路径使用，
 * !pending 等分支严禁携带（此时卡片可能已是结果卡，带卡会把结果卡换回带按钮状态，
 * 等同剥夺发起人操作权，参照 I2 教训）。
 */
export interface CardActionResponse {
  toast?: { type: 'info' | 'success' | 'error' | 'warning'; content: string };
  card?: { type: 'raw'; data: unknown };
}
export interface GatewayHandlers {
  onMessage(msg: IncomingMessage): Promise<void>;
  onCardAction(action: CardActionEvent): Promise<CardActionResponse | void>;
}
export interface ConfirmationRequest {
  requestId: string; toolName: string; summary: string; diff?: string; workspaceName: string;
}
export type PermissionDecision = 'allow' | 'deny' | 'allow-session';
export interface ProgressEvent { kind: 'text' | 'tool-start' | 'tool-result' | 'status'; content: string; ok?: boolean }

/**
 * SDK init(system/init) 消息提取的会话清单：本会话实际加载到的模型/技能/插件/MCP/斜杠命令。
 * 供 /skills /plugins /mcp /model 命令渲染（实际加载了什么就显示什么，而非配置了什么）。
 */
export interface SessionInventory {
  model: string;
  claudeCodeVersion: string;
  skills: string[];
  slashCommands: string[];
  plugins: Array<{ name: string; version?: string; path: string }>;
  mcpServers: Array<{ name: string; status: string }>;
  agents: string[];
  /** 以下为 bridge 侧附加信息（非 SDK 字段） */
  workspace: string;
  loadedAt: string;
}

export interface TaskOutcome {
  sessionId: string;
  finalText: string;
  producedFiles: string[];
  turns: number;
  /** 本任务 init 消息提取的清单（SDK 每 query 只发一次 init；workspace/loadedAt 由 wiring 侧补齐） */
  inventory?: Omit<SessionInventory, 'workspace' | 'loadedAt'>;
}
