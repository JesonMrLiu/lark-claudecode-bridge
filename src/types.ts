// src/types.ts 全量内容（本任务一次性写齐）
export interface FeishuAppConfig { appId: string; appSecret: string; domain?: 'feishu' | 'lark' }
export interface Workspace { name: string; path: string }
export interface BridgeConfig {
  feishu: FeishuAppConfig;
  workspaces: Workspace[];
  defaults: { workspace: string };
  concurrency: number;
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
