// 运行中网关的飞书 REST 请求口注册表：web 配置页（chats-api 拉「会话记录」真群名/会话类型）
// 与网关分属两个装配层——web 层只拿得到 appsStarted 的名字/标志，拿不到 gateway 实例。
// 桥内每 app 建 gateway 时把一个最小 request 视图自注册进来（index.ts 装配处），
// web 层按 appId 取用。仅进程内有效：lcb ui 独立进程（桥未运行）查无来源 → chats-api
// 自动降级为本地显示名（access 人名 / 「群聊（N人）」），功能不受影响。
/** 最小飞书 REST 请求视图：只暴露实际用到的 request 形态（GET /open-apis/im/v1/chats/:chat_id） */
export interface FeishuRequester {
  request(payload: { method: string; url: string; params?: Record<string, unknown> }):
    Promise<{ code?: number; msg?: string; data?: Record<string, unknown> }>;
}

const sources = new Map<string, FeishuRequester>();

/** gateway 装配时自注册（同 appId 重注册覆盖——热重载重建 gateway 后指向新实例） */
export function registerChatInfoSource(appId: string, requester: FeishuRequester): void {
  sources.set(appId, requester);
}

/** web 层取某 bot 的请求口；未注册（桥未运行/测试环境）返回 undefined，调用方自行降级 */
export function getChatInfoSource(appId: string): FeishuRequester | undefined {
  return sources.get(appId);
}
