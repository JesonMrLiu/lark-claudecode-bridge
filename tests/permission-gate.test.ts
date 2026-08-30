import { describe, it, expect, vi, afterEach } from 'vitest';
import { PermissionGate, READ_ONLY_TOOLS } from '../src/executor/permission-gate.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('READ_ONLY_TOOLS', () => {
  it('含 Read/Glob/Grep，不含 Bash/Write', () => {
    expect(READ_ONLY_TOOLS.has('Read')).toBe(true);
    expect(READ_ONLY_TOOLS.has('Glob')).toBe(true);
    expect(READ_ONLY_TOOLS.has('Grep')).toBe(true);
    expect(READ_ONLY_TOOLS.has('Bash')).toBe(false);
    expect(READ_ONLY_TOOLS.has('Write')).toBe(false);
  });
});

describe('PermissionGate', () => {
  it('只读工具直接放行不询问', async () => {
    const ask = vi.fn();
    const g = new PermissionGate({ ask });
    expect((await g.decide('Read', { file_path: 'a' }, 'ws')).behavior).toBe('allow');
    expect(ask).not.toHaveBeenCalled();
  });
  it('lcb-notify 通知工具前缀直通（逐张发图不应逐次弹确认卡）', async () => {
    const ask = vi.fn();
    const g = new PermissionGate({ ask });
    for (const name of ['mcp__lcb-notify__send_text', 'mcp__lcb-notify__send_image', 'mcp__lcb-notify__send_file']) {
      expect((await g.decide(name, { path: 'F:/x/1.png' }, 'ws')).behavior).toBe('allow');
    }
    expect(ask).not.toHaveBeenCalled();
  });
  it('相似前缀的其它 server 工具不误放（仍走询问）', async () => {
    const ask = vi.fn().mockResolvedValue('allow');
    const g = new PermissionGate({ ask });
    await g.decide('mcp__lcb-notify2__send_image', {}, 'ws');
    await g.decide('mcp__other__send_text', {}, 'ws');
    expect(ask).toHaveBeenCalledTimes(2);
  });
  it('写操作询问并允许', async () => {
    const ask = vi.fn().mockResolvedValue('allow');
    const g = new PermissionGate({ ask });
    expect((await g.decide('Bash', { command: 'ls' }, 'ws')).behavior).toBe('allow');
    expect(ask).toHaveBeenCalledOnce();
  });
  it('拒绝返回 deny 带原因', async () => {
    const g = new PermissionGate({ ask: () => Promise.resolve('deny') });
    const r = await g.decide('Write', { file_path: 'a' }, 'ws');
    expect(r.behavior).toBe('deny');
    expect(r.message).toBeTruthy();
  });
  it('allow-session 后同类不再询问', async () => {
    const ask = vi.fn().mockResolvedValue('allow-session' as const);
    const g = new PermissionGate({ ask });
    await g.decide('Bash', { command: 'a' }, 'ws');
    await g.decide('Bash', { command: 'b' }, 'ws');
    expect(ask).toHaveBeenCalledOnce();
  });
  it('超时自动拒绝', async () => {
    vi.useFakeTimers();
    const g = new PermissionGate({ ask: () => new Promise(() => {}), timeoutMs: 1000 });
    const p = g.decide('Bash', { command: 'x' }, 'ws');
    vi.advanceTimersByTime(1100);
    const r = await p;
    expect(r.behavior).toBe('deny');
    vi.useRealTimers();
  });
  it('ask 及时答复后清理超时 timer，不残留', async () => {
    vi.useFakeTimers();
    const g = new PermissionGate({ ask: () => Promise.resolve('allow'), timeoutMs: 1000 });
    await g.decide('Bash', { command: 'x' }, 'ws');
    // 常驻进程中每个已答复的 decide 不应留下存活的超时 timer（unref 只解决进程退出，不清理 timer）
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reset 清除会话记忆', async () => {
    const ask = vi.fn().mockResolvedValue('allow-session' as const);
    const g = new PermissionGate({ ask });
    await g.decide('Bash', { command: 'a' }, 'ws');
    g.reset();
    await g.decide('Bash', { command: 'b' }, 'ws');
    expect(ask).toHaveBeenCalledTimes(2);
  });
  it('询问请求带唯一 requestId 与工具摘要', async () => {
    const ask = vi.fn().mockResolvedValue('allow');
    const g = new PermissionGate({ ask });
    await g.decide('Bash', { command: 'npm test' }, 'my-ws');
    const req = ask.mock.calls[0][0];
    // UUID v4 形状：版本位为 4，变体位为 8/9/a/b
    expect(req.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(req.toolName).toBe('Bash');
    expect(req.summary).toBe('npm test');
    expect(req.workspaceName).toBe('my-ws');
  });
});
