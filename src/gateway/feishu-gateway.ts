import * as realSdk from '@larksuiteoapi/node-sdk';
import { createReadStream, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CardDecision, FeishuAppConfig, GatewayHandlers, IncomingMessage, RejectedMessage } from '../types.js';
import { CONFIG_DIR } from '../config.js';
import { buildImageCard, buildTextCard } from './card-builder.js';
import { isImageFile } from '../util/file-types.js';

/**
 * 消息卡通道不支持的 cardkit 专属属性：im.message.create / im.message.patch 的卡片 JSON
 * 校验对它们报 230099/200621 "unknown property"（2026-09-19 真机实锤 multiline 与
 * disabled_reason 两例），而 cardkit 实体卡通道（sendCardEntity / batch_update）正常接受。
 * rows 为 multiline 配套属性一并剥离；disabled 状态本身消息卡 2.0 通用，保留。
 */
const MESSAGE_CHANNEL_UNSUPPORTED_PROPS = new Set(['multiline', 'rows', 'disabled_reason']);

/**
 * 递归剥离消息卡通道不支持的属性（深拷贝返回，不改动入参）。
 * 在 sendCard / updateCard 入口统一调用：进度卡降级路径（cardkit 不可用 → 整卡
 * create/PATCH）与任何误带 cardkit 专属属性走消息通道的新卡在此免疫。
 * 卡片体量 <30KB、调用频度秒级，深拷贝开销可忽略。
 */
function stripMessageChannelUnsupportedProps(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripMessageChannelUnsupportedProps);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!MESSAGE_CHANNEL_UNSUPPORTED_PROPS.has(key)) out[key] = stripMessageChannelUnsupportedProps(value);
    }
    return out;
  }
  return node;
}

/** SDK 形状：仅用到 WSClient/EventDispatcher/Client/Domain 四个导出，测试注入假对象时按此约束 */
export interface FeishuSdk {
  WSClient: new (params: { appId: string; appSecret?: string; domain?: unknown; loggerLevel?: number }) => {
    start(params: { eventDispatcher: unknown }): Promise<void>;
    /** 优雅关闭长连接（node-sdk 1.73.0 已实现：终止重连循环并关 socket） */
    close(params?: { force?: boolean }): void;
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
        delete(payload: { path: { message_id: string } }):
          Promise<{ code?: number; msg?: string }>;
      };
      image: { create(payload: { data: { image_type: 'message'; image: NodeJS.ReadableStream } }): Promise<{ image_key?: string } | null> };
      file: { create(payload: { data: { file_type: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'; file_name: string; file: NodeJS.ReadableStream } }): Promise<{ file_key?: string } | null> };
      // 下载消息内嵌资源（图片）：SDK 1.73.0 返回带 writeFile 落盘便捷方法
      messageResource: {
        get(payload: { params: { type: string }; path: { message_id: string; file_key: string } }): Promise<{
          writeFile(filePath: string): Promise<unknown>;
          getReadableStream(): NodeJS.ReadableStream;
          headers: unknown;
        }>;
      };
    };
  // 通用请求口（SDK 1.73.0 未封装 bot info 接口，经此调 GET /open-apis/bot/v3/info 拿机器人 open_id）。
  // 实际实现接受 params/data/headers/path（详见 SDK Client.request 签名），但本接口只暴露实际用到的部分——
  // #5 回复链上游消息拉取、cardkit 卡片实体 CRUD 均走同一入口
  request(payload: { method: string; url: string; params?: Record<string, unknown>; data?: unknown }):
      Promise<{ code?: number; msg?: string; bot?: { open_id?: string }; data?: Record<string, unknown> }>;
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
    /** 父消息 ID（用户回复时存在；#5 据此拉取上游消息文本拼进 prompt） */
    parent_id?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string } }>;
  };
  sender?: { sender_id?: { open_id?: string } };
}

/** post 富文本节点（拍平时只取关心的 tag，其余跳过） */
interface PostNode { tag?: string; text?: string; href?: string; image_key?: string; file_key?: string }

