import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIncomingMessage, stripMention, FeishuGateway } from '../src/gateway/feishu-gateway.js';

// SDK EventDispatcher 回调收到的是 RequestHandle.parse() 展平后的数据：
// v2 事件 {schema, header, event} 被解包为顶层 {...header, ...event}，
// 即顶层 {sender, message}——以 node_modules/@larksuiteoapi/node-sdk@1.73.0 实测为准。
const feishuEvent = {
  sender: { sender_id: { open_id: 'ou_u' }, sender_type: 'user' },
  message: {
    chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text',
    content: JSON.stringify({ text: '帮我写个脚本' }),
    message_id: 'om_1',
  },
};

describe('parseIncomingMessage', () => {
  it('解析展平结构（SDK 回调实际形态）的文本消息', () => {
    const msg = parseIncomingMessage(feishuEvent);
    expect(msg).toMatchObject({ chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u', text: '帮我写个脚本', messageId: 'om_1' });
  });
  it('兼容 {event:{...}} 包裹形态（原始 v1/v2 事件体）', () => {
    const msg = parseIncomingMessage({ event: feishuEvent });
    expect(msg).toMatchObject({ chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u', text: '帮我写个脚本', messageId: 'om_1' });
  });
  it('非文本消息返回 null', () => {
    expect(parseIncomingMessage({ message: { ...feishuEvent.message, message_type: 'image' } })).toBeNull();
  });
  it('群聊未 @机器人 忽略，@了才处理（@ 在文本中渲染为 @_user_N 占位）', () => {
    const group = { sender: feishuEvent.sender, message: { ...feishuEvent.message, chat_type: 'group', content: JSON.stringify({ text: '没有提及' }) } };
    expect(parseIncomingMessage(group)).toBeNull();
    const groupMention = { sender: feishuEvent.sender, message: { ...feishuEvent.message, chat_type: 'group', content: JSON.stringify({ text: '@_user_1 帮我查' }) } };
    expect(parseIncomingMessage(groupMention)?.text).toBe('帮我查');
  });
  it('群聊仅有 mentions 数组（文本占位被客户端吃掉）也处理', () => {
    const group = {
      sender: feishuEvent.sender,
      message: {
        ...feishuEvent.message, chat_type: 'group',
        content: JSON.stringify({ text: '帮我查' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'bot' }],
      },
    };
    expect(parseIncomingMessage(group)?.text).toBe('帮我查');
  });
  it('空文本返回 null', () => {
    expect(parseIncomingMessage({ message: { ...feishuEvent.message, content: JSON.stringify({ text: '  ' }) } })).toBeNull();
  });
  it('结构不对返回 null 不抛异常', () => {
    expect(parseIncomingMessage({})).toBeNull();
    expect(parseIncomingMessage(null)).toBeNull();
    expect(parseIncomingMessage({ message: { ...feishuEvent.message, content: 'not json' } })).toBeNull();
  });
});

describe('stripMention', () => {
  it('去掉 @机器人 前缀', () => {
    expect(stripMention('@_user_1 帮我查一下')).toBe('帮我查一下');
  });
  it('无提及时原样返回', () => {
    expect(stripMention('普通消息')).toBe('普通消息');
  });
});

// 假 SDK：结构对齐 node-sdk 真实签名
// - WSClient 构造 {appId, appSecret, domain, loggerLevel}，start({eventDispatcher})
// - EventDispatcher 构造 {}，register(handles) 返回 this（并把 handles 交给测试断言）
// - Client 构造 IClientParams，im.message/image/file 命名空间
function makeFakeSdk() {
  // 真实签名：EventDispatcher.register(handles) 返回 this；测试里用闭包截获 handles 供断言
  const register = vi.fn((map: Record<string, (d: unknown) => unknown>) => map);
  class FakeDispatcher {
    register(handles: Record<string, (d: unknown) => unknown>) {
      register(handles);
      return this; // 对齐真实 SDK：register 返回 this
    }
  }
  const fakeSdk: any = {
    WSClient: class {
      async start(o: { eventDispatcher: { register: unknown } }) {
        // 模拟真实 WSClient 对 dispatcher 的持有（不实际建连）
        void o.eventDispatcher;
      }
    },
    EventDispatcher: FakeDispatcher,
    Client: class {},
    Domain: { Feishu: 0, Lark: 1 },
  };
  return { fakeSdk, register };
}

describe('FeishuGateway 分发（注入假 SDK）', () => {
  it('收到消息事件调用 onMessage', async () => {
    const onMessage = vi.fn();
    const { fakeSdk, register } = makeFakeSdk();
    const gw = new FeishuGateway({ appId: 'cli_0123456789abcdef', appSecret: 's' }, { sdk: fakeSdk });
    await gw.start({ onMessage, onCardAction: vi.fn() });
    const handlers = register.mock.results[0].value as Record<string, (d: unknown) => Promise<unknown>>;
    await handlers['im.message.receive_v1'](feishuEvent);
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0]).toMatchObject({ chatId: 'oc_1', text: '帮我写个脚本' });
  });

  it('群聊未 @ 的事件不调用 onMessage', async () => {
    const onMessage = vi.fn();
    const { fakeSdk, register } = makeFakeSdk();
    const gw = new FeishuGateway({ appId: 'cli_0123456789abcdef', appSecret: 's' }, { sdk: fakeSdk });
    await gw.start({ onMessage, onCardAction: vi.fn() });
    const handlers = register.mock.results[0].value as Record<string, (d: unknown) => Promise<unknown>>;
    await handlers['im.message.receive_v1']({
      sender: feishuEvent.sender,
      message: { ...feishuEvent.message, chat_type: 'group', content: JSON.stringify({ text: '没@机器人' }) },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('卡片按钮回调调用 onCardAction 并返回 {}（飞书 SDK 契约）', async () => {
    const onCardAction = vi.fn();
    const { fakeSdk, register } = makeFakeSdk();
    const gw = new FeishuGateway({ appId: 'cli_0123456789abcdef', appSecret: 's' }, { sdk: fakeSdk });
    await gw.start({ onMessage: vi.fn(), onCardAction });
    const handlers = register.mock.results[0].value as Record<string, (d: unknown) => Promise<unknown>>;
    const ret = await handlers['card.action.trigger']({
      operator: { open_id: 'ou_clicker' },
      context: { open_message_id: 'om_card', open_chat_id: 'oc_1' },
      action: { tag: 'button', value: { requestId: 'req_1', decision: 'allow' } },
    });
    expect(ret).toEqual({});
    expect(onCardAction).toHaveBeenCalledWith({
      value: { requestId: 'req_1', decision: 'allow' },
      operatorId: 'ou_clicker',
      openMessageId: 'om_card',
    });
  });

  it('缺关键字段的卡片回调不调用 onCardAction，仍返回 {}', async () => {
    const onCardAction = vi.fn();
    const { fakeSdk, register } = makeFakeSdk();
    const gw = new FeishuGateway({ appId: 'cli_0123456789abcdef', appSecret: 's' }, { sdk: fakeSdk });
    await gw.start({ onMessage: vi.fn(), onCardAction });
    const handlers = register.mock.results[0].value as Record<string, (d: unknown) => Promise<unknown>>;
    const ret = await handlers['card.action.trigger']({ action: { value: {} } });
    expect(ret).toEqual({});
    expect(onCardAction).not.toHaveBeenCalled();
  });
});

describe('FeishuGateway 收发（注入假 Client）', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lcb-gw-'));
  const pngPath = join(tmpDir, 'shot.png');
  const pdfPath = join(tmpDir, 'report.pdf');
  writeFileSync(pngPath, 'fake-png');
  writeFileSync(pdfPath, 'fake-pdf');
  afterAll(() => setTimeout(() => rmSync(tmpDir, { recursive: true, force: true }), 50));

  function fakeClientSdk(im: unknown) {
    const fakeSdk: any = {
      WSClient: class { async start(): Promise<void> {} },
      EventDispatcher: class { register() { return this; } },
      Client: class { im = im; },
      Domain: { Feishu: 0, Lark: 1 },
    };
    return fakeSdk;
  }

  it('sendCard 走 im.message.create 并返回 message_id', async () => {
    const create = vi.fn(async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_new' } }));
    const fakeSdk = fakeClientSdk({ message: { create } });
    const gw = new FeishuGateway({ appId: 'a', appSecret: 's' }, { sdk: fakeSdk });
    const id = await gw.sendCard('oc_1', { schema: '2.0' });
    expect(id).toBe('om_new');
    expect(create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_1', msg_type: 'interactive', content: JSON.stringify({ schema: '2.0' }) },
    });
  });

  it('sendCard 失败（无 message_id）时抛错', async () => {
    const create = vi.fn(async () => ({ code: 230002, msg: 'bot not in chat' }));
    const fakeSdk = fakeClientSdk({ message: { create } });
    const gw = new FeishuGateway({ appId: 'a', appSecret: 's' }, { sdk: fakeSdk });
    await expect(gw.sendCard('oc_1', {})).rejects.toThrow();
  });

  it('sendText 复用 buildTextCard', async () => {
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_t' } }));
    const fakeSdk = fakeClientSdk({ message: { create } });
    const gw = new FeishuGateway({ appId: 'a', appSecret: 's' }, { sdk: fakeSdk });
    await gw.sendText('oc_1', '# hi');
    const sent = create.mock.calls[0][0].data;
    expect(sent.msg_type).toBe('interactive');
    expect(JSON.parse(sent.content).schema).toBe('2.0');
  });

  it('updateCard 走 im.message.patch', async () => {
    const patch = vi.fn(async () => ({ code: 0 }));
    const fakeSdk = fakeClientSdk({ message: { patch } });
    const gw = new FeishuGateway({ appId: 'a', appSecret: 's' }, { sdk: fakeSdk });
    await gw.updateCard('om_1', { schema: '2.0', updated: true });
    expect(patch).toHaveBeenCalledWith({
      path: { message_id: 'om_1' },
      data: { content: JSON.stringify({ schema: '2.0', updated: true }) },
    });
  });

  it('图片文件：im.image.create（返回顶层 image_key）+ 发图片消息', async () => {
    // 真实 SDK 会消费流；fake 里把流读完，确保 lazy open 在测试内完成
    const imageCreate = vi.fn(async (p: { data: { image: NodeJS.ReadableStream } }) => {
      await new Promise<void>((resolve) => {
        const s = p.data.image as NodeJS.ReadableStream & { resume(): void; once(ev: 'end' | 'error', cb: () => void): unknown };
        s.once('end', () => resolve());
        s.once('error', () => resolve());
        s.resume();
      });
      return { image_key: 'img_v2_key' }; // SDK 实际返回顶层字段
    });
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_img' } }));
    const fakeSdk = fakeClientSdk({ message: { create }, image: { create: imageCreate } });
    const gw = new FeishuGateway({ appId: 'a', appSecret: 's' }, { sdk: fakeSdk });
    await gw.uploadAndSendFile('oc_1', pngPath);
    expect(imageCreate).toHaveBeenCalledOnce();
    const sent = create.mock.calls[0][0].data;
    expect(sent.msg_type).toBe('image');
    expect(JSON.parse(sent.content)).toEqual({ image_key: 'img_v2_key' });
  });

  it('普通文件：im.file.create（返回顶层 file_key）+ 发文件消息', async () => {
    const fileCreate = vi.fn(async (p: { data: { file: NodeJS.ReadableStream } }) => {
      await new Promise<void>((resolve) => {
        const s = p.data.file as NodeJS.ReadableStream & { resume(): void; once(ev: 'end' | 'error', cb: () => void): unknown };
        s.once('end', () => resolve());
        s.once('error', () => resolve());
        s.resume();
      });
      return { file_key: 'file_v2_key' };
    });
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_file' } }));
    const fakeSdk = fakeClientSdk({ message: { create }, file: { create: fileCreate } });
    const gw = new FeishuGateway({ appId: 'a', appSecret: 's' }, { sdk: fakeSdk });
    await gw.uploadAndSendFile('oc_1', pdfPath);
    expect(fileCreate).toHaveBeenCalledOnce();
    const data = fileCreate.mock.calls[0][0].data;
    expect(data.file_type).toBe('stream');
    expect(data.file_name).toBe('report.pdf');
    const sent = create.mock.calls[0][0].data;
    expect(sent.msg_type).toBe('file');
    expect(JSON.parse(sent.content)).toEqual({ file_key: 'file_v2_key' });
  });
});
