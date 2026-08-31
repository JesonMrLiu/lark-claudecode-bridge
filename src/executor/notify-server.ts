// 进程内通知服务：把「实时发给用户看」的能力以 MCP 工具形式注入 Claude 会话
// （lcb-notify 三件套：send_text / send_image / send_file）。由 executeTask 按任务
// 构造——chatId 在闭包内硬绑定，模型无法选择接收者，只能发到当前任务发起的聊天，
// 因此权限闸对该前缀直通（见 permission-gate.ts）。
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { z } from 'zod';
import { chunkText } from '../util/chunk-text.js';

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
 */
export function createGatewaySender(args: {
  chatId: string;
  sentPaths: Set<string>;
  sendText: (chatId: string, markdown: string) => Promise<unknown>;
  sendImageWithCaption?: (chatId: string, path: string, caption?: string) => Promise<unknown>;
  sendFileTo: (chatId: string, path: string) => Promise<unknown>;
}): NotifySender {
  const { chatId, sentPaths } = args;
  return {
    sendText: async (md) => { await args.sendText(chatId, md); },
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
