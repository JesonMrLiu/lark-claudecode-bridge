// src/types.ts 全量内容（本任务一次性写齐）
/** 触发词规则：match 命中后把消息改写为 rewrite 再入队（{text}=原文全文，{args}=去首 token 的剩余参数）；
 *  askDetail=true（配置 ask_detail）为两段式触发：命中先追问补充内容，用户下一条消息与 rewrite
 *  合并后再入队（合并语义：补充内容视作原始消息的参数，占位符替换 / 无占位符追加规则不变） */
export interface TriggerRule { match: string; rewrite: string; askDetail?: boolean }
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
  /** 机器人角色：primary（缺省，主机器人——全技能/全插件/全工作区，配对码准入）；
   *  deputy（分身——按用途限定能力，艾特即用，供他人使用）。存量配置未配 role 行为不变 */
  role?: 'primary' | 'deputy';
  /** 机器人级厂商档案（引用 claude.profiles[].name）：配置后该机器人的认证（token/key/base_url）
   *  与模型改用该档案，未配置/档案不存在时跟随全局。每任务现读解析（热生效，改完下一条消息即生效）；
   *  认证经惰性生成的 per-bot settings 文件以 CLI --settings 参数注入（命令行层优先级最高，
   *  不被生效目录 settings.json 的 env 块压制）；模型经 SDK Options.model（--model）路由 */
  profile?: string;
  /** 档案级模型覆盖：取值应在该档案 models 候选集内（或即档案默认模型）；未配置 = 用档案默认 model。
   *  优先级：通道 /model 命令 > profileModel > 档案 model > 全局 */
  profileModel?: string;
  /** deputy 专用：技能白名单（必填，透传 SDK Options.skills）——未列出的技能对模型不可见
   *  且被 Skill 工具拒绝。注意 SDK 官方语义是「上下文过滤器非沙箱」：技能文件仍在磁盘、
   *  可被 Read/Bash 读到，硬隔离需配合工具级限制（本期按用户决策不做） */
  allowedSkills?: string[];
  /** deputy 专用：插件白名单（可选）——自动发现的插件按 name 过滤，未列出的剔除；
   *  显式 app.plugins 始终保留（开发期直指源码目录的场景） */
  allowedPlugins?: string[];
  /** deputy 专用：工作区锁定（必填）——任务强制运行在首个允许的工作区，/ws 切换被拒 */
  allowedWorkspaces?: string[];
}
/** 工作区：name + path。旧版 type（code-dev/generic）已废弃（#6）——计划模式改为
 *  通道级 /plan 命令切换，diff 收尾改为 git 仓库自动判定；旧配置携带 type 仅 warn 忽略 */
export interface Workspace { name: string; path: string }
/** 权限白名单配置：字段可选——未配置的字段回退内置默认（读工具 + Bash + 危险命令表，见 permission-gate）。
 *  allowTools 配置即整体替换内置默认（不与默认合并）；dangerousCommands 为 Bash 危险命令正则（命中弹确认卡）；
 *  allowAllTools 为「全部工具免确认」开关，缺省开——开启后除命中 dangerousCommands 的 Bash 外一律直通，
 *  关闭则回落 allowTools 白名单语义 */
export interface PermissionsConfig {
  allowTools?: string[];
  dangerousCommands?: RegExp[];
  allowAllTools?: boolean;
}
/** Web 配置页服务器（lcb start / lcb ui 内嵌，node:http 零依赖）：enabled/host/port 均为启动时读取，改动需重启 */
export interface ServerConfig { enabled?: boolean; host?: string; port?: number }
export type ClaudeAuthMode = 'inherit' | 'managed';
/**
 * 多厂商认证档案（Web 配置页「Claude 认证」管理，0.13 起）。档案仅是配置库：
 * 当前生效配置始终是 ClaudeConfig 顶层四字段（写入 settings.json 的就是它），
 * 「设为当前」= 把档案字段拷贝到顶层（互斥凭证同步清理），与 cc-switch 同款切换语义。
 */
export interface ClaudeProfile {
  /** 档案名（显示用，如「官方」「中转站A」「GLM」） */
  name: string;
  /** 与 apiKey 二选一 */
  authToken?: string;
  /** 与 authToken 二选一 */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 候选模型集（fable/opus/sonnet/haiku 等各存一条，页面点选即切换当前模型）；model 仍为「设为当前」时的默认模型 */
  models?: string[];
}
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
  /**
   * managed 模式显式环境变量（写入托管 settings.json 的 env 块，MCP 工具依赖的
   * IMAGE_GEN_* / API_HOST 等自定义变量在此配置）。优先级：本键 > 本机 ~/.claude
   * settings env 自动继承 > 托管目录既有值。认证 4 键（ANTHROPIC_AUTH_TOKEN/API_KEY/
   * BASE_URL/MODEL）不在此生效——永远以认证表单为准（入口过滤，防绕过）。
   */
  env?: Record<string, string>;
  /** 多厂商档案库（不直接生效；Web 页「设为当前」拷贝到顶层） */
  profiles?: ClaudeProfile[];
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
  /** 会话行为微调；缺省 contextRemindTokens 用 config.ts 的内置默认 */
  session?: SessionConfig;
  /** 卡片展示；缺省 width=default（飞书默认宽度） */
  card?: CardConfig;
  /** 开机自启意图记录（整体可选）：仅保存用户的开关选择，实际注册状态以 OS 查询为权威
   *  （概览页 GET /api/autostart 现查 Startup 文件夹/launchd/systemd） */
  autostart?: { enabled?: boolean };
}