/**
 * post 富文本拍平为纯文本 + 图片 key 列表 + 文件列表：
 * text→text 字段、a→[text](href)、img→收集 image_key、at 及其他 tag→跳过；
 * title 非空作首行，行间 \n 连接（保留多行结构）。content 非法返回 null。
 * 文件两种形态均提取：① 新版客户端「文字+文件」混发——文件在顶层 files 数组（content
 * 节点里只有文字，实测 2026-09）；② 旧客户端——content 内 media 节点（无 file_name 兜底 file）。
 * is_folder 文件夹项跳过（不可经消息资源接口下载）。
 */
function flattenPost(rawContent: string): { text: string; imageKeys: string[]; files: Array<{ fileKey: string; fileName: string }> } | null {
  try {
    const post = JSON.parse(rawContent) as {
      title?: string; content?: PostNode[][];
      files?: Array<{ file_key?: string; file_name?: string; is_folder?: boolean }>;
    };
    if (!Array.isArray(post.content)) return null;
    const imageKeys: string[] = [];
    const files: Array<{ fileKey: string; fileName: string }> = [];
    const lines: string[] = [];
    if (typeof post.title === 'string' && post.title.trim()) lines.push(post.title);
    for (const line of post.content) {
      if (!Array.isArray(line)) continue;
      const parts: string[] = [];
      for (const node of line) {
        if (node?.tag === 'text' && node.text) parts.push(node.text);
        else if (node?.tag === 'a' && node.text) parts.push(node.href ? `[${node.text}](${node.href})` : node.text);
        else if (node?.tag === 'img' && node.image_key) imageKeys.push(node.image_key);
        else if (node?.tag === 'media' && node.file_key) files.push({ fileKey: node.file_key, fileName: 'file' });
      }
      lines.push(parts.join(''));
    }
    for (const f of post.files ?? []) {
      if (f?.file_key && !f.is_folder) files.push({ fileKey: f.file_key, fileName: f.file_name?.trim() || 'file' });
    }
    return { text: lines.join('\n'), imageKeys, files };
  } catch {
    return null;
  }
}

/**
 * 解析 im.message.receive_v1 事件为 IncomingMessage。
 *
 * 支持的消息类型：text（纯文本，含手打多行）、post（富文本——粘贴带格式内容会被客户端编码为
 * 此类型，拍平为多行纯文本并提取内嵌图片；新版客户端「文字+文件」混发也编码为此类型，
 * 文件在顶层 files 数组）、image（纯图片，提取 image_key 供 gateway 下载）、file（纯文件，
 * 提取 file_key/file_name 供 gateway 下载）。
 * 其余类型（audio/media/video 等）：p2p 返回 RejectedMessage 供上层回提示（不再静默蒸发），
 * 群聊保持 null 静默（@ 判定对非常规类型无法可靠进行）。
 *
 * 群聊 @检测：botOpenId（机器人 open_id）可用时按 mentions 数组精确匹配——
 * 占位符/mentions 非空无法区分 @机器人 vs @普通人（群里 @任何人都命中，会被误当任务执行）；
 * botOpenId 缺失（获取失败/未提供）时退化为旧的占位符 + mentions 非空判定，
 * 但 strictGroupMention=true（多机器人部署）时宁丢不猜——同群多机器人下占位符退化判定
 * 会让每个机器人都被触发（重复执行），丢弃比误执行安全；p2p 不依赖 @ 检测不受影响。
 *
 * ⚠️ 数据结构说明（与 brief 参考实现不同）：node-sdk 的 EventDispatcher 回调收到的是
 * RequestHandle.parse() 展平后的数据——v2 事件 {schema, header, event} 被解包为
 * 顶层 {...header, ...event}，即顶层 {sender, message}；而非 {event: {message, sender}}。
 * 本函数以展平结构为主，同时兼容 {event: {...}} 包裹形态（原始事件体直投）。
 * 结构不合法一律返回 null，绝不抛异常。
 */
