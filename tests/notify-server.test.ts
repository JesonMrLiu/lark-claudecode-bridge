import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  NOTIFY_SERVER_NAME, NOTIFY_TOOL_PREFIX, buildNotifyTools, chunkText, createGatewaySender, createNotifyServer,
  type NotifySender,
} from '../src/executor/notify-server.js';

afterEach(() => {
  vi.useRealTimers();
});

/** 记录调用顺序的假 sender（text/image/file 打同一时间线，便于断言先后） */
function makeSender(overrides?: Partial<NotifySender>): { sender: NotifySender; calls: string[] } {
  const calls: string[] = [];
  const sender: NotifySender = {
    sendText: async (md) => { calls.push(`text:${md}`); },
    sendImage: async (p, caption) => { calls.push(`image:${p}|${caption ?? ''}`); },
    sendFile: async (p, note) => { calls.push(`file:${p}|${note ?? ''}`); },
    ...overrides,
  };
  return { sender, calls };
}

function tool(name: string, sender: NotifySender) {
  const t = buildNotifyTools(sender).find((x) => x.name === name);
  if (!t) throw new Error(`工具不存在：${name}`);
  return t;
}

describe('常量', () => {
  it('工具前缀与 server 名一致', () => {
    expect(NOTIFY_SERVER_NAME).toBe('lcb-notify');
    expect(NOTIFY_TOOL_PREFIX).toBe('mcp__lcb-notify__');
  });
});

describe('chunkText', () => {
  it('短文本单块，去首尾空白', () => {
    expect(chunkText('  hello  ')).toEqual(['hello']);
  });
  it('空文本返回空数组', () => {
    expect(chunkText('   \n  ')).toEqual([]);
  });
  it('段落贪心聚合，不超上限尽量同块', () => {
    const paras = ['a'.repeat(1500), 'b'.repeat(1500), 'c'.repeat(100)];
    const chunks = chunkText(paras.join('\n\n'), 3000);
    // a+b 恰好超限（1500+1500+2>3000? 3002>3000 是）→ a 单块，b+c 同块
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('a'.repeat(1500));
    expect(chunks[1].startsWith('b'.repeat(1500))).toBe(true);
  });
  it('单段超长按行聚合，行仍超长硬切', () => {
    // 一个 7000 字符无换行长段：3000 上限 → 硬切成 3 块
    const line = 'x'.repeat(7000);
    const chunks = chunkText(line, 3000);
    expect(chunks).toHaveLength(3);
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(7000);
  });
  it('超长段落内含短行时按行组块', () => {
    const para = ['y'.repeat(2000), 'z'.repeat(2000), 'w'.repeat(100)].join('\n');
    const chunks = chunkText(para, 3000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('y'.repeat(2000));
    expect(chunks[1]).toBe(`${'z'.repeat(2000)}\n${'w'.repeat(100)}`);
  });
});

describe('send_text 工具', () => {
  it('分块发送并带（i/N）序号头', async () => {
    const { sender, calls } = makeSender();
    const text = Array.from({ length: 4 }, (_, i) => `第${i}段\n\n内容`.repeat(200)).join('\n\n');
    const r = await tool('send_text', sender).handler({ text, title: '文案初稿' }, {});
    expect((r as { isError?: boolean }).isError).toBeUndefined();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0].startsWith('text:**文案初稿（1/')).toBe(true);
    expect(calls[1].startsWith('text:**文案初稿（2/')).toBe(true);
  });
  it('空文本返回 isError 不发送', async () => {
    const { sender, calls } = makeSender();
    const r = await tool('send_text', sender).handler({ text: '   ' }, {}) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('单块失败重试一次后成功不报错', async () => {
    const sendText = vi.fn()
      .mockRejectedValueOnce(new Error('限流'))
      .mockResolvedValueOnce(undefined);
    const { sender } = makeSender({ sendText });
    vi.useFakeTimers();
    const p = tool('send_text', sender).handler({ text: 'ok' }, {});
    await vi.advanceTimersByTimeAsync(1000); // 推进 800ms 重试退避
    const r = await p as { isError?: boolean };
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(r.isError).toBeUndefined();
  });
  it('重试仍失败返回 isError 并报失败块序号', async () => {
    const sendText = vi.fn().mockRejectedValue(new Error('限流'));
    const { sender } = makeSender({ sendText });
    vi.useFakeTimers();
    // 两段各 2500 字符：无法同块（2500+2500+2>3000），必然分成 2 块
    const p = tool('send_text', sender).handler({ text: `${'甲'.repeat(2500)}\n\n${'乙'.repeat(2500)}` }, {});
    await vi.advanceTimersByTimeAsync(5000); // 两块各重试一次的退避
    const r = await p as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('1、2');
    expect(sendText).toHaveBeenCalledTimes(4); // 每块 2 次
  });
});

describe('send_image 工具', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('存在且为图片时发送并透传 caption', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lcb-notify-'));
    const img = join(dir, '02-cover.png');
    writeFileSync(img, 'fake');
    const { sender, calls } = makeSender();
    const r = await tool('send_image', sender).handler({ path: img, caption: '【图 2/5】02-cover.png' }, {}) as { isError?: boolean };
    expect(r.isError).toBeUndefined();
    expect(calls).toEqual([`image:${img}|【图 2/5】02-cover.png`]);
  });
  it('文件不存在返回 isError', async () => {
    const { sender, calls } = makeSender();
    const r = await tool('send_image', sender).handler({ path: 'F:/not/exist.png' }, {}) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('文件不存在');
    expect(calls).toHaveLength(0);
  });
  it('非图片扩展名返回 isError', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lcb-notify-'));
    const doc = join(dir, 'article.md');
    writeFileSync(doc, '# hi');
    const { sender } = makeSender();
    const r = await tool('send_image', sender).handler({ path: doc }, {}) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });
});

