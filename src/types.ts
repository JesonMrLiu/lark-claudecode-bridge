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
  /** 可选人格补充，直通 SDK options.appendSystemPrompt */
  appendSystemPrompt?: string;
  /** Claude Code 数据目录（会话存储/用户设置/插件，每个机器人一套）：
   *  apps 里新配置的 app 缺省 <CONFIG_DIR>/claude/<appId>；旧 feishu 迁移的 app 沿用系统默认 ~/.claude（保存量会话 resume） */
  claudeConfigDir?: string;
  /** per-app 环境变量（如 ANTHROPIC_BASE_URL/ANTHROPIC_MODEL 凭证差异化），合并进 Claude Code 子进程环境 */
  env?: Record<string, string>;
  /** 触发词映射：按数组顺序首个命中生效；不配置 = 行为零变化。match 以 / 开头=首 token 精确匹配，否则=关键词包含 */
  triggers?: TriggerRule[];
  /** 显式加载的本地插件目录列表（SDK 单次 query 不会展开斜杠命令，技能须经改写指令触发；插件目录须含 .claude-plugin/plugin.json） */
  plugins?: PluginRef[];
}
export interface Workspace { name: string; path: string }
export interface BridgeConfig {
  /** 多飞书应用（多机器人）：每 app 一条独立 WS 长连接 + 独立会话池 + 独立 Claude Code 实例 */
  apps: FeishuAppConfig[];
  workspaces: Workspace[];
  defaults: { workspace: string };
  concurrency: number;
  /** 对话落盘清理策略；缺省/0 = 永久保留 */
  transcripts?: { retentionDays?: number };
}
export interface IncomingMessage {
  chatId: string; chatType: 'p2p' | 'group'; userId: string; text: string; messageId: string;
}
export interface CardActionValue { requestId: string; decision: 'allow' | 'deny' | 'allow-session' }
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
export interface TaskOutcome { sessionId: string; finalText: string; producedFiles: string[]; turns: number }
