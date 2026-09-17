// 进程内通知服务：把「实时发给用户看」的能力以 MCP 工具形式注入 Claude 会话
// （lcb-notify 三件套：send_text / send_image / send_file）。由 executeTask 按任务
// 构造——chatId 在闭包内硬绑定，模型无法选择接收者，只能发到当前任务发起的聊天，
// 因此权限闸对该前缀直通（见 permission-gate.ts）。
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { chunkText } from '../util/chunk-text.js';
import { CONFIG_DIR } from '../config.js';

// 分块算法已抽到 util/chunk-text（gateway 卡片层复用）；此处 re-export 保持既有引用兼容
export { chunkText };

export const NOTIFY_SERVER_NAME = 'lcb-notify';
/** canUseTool 收到的工具全名形态：mcp__lcb-notify__send_text */
export const NOTIFY_TOOL_PREFIX = `mcp__${NOTIFY_SERVER_NAME}__`;

/** 发送能力抽象：executeTask 闭包内绑定当前任务的 chatId 实现（含降级路径） */
export interface NotifySender {
  sendText(markdown: string): Promise<void>;
  sendImage(path: string, caption?: string): Promise<void>;
  sendFile(path: string, note?: string): Promise<void>;
  /**
   * SOP 降级单文件补发（#7）：任务收尾时调用——降级内容全部追加进同一文件，
   * 首次降级已发过一次（阶段性内容），此后有新追加才在收尾补发完整版。
   * 可选：旧实现/测试 mock 缺省时无降级文件可发，调用方 ?. 调用即可。
   */
  flushDowngradedFile?(): Promise<void>;
}

// 单块/单条失败重试一次的退避间隔（飞书偶发限流 / 网络抖动）
const RETRY_DELAY_MS = 800;

// 与 feishu-gateway 的 IMAGE_EXT 保持同一口径（此处独立声明，避免 executor 反向依赖 gateway）
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带一次重试的发送：第二次失败向上抛，由工具 handler 捕获转为 isError 结果 */
async function sendWithRetry(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    await sleep(RETRY_DELAY_MS);
    await fn();
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 构建工具定义数组。handler 全部捕获异常返回 isError 中文原因，绝不抛出——
 * 模型可感知失败并决定重试，不会炸掉整条 query 流。
 */
export function buildNotifyTools(sender: NotifySender): SdkMcpToolDefinition<any>[] {
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

  // 用 SDK 的 tool() 辅助函数构建：handler 参数类型由 zod schema 推断，无需手写泛型
  return [
    tool('send_text', '向用户实时发送 markdown 文本（自动分块：超长内容拆成多张卡片，每块标注序号 i/N）。用于把生成的文案、说明、结论推给用户查阅。', {
      text: z.string().min(1).describe('要发送的完整文本。必须传全文，不要截断或摘要'),
      title: z.string().optional().describe('可选标题，显示在每块头部，如「文案初稿」「定稿全文」'),
    }, async (args: { text: string; title?: string }) => {
      try {
        const chunks = chunkText(args.text);
        if (!chunks.length) return fail('文本为空白，未发送');
        const title = args.title ?? '消息';
        const failures: number[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const payload = `**${title}（${i + 1}/${chunks.length}）**\n\n${chunks[i]}`;
          try {
            await sendWithRetry(() => sender.sendText(payload));
          } catch {
            failures.push(i + 1);
          }
        }
        if (failures.length) {
          return fail(`已发送 ${chunks.length - failures.length}/${chunks.length} 块，第 ${failures.join('、')} 块失败（可重新发送失败部分）`);
        }
        return ok(`已发送 ${chunks.length} 块文本卡片（${title}）`);
      } catch (e) {
        return fail(`文本发送失败：${errText(e)}`);
      }
    }),
    tool('send_image', '把本地图片文件实时发送给用户，caption 显示在图片上方（如「【图 2/5】02-cover.png｜质检 8.5/10」）。', {
      path: z.string().describe('本地图片文件的绝对路径'),
      caption: z.string().optional().describe('图片说明（编号/文件名/质检分等），展示在图片上方'),
    }, async (args: { path: string; caption?: string }) => {
      const p = resolve(args.path);
      try {
        const st = await stat(p).catch(() => null);
        if (!st?.isFile()) return fail(`文件不存在：${p}`);
        if (!IMAGE_EXT.has(extname(p).toLowerCase())) {
          return fail(`不是图片文件（支持 ${[...IMAGE_EXT].join(' / ')}）：${p}`);
        }
        await sendWithRetry(() => sender.sendImage(p, args.caption));
        return ok(args.caption ? `图片已发送：${basename(p)}（${args.caption}）` : `图片已发送：${basename(p)}`);
      } catch (e) {
        return fail(`图片发送失败：${basename(p)}（${errText(e)}）`);
      }
    }),
    tool('send_file', '把本地文件作为附件实时发送给用户（如 article.md / images-prompt.md），可附一条说明文字。', {
      path: z.string().describe('本地文件的绝对路径'),
      note: z.string().optional().describe('随文件发送的说明文字（飞书文件消息本身不带说明）'),
    }, async (args: { path: string; note?: string }) => {
      const p = resolve(args.path);
      try {
        const st = await stat(p).catch(() => null);
        if (!st?.isFile()) return fail(`文件不存在：${p}`);
        // note 由 sender 实现负责随文件发出（飞书文件消息本身不带说明字段）
        await sendWithRetry(() => sender.sendFile(p, args.note));
        return ok(`文件已发送：${basename(p)}`);
      } catch (e) {
        return fail(`文件发送失败：${basename(p)}（${errText(e)}）`);
      }
    }),
  ];
}

/** 组装为进程内 server 配置：每任务一个实例，随 query 的 Options.mcpServers 注入 */
export function createNotifyServer(sender: NotifySender): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: NOTIFY_SERVER_NAME,
    version: '0.1.0',
    instructions: '内容生产实时推送工具：把文案 / 图片 / 文件即时发给当前对话的用户查阅。发送失败会返回错误信息，可重试；工具仅在飞书桥接环境存在。',
    tools: buildNotifyTools(sender),
    // 工具始终进模型上下文（不被 tool search 延迟加载）——skill / agent 提示词直接引用工具名，必须首轮可见
    alwaysLoad: true,
  });
}