describe('send_file 工具', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('note 随文件路径一并交给 sender', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lcb-notify-'));
    const doc = join(dir, 'article.md');
    writeFileSync(doc, '# 全文');
    const { sender, calls } = makeSender();
    const r = await tool('send_file', sender).handler({ path: doc, note: '文案初稿' }, {}) as { isError?: boolean };
    expect(r.isError).toBeUndefined();
    expect(calls).toEqual([`file:${doc}|文案初稿`]);
  });
  it('文件不存在返回 isError 不发送', async () => {
    const { sender, calls } = makeSender();
    const r = await tool('send_file', sender).handler({ path: 'F:/not/exist.md' }, {}) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('createNotifyServer', () => {
  it('返回进程内 server 配置形状（type sdk + lcb-notify）', () => {
    const { sender } = makeSender();
    const server = createNotifyServer(sender) as { type: string; name: string; instance: unknown };
    expect(server.type).toBe('sdk');
    expect(server.name).toBe(NOTIFY_SERVER_NAME);
    expect(server.instance).toBeTruthy();
  });
});

describe('createGatewaySender（gateway 能力 + chatId 组装）', () => {
  it('sendImage 走 sendImageWithCaption 并记录 sentPaths', async () => {
    const sentPaths = new Set<string>();
    const sendText = vi.fn();
    const sendImageWithCaption = vi.fn();
    const sendFileTo = vi.fn();
    const sender = createGatewaySender({ chatId: 'oc_1', sentPaths, sendText, sendImageWithCaption, sendFileTo });
    await sender.sendImage('F:/demo/images/01-cover.png', '【图 1/5】01-cover.png');
    expect(sendImageWithCaption).toHaveBeenCalledWith('oc_1', 'F:/demo/images/01-cover.png', '【图 1/5】01-cover.png');
    expect(sendFileTo).not.toHaveBeenCalled();
    expect(sentPaths.has(resolve('F:/demo/images/01-cover.png'))).toBe(true);
  });
  it('无 sendImageWithCaption 时降级：caption 文本卡 + 图片消息两条', async () => {
    const sentPaths = new Set<string>();
    const sendText = vi.fn();
    const sendFileTo = vi.fn();
    const sender = createGatewaySender({ chatId: 'oc_1', sentPaths, sendText, sendFileTo });
    await sender.sendImage('F:/demo/1.png', '【图 2/5】02-x.png');
    expect(sendText).toHaveBeenCalledWith('oc_1', '【图 2/5】02-x.png');
    expect(sendFileTo).toHaveBeenCalledWith('oc_1', 'F:/demo/1.png');
  });
  it('sendImage 无 caption 降级时不发空文本卡', async () => {
    const sentPaths = new Set<string>();
    const sendText = vi.fn();
    const sendFileTo = vi.fn();
    const sender = createGatewaySender({ chatId: 'oc_1', sentPaths, sendText, sendFileTo });
    await sender.sendImage('F:/demo/1.png');
    expect(sendText).not.toHaveBeenCalled();
    expect(sendFileTo).toHaveBeenCalledOnce();
  });
  it('sendFile：note 先文本卡后文件，且计入 sentPaths（收尾去重依据）', async () => {
    const sentPaths = new Set<string>();
    const sendText = vi.fn();
    const sendFileTo = vi.fn();
    const sender = createGatewaySender({ chatId: 'oc_2', sentPaths, sendText, sendFileTo });
    await sender.sendFile('F:/demo/article.md', '文案初稿');
    expect(sendText).toHaveBeenCalledWith('oc_2', '文案初稿');
    expect(sendFileTo).toHaveBeenCalledWith('oc_2', 'F:/demo/article.md');
    expect(sentPaths.has(resolve('F:/demo/article.md'))).toBe(true);
    // 顺序：说明文本卡先于文件
    expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(sendFileTo.mock.invocationCallOrder[0]);
  });
  it('sendText 直通 sendText(chatId, md)', async () => {
    const sentPaths = new Set<string>();
    const sendText = vi.fn();
    const sender = createGatewaySender({ chatId: 'oc_1', sentPaths, sendText, sendFileTo: vi.fn() });
    await sender.sendText('hello');
    expect(sendText).toHaveBeenCalledWith('oc_1', 'hello');
  });
});
