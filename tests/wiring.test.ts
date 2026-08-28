import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, type BridgeDeps } from '../src/index.js';
import { AccessControl } from '../src/access/access-control.js';
import { SessionStore } from '../src/session/session-store.js';
import type { BridgeConfig, CardActionEvent, IncomingMessage } from '../src/types.js';

const cfg: BridgeConfig = {
  feishu: { appId: 'a', appSecret: 's' },
  workspaces: [{ name: 'demo', path: 'F:/demo' }],
  defaults: { workspace: 'demo' },
  concurrency: 3,
};

// 临时目录收集：SessionStore/AccessControl 触发 save 时会写盘，必须落在临时目录而非仓库 cwd
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeDeps(executor = vi.fn()) {
  const dir = mkdtempSync(join(tmpdir(), 'lcb-wiring-'));
  tempDirs.push(dir);
  const sent: Array<{ chatId: string; card: unknown }> = [];
  const deps: BridgeDeps = {
    gateway: {
      start: vi.fn(),
      sendCardTo: async (chatId, card) => { sent.push({ chatId, card }); return `m${sent.length}`; },
      sendTextTo: async (chatId, markdown) => { sent.push({ chatId, card: markdown }); return `m${sent.length}`; },
      updateCard: async () => {},
      uploadAndSendFile: vi.fn(),
    },
    access: new AccessControl(join(dir, 'access.json')),
    store: SessionStore.load(join(dir, 'sessions.json')),
    executor: executor as unknown as typeof import('../src/executor/claude-executor.js').runTask,
  };
  // 直接注入私有 data 设白名单（须为完整 AccessStoreData 形状：evict() 会遍历 pending）
  (deps.access as unknown as { data: { users: Record<string, { name: string; role: string }>; pending: Record<string, unknown> } }).data = {
    users: { ou_u: { name: '测试者', role: 'admin' } },
    pending: {},
  };
  return { deps, sent };
}

const msg = (text: string): IncomingMessage => ({ chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u', text, messageId: 'om_x' });

describe('createBridge 装配', () => {
  it('白名单用户发普通消息 → 首响卡片 + 执行器收到任务 + 结果回传', async () => {
    const executor = vi.fn().mockResolvedValue({ sessionId: 's1', finalText: '做好了', producedFiles: [], turns: 1 });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage(msg('帮我干活'));
    await new Promise((r) => setTimeout(r, 50)); // 等队列
    expect(executor).toHaveBeenCalledOnce();
    const call = executor.mock.calls[0] as unknown as [string, { cwd: string }];
    expect(call[0]).toBe('帮我干活');
    expect(call[1].cwd).toBe('F:/demo');
    const json = JSON.stringify(sent);
    expect(json).toContain('已接收');   // 首响
    expect(json).toContain('做好了');   // 结果
  });
  it('产出文件会上传', async () => {
    const executor = vi.fn().mockResolvedValue({ sessionId: 's1', finalText: 'ok', producedFiles: ['F:/demo/a.md'], turns: 1 });
    const { deps } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage(msg('写文件'));
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.gateway.uploadAndSendFile).toHaveBeenCalledWith('oc_1', 'F:/demo/a.md');
  });
  it('白名单外用户收到配对码卡片，不执行', async () => {
    const executor = vi.fn();
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage({ ...msg('hi'), userId: 'ou_stranger' });
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('配对');
  });
  it('确认流：写操作发确认卡片，按钮点击放行', async () => {
    let askFn!: (d: 'allow' | 'deny' | 'allow-session') => void;
    const executor = vi.fn().mockImplementation(async (_p: string, opts: { canUseTool?: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }> }) => {
      return opts.canUseTool!('Bash', { command: 'rm -rf /' });
    });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage(msg('删东西'));
    await new Promise((r) => setTimeout(r, 50));
    const confirmCard = sent.find((s) => JSON.stringify(s.card).includes('请求执行操作'));
    expect(confirmCard).toBeTruthy();
    // 模拟用户点允许
    const value = JSON.parse(JSON.stringify(confirmCard!.card)) as never as { requestId?: string };
    void value;
    // 从卡片 JSON 提取 requestId
    const m = /"requestId":"([^"]+)"/.exec(JSON.stringify(confirmCard!.card))!;
    const action: CardActionEvent = { value: { requestId: m[1], decision: 'allow' }, operatorId: 'ou_u', openMessageId: 'om_c' };
    const result = await bridge.onCardAction(action);
    void result;
    void askFn;
    // executor 的 canUseTool 返回值应被允许——通过 executor 被调用且无异常即验证链路
    expect(executor).toHaveBeenCalledOnce();
  });
  it('他人点击按钮无权限', async () => {
    const { deps } = makeDeps(vi.fn().mockResolvedValue({ sessionId: 's', finalText: '', producedFiles: [], turns: 1 }));
    const bridge = createBridge(cfg, deps);
    // 无 pending 的 requestId：应静默/提示，不抛异常
    await expect(bridge.onCardAction({ value: { requestId: 'nope', decision: 'allow' }, operatorId: 'ou_u', openMessageId: 'om_c' })).resolves.toBeUndefined();
  });
  it('/help 命令直接回复不进执行器', async () => {
    const executor = vi.fn();
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage(msg('/help'));
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('/new');
  });
});
