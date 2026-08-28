import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/session-store.js';
import { Semaphore, channelKey } from '../src/session/channel.js';
import { handleCommand } from '../src/session/commands.js';
import type { BridgeConfig } from '../src/types.js';

function freshStore(): SessionStore {
  return SessionStore.load(join(mkdtempSync(join(tmpdir(), 'lcb-s-')), 'sessions.json'));
}
const cfg: BridgeConfig = {
  feishu: { appId: 'a', appSecret: 's' },
  workspaces: [{ name: 'demo', path: 'F:/demo' }, { name: 'two', path: 'F:/two' }],
  defaults: { workspace: 'demo' },
  concurrency: 3,
};

describe('SessionStore', () => {
  it('newSession 后可存档会话并列表', () => {
    const s = freshStore();
    s.newSession('k1', 'demo');
    s.archiveSession('k1', 'sess_1', '帮我写脚本');
    expect(s.listSessions('k1')[0]).toMatchObject({ sessionId: 'sess_1', summary: '帮我写脚本' });
    expect(s.getChannelState('k1')?.workspaceName).toBe('demo');
  });
  it('持久化后重载仍在', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'lcb-s2-')), 's.json');
    const s = SessionStore.load(p);
    s.newSession('k1', 'demo');
    s.archiveSession('k1', 'sess_1', 'x');
    expect(SessionStore.load(p).listSessions('k1').length).toBe(1);
  });
});

describe('Semaphore', () => {
  it('限制并发数', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    let got3 = false;
    const p3 = sem.acquire().then((r) => { got3 = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(got3).toBe(false);
    r1();
    await p3;
    r2();
    expect(got3).toBe(true);
  });
  it('I1 回归：release 后同批新 acquire 不超发（任一时刻持有者 ≤ n）', async () => {
    const n = 2;
    const sem = new Semaphore(n);
    let holders = 0;
    let peak = 0;
    const track = (release: () => void): (() => void) => {
      holders++;
      if (holders > peak) peak = holders;
      return () => { holders--; release(); };
    };
    const r1 = track(await sem.acquire());
    const r2 = track(await sem.acquire());
    expect(holders).toBe(n);
    // 第三个任务排队挂起
    const p3 = sem.acquire().then(track);
    await new Promise((r) => setTimeout(r, 10)); // 确保 waiter 已入队
    // 竞态批：release 与新 acquire 在同一同步批，挤在 waiter 的 microtask 恢复之前
    r1();
    // p4 必须立即 track：否则旧实现下 p4 在窗口内超发拿槽对计数器隐形，断言失效
    const p4 = sem.acquire().then(track);
    // waiter（p3）获得转移的许可；p4 必须仍在排队（旧实现会立即拿槽导致超发）
    const r3 = await p3; // p3 已含 track 包装（.then(track)），不可再包一层
    expect(holders).toBe(n); // r2 + r3 恰好占满，p4 未持有（旧实现此处 holders=3）
    r3();
    const r4 = await p4; // p4 已含 track 包装
    expect(peak).toBeLessThanOrEqual(n);
    // 清理
    r4();
    r2();
  });
  it('M1 回归：重复 release 为 no-op，不破坏后续并发控制', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    r1();
    r1(); // 重复释放：不得使 active 递减为负
    const r2 = await sem.acquire(); // 仍能正常获取
    let got3 = false;
    const p3 = sem.acquire().then((r) => { got3 = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(got3).toBe(false); // r2 未释放，第三个进不来（active 为负时会超发）
    r2();
    await p3;
    expect(got3).toBe(true);
  });
});

describe('channelKey', () => {
  it('拼接', () => expect(channelKey('oc', 'ou')).toBe('oc:ou'));
});

describe('handleCommand', () => {
  const baseCtx = (store: ReturnType<typeof freshStore>, extra: Partial<Parameters<typeof handleCommand>[1]> = {}) => ({
    channelKey: 'k', store, config: cfg, isAdmin: true, currentWorkspace: () => 'demo', stopCurrentTask: () => false, ...extra,
  });
  it('/help 返回帮助且不产生任务', async () => {
    const r = await handleCommand('/help', baseCtx(freshStore()));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('/new');
  });
  it('/new 重置会话', async () => {
    const store = freshStore();
    store.newSession('k', 'demo');
    store.archiveSession('k', 's1', '旧会话');
    const r = await handleCommand('/new', baseCtx(store));
    expect(r.handled).toBe(true);
    expect(store.listSessions('k').length).toBe(0);
  });
  it('/resume 列出会话，/resume 1 切换', async () => {
    const store = freshStore();
    store.newSession('k', 'demo');
    store.archiveSession('k', 's1', '第一个');
    store.newSession('k', 'demo');
    store.archiveSession('k', 's2', '第二个');
    const list = await handleCommand('/resume', baseCtx(store));
    expect(list.reply).toContain('第一个');
    const pick = await handleCommand('/resume 1', baseCtx(store));
    expect(pick.reply).toContain('第一个');
    expect(store.getChannelState('k')?.sessions[0]?.sessionId).toBe('s1');
  });
  it('/ws use 切换工作区（admin），未知名报错，member 被拒', async () => {
    const store = freshStore();
    const ok = await handleCommand('/ws use two', baseCtx(store));
    expect(ok.reply).toContain('two');
    expect(store.getChannelState('k')?.workspaceName).toBe('two');
    const bad = await handleCommand('/ws use nope', baseCtx(store));
    expect(bad.reply).toContain('不存在');
    const denied = await handleCommand('/ws use demo', baseCtx(freshStore(), { isAdmin: false }));
    expect(denied.reply).toContain('管理员');
  });
  it('/stop 调用 stopCurrentTask', async () => {
    const stop = () => { (stop as { called?: boolean }).called = true; return true; };
    const r = await handleCommand('/stop', baseCtx(freshStore(), { stopCurrentTask: stop }));
    expect(r.handled).toBe(true);
    expect((stop as { called?: boolean }).called).toBe(true);
  });
  it('普通文本不处理', async () => {
    const r = await handleCommand('帮我写代码', baseCtx(freshStore()));
    expect(r.handled).toBe(false);
    expect(r.taskText).toBe('帮我写代码');
  });
});