/** 卡片展示配置（整体可选） */
export interface CardConfig {
  /** 卡片宽度：default = 飞书默认（与消息等宽留边）；fill = 撑满聊天窗口 */
  width?: 'default' | 'fill';
}

/** 会话行为配置（整体可选） */
export interface SessionConfig {
  /** 上下文超长提醒阈值（tokens，估算口径 = 最后一次 result 的 input+cache 三项之和）。
   *  0 = 关闭提醒；缺省用 DEFAULT_CONTEXT_REMIND_TOKENS（150000） */
  contextRemindTokens?: number;
  /** 飞书推送规范化（#11）：启用时 SOP 提示词注入 appendSystemPrompt（软约束）+ notify-server 硬兜底。缺省 true */
  notifySop?: boolean;
  /** 工具可用性说明注入 appendSystemPrompt（软约束）：对抗 Claude Code 2.1.117+ dynamic tool loading
   *  下模型用 ToolSearch 自查时误判「Read/Write 等核心工具不存在」。缺省 true */
  toolHint?: boolean;
}
export interface IncomingMessage {
  chatId: string; chatType: 'p2p' | 'group'; userId: string; text: string; messageId: string;
  /** image 消息 / post 内嵌图片的 image_key（gateway 下载后把本地路径注记拼进 text，下游不再消费此字段） */
  imageKeys?: string[];
  /** file 消息 / post 混发（顶层 files 数组或 media 节点）的文件标识与原始文件名
   *  （gateway 下载后把本地路径注记拼进 text，下游不再消费此字段） */
  files?: Array<{ fileKey: string; fileName: string }>;
  /** 父消息 ID（用户回复上游消息时存在；#5 据此拉取上游链文本拼进 prompt，最多向上 3 层） */
  parentId?: string;
}
/** parseIncomingMessage 对「明确发给机器人但不支持的消息类型」的拒绝信息（p2p 场景上层回提示；群聊保持静默 null） */
export interface RejectedMessage {
  rejected: { kind: 'unsupported-type'; chatId: string; chatType: 'p2p' | 'group'; messageType: string };
}
/** 卡片回调决策：allow/deny/allow-session 为写工具确认卡；plan-* 为计划确认卡（feedback = 按意见修改时的用户输入）；
 *  plan-view-file = 计划「查看完整方案」按钮触发，原文 md 直接 send_file 而非塞入卡片正文；
 *  qa-* 为提问卡；ws-switch 为工作区切换卡 */
export type CardDecision = 'allow' | 'deny' | 'allow-session'
  | 'plan-approve' | 'plan-revise' | 'plan-reject' | 'plan-view-file'
  | 'qa-pick' | 'qa-submit'
  | 'ws-switch';
export interface CardActionValue {
  requestId: string; decision: CardDecision; feedback?: string;
  /** qa-pick：问题下标与选项 label */
  qIndex?: number; option?: string;
  /** form 容器提交时回传的全部输入项（name → 值）：qa_form 的 custom_N、
   *  plan_form 的 feedback 均在此（0.20.0 泛化，取代只解析 feedback 单键） */
  formValue?: Record<string, string>;
  /** ws-switch：目标工作区名（/ws 工作区卡片的切换按钮） */
  ws?: string;
}
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
/**
 * 执行器 → 进度卡的流事件：
 * - text/tool-start/tool-result/status：主循环输出与状态（tool-result 失败时带首行原因 note）
 * - agent-start/agent-settle：子代理与后台任务生命周期（进度卡子代理清单的数据源）
 */
export type ProgressEvent =
  | { kind: 'text' | 'tool-start' | 'status'; content: string }
  | { kind: 'tool-result'; content: string; ok: boolean; note?: string }
  | { kind: 'agent-start'; agent: { id: string; description: string; type: string } }
  | { kind: 'agent-settle'; id: string; status: 'done' | 'failed' | 'stopped'; summary?: string };

/**
 * SDK init(system/init) 消息提取的会话清单：本会话实际加载到的模型/技能/插件/MCP/斜杠命令。
 * 供 /skills /plugins /mcp /model 命令渲染（实际加载了什么就显示什么，而非配置了什么）。
 */
export interface SessionInventory {
  model: string;
  claudeCodeVersion: string;
  /** 顶层已注册工具清单（init 消息 tools 字段）。dynamic tool loading 下核心工具在顶层、
   *  其余经 ToolSearch 按需加载——本清单是「Claude 自称某工具不存在」误判的诊断依据。
   *  可选：旧快照（inventory 落盘/缓存）无此键 */
  tools?: string[];
  skills: string[];
  slashCommands: string[];
  plugins: Array<{ name: string; version?: string; path: string }>;
  /** mcpServers 状态来源有两类：init 快照（仅 name/status）与任务收尾的 mcpServerStatus() 实时拉取
   *  （另含 failed 的 error、connected 的 tools 清单）——error/tools 为可选以兼容快照形态 */
  mcpServers: Array<{ name: string; status: string; error?: string; tools?: Array<{ name: string }> }>;
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
  /** 最后一次 result 的主循环用量（snake→camel；SDK 缺字段时兜 0）。
   *  inputTokens + cacheCreation + cacheRead ≈ 当前上下文规模，超长提醒的判定口径 */
  usage?: TaskUsage;
}

/** result.usage 的 bridge 侧映射（SDK NonNullableUsage 的子集，全 number） */
export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}