export function parseIncomingMessage(event: unknown, botOpenId?: string, opts: { strictGroupMention?: boolean } = {}): IncomingMessage | RejectedMessage | null {
  try {
    if (event === null || typeof event !== 'object') return null;
    const raw = event as { event?: RawMessagePayload } & RawMessagePayload;
    const payload = raw.message || raw.sender ? raw : raw.event;
    const m = payload?.message;
    if (!m?.chat_id || !m.message_id || !m.message_type) return null;
    let text = '';
    let imageKeys: string[] = [];
    let files: Array<{ fileKey: string; fileName: string }> = [];
    if (m.message_type === 'text') {
      text = (JSON.parse(m.content ?? '{}') as { text?: string }).text ?? '';
    } else if (m.message_type === 'post') {
      const flat = flattenPost(m.content ?? '{}');
      if (!flat) return null;
      text = flat.text;
      imageKeys = flat.imageKeys;
      files = flat.files;
    } else if (m.message_type === 'image') {
      const key = (JSON.parse(m.content ?? '{}') as { image_key?: string }).image_key;
      if (key) imageKeys.push(key);
    } else if (m.message_type === 'file') {
      const f = JSON.parse(m.content ?? '{}') as { file_key?: string; file_name?: string };
      if (f.file_key) files.push({ fileKey: f.file_key, fileName: f.file_name?.trim() || 'file' });
    } else {
      return m.chat_type === 'p2p'
        ? { rejected: { kind: 'unsupported-type', chatId: m.chat_id, chatType: 'p2p', messageType: m.message_type } }
        : null;
    }
    if (!text.trim() && imageKeys.length === 0 && files.length === 0) return null;
    const isGroup = m.chat_type !== 'p2p';
    if (isGroup) {
      if (botOpenId) {
        // 精确判定：mentions 中存在 open_id === 机器人 open_id 的条目才算 @机器人
        const mentionsBot = (m.mentions ?? []).some((t) => t.id?.open_id === botOpenId);
        if (!mentionsBot) return null;
      } else if (opts.strictGroupMention) {
        // 严格模式：无法精确判定 @ 目标时直接丢弃（多机器人同群防双触发）
        return null;
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
      ...(m.parent_id ? { parentId: m.parent_id } : {}),
      ...(imageKeys.length > 0 ? { imageKeys } : {}),
      ...(files.length > 0 ? { files } : {}),
    };
  } catch {
    return null;
  }
}

interface RawCardActionPayload {
  action?: {
    value?: { requestId?: string; decision?: string; feedback?: string; qIndex?: number; option?: string; ws?: string };
    // 卡片 form 容器提交时回传的全部输入项（name → 值）：plan 表单的 feedback、
    // qa 表单的 custom_N；不同飞书客户端/版本落点可能是 form_value 或并入 value，两处兜底
    form_value?: Record<string, unknown>;
  };
  operator?: { open_id?: string };
  // v2 卡片回调中 message/chat id 嵌套在 context 下；顶层 open_message_id 为兜底
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
}

const VALID_DECISIONS: ReadonlySet<string> = new Set([
  'allow', 'deny', 'allow-session',
  'plan-approve', 'plan-revise', 'plan-reject', 'plan-view-file',
  'qa-pick', 'qa-submit',
  'ws-switch',
  // legacy：结论尾卡（1.3.0 起）已无「确认方案/按意见修改」按钮，仅为升级前发出的旧卡
  // 迟到点击能落到孤儿卡 toast（而非静默无响应）保留解析，勿在新卡使用
  'output-confirm', 'output-revise',
]);

/** 解析 card.action.trigger 回调；不完整或 decision 不在合法枚举内返回 null */
function parseCardAction(data: unknown): { value: { requestId: string; decision: CardDecision; feedback?: string; qIndex?: number; option?: string; formValue?: Record<string, string> }; operatorId: string; openMessageId: string } | null {
  try {
    if (data === null || typeof data !== 'object') return null;
    const d = data as RawCardActionPayload;
    const value = d.action?.value;
    // decision 必须严格匹配枚举：畸形字符串（如 'ALLOW'）不能流入 CardActionValue.decision
    if (!value?.requestId || typeof value.decision !== 'string' || !VALID_DECISIONS.has(value.decision) || !d.operator?.open_id) return null;
    // form 容器提交的全部输入项整体透传（0.20.0 泛化）：qa_form 的 custom_N 自定义答案、
    // plan_form 的 feedback 均由 wiring 按 name 取用；仅收集字符串值
    const rawForm = d.action?.form_value;
    const formValue = rawForm && typeof rawForm === 'object'
      ? Object.fromEntries(Object.entries(rawForm).filter(([, v]) => typeof v === 'string' && v !== '') as [string, string][])
      : undefined;
    // 修改意见：按钮自带 value.feedback 优先，其次表单输入 form_value.feedback
    const fromValue = typeof value.feedback === 'string' && value.feedback ? value.feedback : undefined;
    const feedback = fromValue ?? formValue?.feedback;
    // 提问卡选项透传（qa-pick 依赖 qIndex/option 定位选项；qa-submit 不带）
    const qIndex = typeof value.qIndex === 'number' ? value.qIndex : undefined;
    const option = typeof value.option === 'string' ? value.option : undefined;
    // /ws 工作区卡切换按钮透传的目标工作区名
    const ws = typeof value.ws === 'string' && value.ws ? value.ws : undefined;
    return {
      value: {
        requestId: value.requestId,
        decision: value.decision as CardDecision,
        ...(feedback ? { feedback } : {}),
        ...(qIndex !== undefined ? { qIndex } : {}),
        ...(option ? { option } : {}),
        ...(formValue && Object.keys(formValue).length > 0 ? { formValue } : {}),
        ...(ws ? { ws } : {}),
      },
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
  private ws?: InstanceType<FeishuSdk['WSClient']>;
  private log: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  private strictGroupMention: boolean;
  /** 入站图片落盘目录（默认 ~/.lark-claudecode-bridge/inbox/，测试可注入临时目录） */
  private inboxDir: string;
  /** 卡片宽度 getter：wiring 注入 config.card.width 闭包（reloader 原地 mutate 同一 config
   *  对象，getter 每次发卡现读 → 热生效）。sendText/sendImage 的文本卡与图片卡都消费它，
   *  进度卡/长回复卡由 wiring 直接传参（同一 config 源）。缺省 default 与旧行为一致 */
  private cardWidth: () => 'default' | 'fill';
  // 入站消息去重：飞书 WS 长连接 at-least-once 投递，重连窗口内同一消息可能重投——
  // 不去重会导致整个任务跑两遍（两张进度卡 + 两条结果）。Map 迭代序即插入序，容量超限删最旧。
  private seenMessageIds = new Map<string, number>();
  private static readonly SEEN_MAX = 1000;

  constructor(
    cfg: FeishuAppConfig,
    deps: {
      sdk?: FeishuSdk;
      /** 日志出口（多 app 部署时注入带 [app:name] 前缀的 logger 以区分机器人） */
      log?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
      /** 严格群聊 @ 模式：botOpenId 不可用时丢弃群消息而非退化猜测（多机器人同群防双触发） */
      strictGroupMention?: boolean;
      /** 入站图片下载目录，缺省 CONFIG_DIR/inbox */
      inboxDir?: string;
      /** 卡片宽度 getter（config.card.width），缺省恒 default */
      cardWidth?: () => 'default' | 'fill';
    } = {},
  ) {
    this.cfg = cfg;
    this.sdk = deps.sdk ?? (realSdk as unknown as FeishuSdk);
    const tag = `[gateway:${cfg.name ?? cfg.appId}]`;
    this.log = deps.log ?? {
      warn: (...a: unknown[]) => console.warn(tag, ...a),
      error: (...a: unknown[]) => console.error(tag, ...a),
    };
    this.strictGroupMention = deps.strictGroupMention ?? false;
    this.inboxDir = deps.inboxDir ?? join(CONFIG_DIR, 'inbox');
    this.cardWidth = deps.cardWidth ?? (() => 'default');
    const domain = cfg.domain === 'lark' ? this.sdk.Domain.Lark : this.sdk.Domain.Feishu;
    this.client = new this.sdk.Client({ appId: cfg.appId, appSecret: cfg.appSecret, domain });
  }

  /**
   * 拉取机器人 open_id：群聊 @检测的精确匹配依据。
   * SDK 1.73.0 未封装「获取机器人信息」接口（bot 命名空间仅 v4.bot.search），
   * 经通用 request() 调 GET /open-apis/bot/v3/info。失败不阻断启动，
   * 仅 warn 一次并让群聊 @检测退化为占位符匹配（严格模式下群消息将被丢弃）。
   */
  private async fetchBotOpenId(): Promise<string | undefined> {
    try {
      const res = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
      const openId = res?.bot?.open_id;
      if (openId) return openId;
      this.log.warn(`机器人信息未返回 open_id：${JSON.stringify(res)}，群聊 @检测${this.strictGroupMention ? '严格模式：群消息将被丢弃' : '退化为占位符匹配'}`);
    } catch (e) {
      this.log.warn('获取机器人 open_id 失败（不影响启动），群聊 @检测' + (this.strictGroupMention ? '严格模式：群消息将被丢弃' : '退化为占位符匹配') + '：', e);
    }
    return undefined;
  }

  /** 记录 messageId 并返回是否首次出现（true=新消息，false=重复投递应忽略） */
  private markSeen(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return false;
    this.seenMessageIds.set(messageId, Date.now());
    if (this.seenMessageIds.size > FeishuGateway.SEEN_MAX) {
      const oldest = this.seenMessageIds.keys().next().value;
      if (oldest !== undefined) this.seenMessageIds.delete(oldest);
    }
    return true;
  }

  /** 响应头 content-type → 图片扩展名（未知兜底 .png） */
  private static extFromHeaders(headers: unknown): string {
    const ct = String((headers as Record<string, unknown> | undefined | null)?.['content-type'] ?? '');
    if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
    if (ct.includes('gif')) return '.gif';
    if (ct.includes('webp')) return '.webp';
    return '.png';
  }

  /** 清洗文件名：替换 Windows 路径非法字符（\/:*?"<>|）与控制符为 _，清洗后为空兜底 file */
  private static sanitizeFileName(name: string): string {
    const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    return cleaned || 'file';
  }

  /**
   * 下载消息内嵌图片到 inbox 目录（文件名 messageId_序号.扩展名）。
   * 单张失败仅 warn 记录、不阻塞其余图片与消息转发（im:resource 权限缺失等场景文字任务照常）。
   */
  private async downloadImages(msg: IncomingMessage): Promise<{ paths: string[]; failures: string[] }> {
    const paths: string[] = [];
    const failures: string[] = [];
    mkdirSync(this.inboxDir, { recursive: true });
    for (let i = 0; i < (msg.imageKeys ?? []).length; i++) {
      const key = msg.imageKeys![i];
      try {
        const res = await this.client.im.messageResource.get({
          path: { message_id: msg.messageId, file_key: key },
          params: { type: 'image' },
        });
        const filePath = join(this.inboxDir, `${msg.messageId}_${i + 1}${FeishuGateway.extFromHeaders(res?.headers)}`);
        await res.writeFile(filePath);
        paths.push(filePath);
      } catch (e) {
        this.log.warn(`[图片] 下载失败（${key}）：`, e);
        failures.push(key);
      }
    }
    return { paths, failures };
  }

  /**
   * 下载消息附件文件到 inbox 目录（文件名 messageId_序号_原始文件名，原始名经 sanitize 清洗，
   * 保留原名便于 Claude Code 识别内容；file 资源响应头 content-type 为 octet-stream，扩展名取自原始名）。
   * 单个失败仅 warn 记录、不阻塞消息转发（与图片一致；飞书资源下载接口单文件上限 100MB，超限报错）。
   */
  private async downloadFiles(msg: IncomingMessage): Promise<{ paths: string[]; failures: string[] }> {
    const paths: string[] = [];
    const failures: string[] = [];
    mkdirSync(this.inboxDir, { recursive: true });
    for (let i = 0; i < (msg.files ?? []).length; i++) {
      const f = msg.files![i];
      try {
        const res = await this.client.im.messageResource.get({
          path: { message_id: msg.messageId, file_key: f.fileKey },
          params: { type: 'file' },
        });
        const filePath = join(this.inboxDir, `${msg.messageId}_${i + 1}_${FeishuGateway.sanitizeFileName(f.fileName)}`);
        await res.writeFile(filePath);
        paths.push(filePath);
      } catch (e) {
        this.log.warn(`[文件] 下载失败（${f.fileName}）：`, e);
        failures.push(f.fileName);
      }
    }
    return { paths, failures };
  }

  /**
   * 拉取回复链上游消息文本（#5）：用户回复某条消息时把上游最多 3 条消息文本一并拼进 prompt。
   * SDK 1.73.0 未封装 im.message.get（只有 list/create/patch/delete），经 Client.request 调
   * GET /open-apis/im/v1/messages/:message_id。失败仅 warn，不阻断主消息流（拉不到时降级为只发当前消息）
   */
  private async fetchUpstreamChain(parentId: string, maxDepth = 3): Promise<string[]> {
    const out: string[] = [];
    const visited = new Set<string>();
    let cur: string | undefined = parentId;
    for (let depth = 0; depth < maxDepth && cur && !visited.has(cur); depth++) {
      visited.add(cur);
      try {
        const res = await this.client.request({
          method: 'GET',
          url: `/open-apis/im/v1/messages/${cur}`,
          params: { user_id_type: 'open_id' },
        });
        const items = (res as { data?: { items?: unknown[] } }).data?.items;
        const msg = Array.isArray(items) && items.length > 0
          ? items[0] as { parent_id?: string; message_type?: string; body?: { content?: string } }
          : null;
        if (!msg) break;
        let text = '';
        if (msg.message_type === 'text') {
          text = (JSON.parse(msg.body?.content ?? '{}') as { text?: string }).text ?? '';
        } else if (msg.message_type === 'post') {
          text = flattenPost(msg.body?.content ?? '{}')?.text ?? '';
        }
        if (text.trim()) out.push(`> [L${depth + 1}] ${text.trim()}`);
        cur = msg.parent_id;
      } catch (e) {
        this.log.warn('[回复链] 拉取上游消息失败', cur, e);
        break;
      }
    }
    return out;
  }

  /** 建立 WS 长连接并注册事件分发（im.message.receive_v1 / card.action.trigger） */
  async start(handlers: GatewayHandlers): Promise<void> {
    const botOpenId = await this.fetchBotOpenId();
    const ws = new this.sdk.WSClient({ appId: this.cfg.appId, appSecret: this.cfg.appSecret });
    this.ws = ws;
    const dispatcher = new this.sdk.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: never) => {
        const parsed = parseIncomingMessage(data, botOpenId, { strictGroupMention: this.strictGroupMention });
        if (parsed && 'rejected' in parsed) {
          // 不支持的消息类型（p2p）：明确反馈而非静默蒸发；提示发送失败不影响主流程
          if (parsed.rejected.chatType === 'p2p') {
            await this.sendText(parsed.rejected.chatId, `🤖 暂不支持该消息类型（${parsed.rejected.messageType}），当前支持：文字、富文本（多行/粘贴）、图片、文件`)
              .catch((e) => this.log.warn('[类型提示] 发送失败：', e));
          }
          return;
        }
        if (parsed && !this.markSeen(parsed.messageId)) {
          this.log.warn('[去重] 忽略重复投递的消息', parsed.messageId);
          return;
        }
        if (parsed) {
          // 图片消息：先下载落盘，再把本地路径注记拼进 text——下游（触发词/命令/执行器/transcript）
          // 对注记形态无感知，Claude Code 侧用 Read 工具读取路径即可看到图片
          if ((parsed.imageKeys?.length ?? 0) > 0) {
            const { paths, failures } = await this.downloadImages(parsed);
            const hasText = parsed.text.trim().length > 0;
            const notes: string[] = [];
            if (paths.length > 0) {
              notes.push(`[用户${hasText ? '随消息' : ''}发送了 ${paths.length} 张图片${hasText ? '' : '（无文字说明）'}，已保存到本地：${paths.join('、')}。需要查看图片内容时用 Read 工具读取这些路径。]`);
            }
            if (failures.length > 0) {
              notes.push(`[另有 ${failures.length} 张图片下载失败（${failures.join('、')}）——如需查看请让用户重发，或检查应用 im:resource 权限。]`);
            }
            parsed.text = hasText ? `${parsed.text}\n\n${notes.join('\n')}` : notes.join('\n');
          }
          // file 消息 / post 内嵌文件：同图片模式下载落盘后注记路径——纯 file 消息无文字
          //（注记即全文）；post 混发时文字在前、注记附后
          if ((parsed.files?.length ?? 0) > 0) {
            const { paths, failures } = await this.downloadFiles(parsed);
            const hasText = parsed.text.trim().length > 0;
            const notes: string[] = [];
            if (paths.length > 0) {
              notes.push(`[用户${hasText ? '随消息' : ''}发送了 ${paths.length} 个文件${hasText ? '' : '（无文字说明）'}，已保存到本地：${paths.join('、')}。需要查看文件内容时用 Read 工具读取这些路径。]`);
            }
            if (failures.length > 0) {
              notes.push(`[另有 ${failures.length} 个文件下载失败（${failures.join('、')}）——单个文件不能超过 100MB，如需处理请压缩或拆分后重发。]`);
            }
            parsed.text = hasText ? `${parsed.text}\n\n${notes.join('\n')}` : notes.join('\n');
          }
          // #5 回复链上游消息：把 parent_id 链路上最多 3 条消息文本拼到 prompt 头部
          if (parsed.parentId) {
            const upstream = await this.fetchUpstreamChain(parsed.parentId);
            if (upstream.length > 0) parsed.text = `${upstream.join('\n\n')}\n\n---\n\n${parsed.text}`;
          }
          await handlers.onMessage(parsed);
        }
      },
      // 卡片回调必须返回对象（飞书 SDK 契约：返回值经 WS 回传，undefined 会被当异常）；
      // handler 返回了响应体（如 toast / 内联换卡 card）则透传，否则返回 {}。
      // 畸形回调（parseCardAction 为 null）有意静默返回 {}：无有效操作对象，弹 toast 无服务意义
      'card.action.trigger': async (data: never) => {
        const action = parseCardAction(data);
        const ret = action ? await handlers.onCardAction(action) : undefined;
        return ret ?? {};
      },
    });
    await ws.start({ eventDispatcher: dispatcher });
  }

  /** 优雅关闭长连接（SIGINT/SIGTERM 时逐个 app 调用）；未 start 时为 no-op */
  close(): void {
    try {
      this.ws?.close();
    } catch {
      // best effort：关闭失败不阻断其余连接的关闭
    }
  }

  /** 发送卡片消息，返回 message_id（消息卡通道：入口剥离 cardkit 专属属性，见 strip 函数注释） */
  async sendCard(chatId: string, card: unknown): Promise<string> {
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(stripMessageChannelUnsupportedProps(card)) },
    });
    if (!res.data?.message_id) throw new Error(`发送卡片失败: ${JSON.stringify(res)}`);
    return res.data.message_id;
  }

  /** 以卡片形态发送 markdown 文本（宽度跟随 cardWidth getter） */
  async sendText(chatId: string, markdown: string): Promise<string> {
    return this.sendCard(chatId, buildTextCard(markdown, this.cardWidth()));
  }

  /** 更新已发送卡片（流式进度刷新；消息卡通道：入口剥离 cardkit 专属属性） */
  async updateCard(messageId: string, card: unknown): Promise<void> {
    await this.client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(stripMessageChannelUnsupportedProps(card)) } });
  }

  /**
   * 创建卡片实体并发送（cardkit 实体模式）：实体卡片支持 batch_update 局部更新——
   * 状态刷新只改指定 element_id 的组件，plan 表单输入框的用户输入不会被心跳刷掉
   * （整卡 PATCH 会重置全部客户端输入态）。需开通 cardkit:card:write 权限；
   * 调用方（ProgressCard.start）捕获失败后自动降级普通卡片 + 整卡 PATCH。
   */
  async sendCardEntity(chatId: string, card: unknown): Promise<{ messageId: string; cardId: string }> {
    const create = await this.client.request({
      method: 'POST', url: '/open-apis/cardkit/v1/cards',
      data: { type: 'card_json', data: JSON.stringify(card) },
    });
    const cardId = (create.data as { card_id?: string } | undefined)?.card_id;
    if (create.code !== 0 || !cardId) throw new Error(`创建卡片实体失败: ${JSON.stringify(create)}`);
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }) },
    });
    if (!res.data?.message_id) throw new Error(`发送卡片实体消息失败: ${JSON.stringify(res)}`);
    return { messageId: res.data.message_id, cardId };
  }

  /** 卡片实体局部更新（batch_update + partial_update_element）：只改 actions 指定组件，其余区域不动 */
  async partialUpdateCardElements(cardId: string, sequence: number, actions: unknown[]): Promise<void> {
    const res = await this.client.request({
      method: 'POST', url: `/open-apis/cardkit/v1/cards/${cardId}/batch_update`,
      data: { actions: JSON.stringify(actions), sequence },
    });
    if (res.code !== 0) throw new Error(`卡片局部更新失败: ${JSON.stringify(res)}`);
  }

  /** 卡片实体全量替换（结构变化：交互区增删/终态/选中态），data 为新卡片 JSON。
   *  ⚠️ 更新口请求体形状与创建口不同：创建（POST /cards）是顶层 {type,data}，
   *  更新（PUT /cards/:id）须把 {type,data} 嵌套在 card 字段下、sequence 同级——
   *  发创建式字段会被飞书直接 400（card is required），所有结构变化（confirm/plan/
   *  question 区、终态）都渲染不上屏，且结构签名不变回来前连计时局部更新也一并停摆 */
  async replaceCardEntity(cardId: string, sequence: number, card: unknown): Promise<void> {
    const res = await this.client.request({
      method: 'PUT', url: `/open-apis/cardkit/v1/cards/${cardId}`,
      data: { card: { type: 'card_json', data: JSON.stringify(card) }, sequence },
    });
    if (res.code !== 0) throw new Error(`卡片全量更新失败: ${JSON.stringify(res)}`);
  }

  /** 撤回消息（进度卡沉底用：删旧卡后重发，保持进度卡始终在会话最底部） */
  async deleteCard(messageId: string): Promise<void> {
    await this.client.im.message.delete({ path: { message_id: messageId } });
  }

  /**
   * 上传图片并发送带 caption 的卡片（caption 显示在图片上方，逐张发图带编号说明用）。
   * 卡片形态发送失败时降级为「caption 文本卡 + 纯图片消息」两条，保证图片必达
   * （img 卡片元素对 message 型 image_key 的兼容性异常兜底）。
   */
  async sendImage(chatId: string, filePath: string, caption?: string): Promise<string> {
    const up = await this.client.im.image.create({
      data: { image_type: 'message', image: createReadStream(filePath) },
    });
    const imageKey = up?.image_key;
    if (!imageKey) throw new Error(`上传图片失败: ${JSON.stringify(up)}`);
    try {
      return await this.sendCard(chatId, buildImageCard(caption, imageKey, this.cardWidth()));
    } catch (e) {
      this.log.warn('图片卡片发送失败，降级为说明文本 + 图片消息两条：', e);
      if (caption) await this.sendText(chatId, caption).catch(() => {});
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
      });
      if (!res.data?.message_id) throw new Error(`发送图片消息失败: ${JSON.stringify(res)}`);
      return res.data.message_id;
    }
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
    if (isImageFile(filePath)) {
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
