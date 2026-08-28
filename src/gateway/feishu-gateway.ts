import * as realSdk from '@larksuiteoapi/node-sdk';
import { createReadStream } from 'node:fs';
import { extname, basename } from 'node:path';
import type { FeishuAppConfig, GatewayHandlers, IncomingMessage } from '../types.js';
import { buildTextCard } from './card-builder.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** SDK 形状：仅用到 WSClient/EventDispatcher/Client/Domain 四个导出，测试注入假对象时按此约束 */
export interface FeishuSdk {
  WSClient: new (params: { appId: string; appSecret?: string; domain?: unknown; loggerLevel?: number }) => {
    start(params: { eventDispatcher: unknown }): Promise<void>;
  };
  EventDispatcher: new (params: Record<string, never>) => {
    register<T extends Record<string, (data: never) => unknown>>(handles: T): unknown;
  };
  Client: new (params: { appId: string; appSecret?: string; domain?: unknown; loggerLevel?: number }) => {
    im: {
      message: {
        create(payload: { params: { receive_id_type: 'chat_id' }; data: { receive_id: string; msg_type: string; content: string } }):
          Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
        patch(payload: { path: { message_id: string }; data: { content: string } }):
          Promise<{ code?: number; msg?: string }>;
      };
      image: { create(payload: { data: { image_type: 'message'; image: NodeJS.ReadableStream } }): Promise<{ image_key?: string } | null> };
      file: { create(payload: { data: { file_type: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'; file_name: string; file: NodeJS.ReadableStream } }): Promise<{ file_key?: string } | null> };
    };
    // 通用请求口（SDK 1.73.0 未封装 bot info 接口，经此调 GET /open-apis/bot/v3/info 拿机器人 open_id）
    request(payload: { method: string; url: string }):
      Promise<{ code?: number; msg?: string; bot?: { open_id?: string } }>;
  };
  Domain: { Feishu: unknown; Lark: unknown };
}

/** 去 @机器人 前缀（飞书群聊 @ 在文本中渲染为 @_user_N 占位） */
export function stripMention(text: string): string {
  return text.replace(/@_user_\d+\s*/g, '').trim();
}

interface RawMessagePayload {
  message?: {
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    message_id?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string } }>;
  };
  sender?: { sender_id?: { open_id?: string } };
}

/**
 * 解析 im.message.receive_v1 事件为 IncomingMessage。
 *
 * 群聊 @检测：botOpenId（机器人 open_id）可用时按 mentions 数组精确匹配——
 * 占位符/mentions 非空无法区分 @机器人 vs @普通人（群里 @任何人都命中，会被误当任务执行）；
 * botOpenId 缺失（获取失败/未提供）时退化为旧的占位符 + mentions 非空判定。
 *
 * ⚠️ 数据结构说明（与 brief 参考实现不同）：node-sdk 的 EventDispatcher 回调收到的是
 * RequestHandle.parse() 展平后的数据——v2 事件 {schema, header, event} 被解包为
 * 顶层 {...header, ...event}，即顶层 {sender, message}；而非 {event: {message, sender}}。
 * 本函数以展平结构为主，同时兼容 {event: {...}} 包裹形态（原始事件体直投）。
 * 结构不合法一律返回 null，绝不抛异常。
 */
export function parseIncomingMessage(event: unknown, botOpenId?: string): IncomingMessage | null {
  try {
    if (event === null || typeof event !== 'object') return null;
    const raw = event as { event?: RawMessagePayload } & RawMessagePayload;
    const payload = raw.message || raw.sender ? raw : raw.event;
    const m = payload?.message;
    if (!m?.chat_id || !m.message_id || m.message_type !== 'text') return null;
    const text = (JSON.parse(m.content ?? '{}') as { text?: string }).text ?? '';
    if (!text.trim()) return null;
    const isGroup = m.chat_type !== 'p2p';
    if (isGroup) {
      if (botOpenId) {
        // 精确判定：mentions 中存在 open_id === 机器人 open_id 的条目才算 @机器人
        const mentionsBot = (m.mentions ?? []).some((t) => t.id?.open_id === botOpenId);
        if (!mentionsBot) return null;
      } else {
        // 退化判定：文本里渲染为 @_user_N 占位；mentions 数组兜底
        //（部分客户端形态下占位符缺失但 mentions 存在）
        const mentionedInText = /@_user_\d+/.test(text);
        const hasMention = mentionedInText || (m.mentions?.length ?? 0) > 0;
        if (!hasMention) return null;
      }
    }
    const userId = payload?.sender?.sender_id?.open_id;
    if (!userId) return null;
    return {
      chatId: m.chat_id,
      chatType: isGroup ? 'group' : 'p2p',
      userId,
      text: stripMention(text),
      messageId: m.message_id,
    };
  } catch {
    return null;
  }
}

interface RawCardActionPayload {
  action?: { value?: { requestId?: string; decision?: 'allow' | 'deny' | 'allow-session' } };
  operator?: { open_id?: string };
  // v2 卡片回调中 message/chat id 嵌套在 context 下；顶层 open_message_id 为兜底
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
}

const VALID_DECISIONS: ReadonlySet<string> = new Set(['allow', 'deny', 'allow-session']);

/** 解析 card.action.trigger 回调；不完整或 decision 不在合法枚举内返回 null */
function parseCardAction(data: unknown): { value: { requestId: string; decision: 'allow' | 'deny' | 'allow-session' }; operatorId: string; openMessageId: string } | null {
  try {
    if (data === null || typeof data !== 'object') return null;
    const d = data as RawCardActionPayload;
    const value = d.action?.value;
    // decision 必须严格匹配枚举：畸形字符串（如 'ALLOW'）不能流入 CardActionValue.decision
    if (!value?.requestId || typeof value.decision !== 'string' || !VALID_DECISIONS.has(value.decision) || !d.operator?.open_id) return null;
    return {
      value: { requestId: value.requestId, decision: value.decision },
      operatorId: d.operator.open_id,
      openMessageId: d.context?.open_message_id ?? d.open_message_id ?? '',
    };
  } catch {
    return null;
  }
}

export class FeishuGateway {
  private client: InstanceType<FeishuSdk['Client']>;
  private sdk: FeishuSdk;
  private cfg: FeishuAppConfig;

  constructor(cfg: FeishuAppConfig, deps: { sdk?: FeishuSdk } = {}) {
    this.cfg = cfg;
    this.sdk = deps.sdk ?? (realSdk as unknown as FeishuSdk);
    const domain = cfg.domain === 'lark' ? this.sdk.Domain.Lark : this.sdk.Domain.Feishu;
    this.client = new this.sdk.Client({ appId: cfg.appId, appSecret: cfg.appSecret, domain });
  }

  /**
   * 拉取机器人 open_id：群聊 @检测的精确匹配依据。
   * SDK 1.73.0 未封装「获取机器人信息」接口（bot 命名空间仅 v4.bot.search），
   * 经通用 request() 调 GET /open-apis/bot/v3/info。失败不阻断启动，
   * 仅 warn 一次并让群聊 @检测退化为占位符匹配。
   */
  private async fetchBotOpenId(): Promise<string | undefined> {
    try {
      const res = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
      const openId = res?.bot?.open_id;
      if (openId) return openId;
      console.warn(`[gateway] 机器人信息未返回 open_id：${JSON.stringify(res)}，群聊 @检测退化为占位符匹配`);
    } catch (e) {
      console.warn('[gateway] 获取机器人 open_id 失败（不影响启动），群聊 @检测退化为占位符匹配：', e);
    }
    return undefined;
  }

  /** 建立 WS 长连接并注册事件分发（im.message.receive_v1 / card.action.trigger） */
  async start(handlers: GatewayHandlers): Promise<void> {
    const botOpenId = await this.fetchBotOpenId();
    const ws = new this.sdk.WSClient({ appId: this.cfg.appId, appSecret: this.cfg.appSecret });
    const dispatcher = new this.sdk.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: never) => {
        const msg = parseIncomingMessage(data, botOpenId);
        if (msg) await handlers.onMessage(msg);
      },
      // 卡片回调必须返回对象（飞书 SDK 契约：返回值经 WS 回传，undefined 会被当异常）；
      // handler 返回了响应体（如非发起人点击的 toast）则透传，否则返回 {}
      'card.action.trigger': async (data: never) => {
        const action = parseCardAction(data);
        const ret = action ? await handlers.onCardAction(action) : undefined;
        return ret ?? {};
      },
    });
    await ws.start({ eventDispatcher: dispatcher });
  }

  /** 发送卡片消息，返回 message_id */
  async sendCard(chatId: string, card: unknown): Promise<string> {
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    if (!res.data?.message_id) throw new Error(`发送卡片失败: ${JSON.stringify(res)}`);
    return res.data.message_id;
  }

  /** 以卡片形态发送 markdown 文本 */
  async sendText(chatId: string, markdown: string): Promise<string> {
    return this.sendCard(chatId, buildTextCard(markdown));
  }

  /** 更新已发送卡片（流式进度刷新） */
  async updateCard(messageId: string, card: unknown): Promise<void> {
    await this.client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
  }

  /**
   * 上传并发送文件：图片扩展名走 im.image.create（返回顶层 image_key），
   * 其余走 im.file.create（返回顶层 file_key）。
   * ⚠️ 与 brief 参考实现不同：这两个上传接口的 SDK 封装比普通接口多拆一层，
   * 返回 {image_key} / {file_key} 顶层对象（或 null），不存在 res.data 包装。
   * 上传与发消息两步都校验关键返回值——SDK 业务级失败（HTTP 200 + code!=0）不抛错，
   * 不校验会静默 resolve，用户收不到文件且无任何报错。
   */
  async uploadAndSendFile(chatId: string, filePath: string): Promise<void> {
    const ext = extname(filePath).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      const up = await this.client.im.image.create({
        data: { image_type: 'message', image: createReadStream(filePath) },
      });
      const imageKey = up?.image_key;
      if (!imageKey) throw new Error(`上传图片失败: ${JSON.stringify(up)}`);
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
      });
      if (!res.data?.message_id) throw new Error(`发送图片消息失败: ${JSON.stringify(res)}`);
    } else {
      const up = await this.client.im.file.create({
        data: { file_type: 'stream', file_name: basename(filePath), file: createReadStream(filePath) },
      });
      const fileKey = up?.file_key;
      if (!fileKey) throw new Error(`上传文件失败: ${JSON.stringify(up)}`);
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
      });
      if (!res.data?.message_id) throw new Error(`发送文件消息失败: ${JSON.stringify(res)}`);
    }
  }
}