/**
 * 由 gateway 发送能力 + chatId 组装 NotifySender（executeTask 每任务构造）。
 * sendImageWithCaption 可选：缺省（旧 gateway / 测试 mock）时图片降级为
 * 「caption 文本卡 + 图片消息」两条；sentPaths 记录已推送路径供任务收尾去重。
 *
 * sopOptions=#11 SOP 硬兜底配置（仅 sendText 路径生效；图片/附件不强制）：
 *   - enabled=false 时跳过（保留旧行为）
 *   - lineLimit=50：单次 markdown > 50 行 → 追加进单文件 changes-<ts>.md（#7 合并策略：
 *     首次降级提示卡 + 立即发当前文件，后续静默追加，任务收尾 flushDowngradedFile 补发完整版）
 *   - sequentialLimit=4：本任务连续 sendText ≥ 第 4 张起 → 后续 sendText 同样进单文件
 *   计数属于本 sender 闭包，每任务新一次（createGatewaySender 由 executeTask 每任务调一次）
 */
export function createGatewaySender(args: {
  chatId: string;
  sentPaths: Set<string>;
  sendText: (chatId: string, markdown: string) => Promise<unknown>;
  sendImageWithCaption?: (chatId: string, path: string, caption?: string) => Promise<unknown>;
  sendFileTo: (chatId: string, path: string) => Promise<unknown>;
}, sopOptions?: {
  enabled?: boolean;
  lineLimit?: number;
  sequentialLimit?: number;
  notifyDir?: string;
}): NotifySender {
  const { chatId, sentPaths } = args;
  const sopEnabled = sopOptions?.enabled !== false;
  const lineLimit = sopOptions?.lineLimit ?? 50;
  const sequentialLimit = sopOptions?.sequentialLimit ?? 4;
  const notifyDir = sopOptions?.notifyDir ?? join(CONFIG_DIR, 'notify');
  // 顺序计数：递增写入；上限仅作判定，超阈值 → 后续全部走降级
  let textCallCount = 0;
  let downgradedByLines = false;
  // #7 单文件合并：本任务所有降级内容追加进同一文件（旧行为每次降级一个新文件，
  // 用户收到 N 个零散附件）。首次降级立即发一次（长任务也有阶段性内容可看），
  // 之后静默追加；收尾 flushDowngradedFile 有新追加才补发完整版
  let downgradeFilePath: string | undefined;
  let downgradeDirty = false;
  let downgradeSent = false;

  function renderTitle(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  return {
    sendText: async (md) => {
      textCallCount++;
      const lines = md.split('\n').length;
      const overLines = lines > lineLimit;
      const overSequential = textCallCount > sequentialLimit;
      // downgradedByLines 一旦置位，整个任务后续 sendText 全走降级——避免大块持续刷屏；
      // sequentialLimit 则每张都判定（次数远超才逐张转），避免误伤正常 4 张内调用
      if (sopEnabled && (downgradedByLines || overLines || overSequential)) {
        if (overLines) downgradedByLines = true;
        try {
          await mkdir(notifyDir, { recursive: true });
        } catch { /* 极端权限异常：继续走提示卡，但 send_file 会失败由调用方兜底 */ }
        if (!downgradeFilePath) downgradeFilePath = join(notifyDir, `changes-${renderTitle()}.md`);
        try {
          writeFileSync(downgradeFilePath, `${md}\n\n---\n\n`, { flag: 'a' });
          downgradeDirty = true;
        } catch (e) {
          // 落盘失败兜底：跳过降级，按原样 sendText——硬兜底不该把内容吞掉
          console.warn(`[notify-server] SOP 降级落盘失败：${e instanceof Error ? e.message : e}（已按原内容发送）`);
          await args.sendText(chatId, md);
          return;
        }
        if (!downgradeSent) {
          // 首次降级：直接发当前文件（长任务也有阶段性内容可看），静默化——不发提示文案卡；
          // 后续追加同样静默，收尾 flushDowngradedFile 有新内容才补发完整文件
          downgradeSent = true;
          await args.sendFileTo(chatId, downgradeFilePath).catch((e) => {
            console.error('[notify-server] SOP 降级 send_file 失败：', e);
          });
          downgradeDirty = false;
        }
        return;
      }
      await args.sendText(chatId, md);
    },
    // 任务收尾补发：首次降级后又有新追加时才重发完整文件（至多 2 条附件消息，同样静默不发文案）
    flushDowngradedFile: async () => {
      if (!downgradeFilePath || !downgradeDirty) return;
      downgradeDirty = false;
      await args.sendFileTo(chatId, downgradeFilePath).catch((e) => {
        console.error('[notify-server] SOP 收尾补发 send_file 失败：', e);
      });
    },
    sendImage: async (p, caption) => {
      sentPaths.add(resolve(p));
      if (args.sendImageWithCaption) {
        await args.sendImageWithCaption(chatId, p, caption);
        return;
      }
      if (caption) await args.sendText(chatId, caption);
      await args.sendFileTo(chatId, p);
    },
    sendFile: async (p, note) => {
      sentPaths.add(resolve(p));
      if (note) await args.sendText(chatId, note);
      await args.sendFileTo(chatId, p);
    },
  };
}
