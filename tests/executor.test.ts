import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

import { runTask } from '../src/executor/claude-executor.js';
import { OutputCollector } from '../src/executor/output-collector.js';

function fakeStream(messages: unknown[]) {
  return (async function* () { for (const m of messages) yield m; })();
}

describe('runTask', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  it('流消息转进度回调，result 出最终文本与会话 id', async () => {
    queryMock.mockReturnValue(fakeStream([
      { type: 'assistant', message: { content: [{ type: 'text', text: '正在分析' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'F:/x/a.md', content: 'hi' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'result', subtype: 'success', result: '完成了', session_id: 'sess_1' },
    ]));
    const events: string[] = [];
    const out = await runTask('写点东西', { cwd: 'F:/x' }, { onProgress: (e) => { events.push(`${e.kind}:${e.content}`); } });
    expect(out.finalText).toBe('完成了');
    expect(out.sessionId).toBe('sess_1');
    expect(out.turns).toBe(2);
    expect(out.producedFiles).toEqual(['F:/x/a.md']);
    expect(events.some((e) => e.startsWith('text:正在分析'))).toBe(true);
    expect(events.some((e) => e.startsWith('tool-start:Write'))).toBe(true);
  });
  it('canUseTool 透传给 SDK options', async () => {
    queryMock.mockReturnValue(fakeStream([{ type: 'result', subtype: 'success', result: 'r', session_id: 's' }]));
    const canUseTool = vi.fn().mockResolvedValue({ behavior: 'allow' });
    await runTask('p', { cwd: 'F:/x', canUseTool }, { onProgress: () => {} });
    // 真实 SDK 签名为 query({ prompt, options })，options 在单对象参数内
    const params = queryMock.mock.calls[0][0] as { prompt?: unknown; options?: { canUseTool?: unknown; settingSources?: string[]; cwd?: string } };
    expect(params.prompt).toBe('p');
    const opts = params.options!;
    expect(opts.canUseTool).toBe(canUseTool);
    expect(opts.settingSources).toEqual(['user', 'project']);
    expect(opts.cwd).toBe('F:/x');
  });
  it('signal 中止会桥接到 SDK abortController，resume 透传', async () => {
    queryMock.mockReturnValue(fakeStream([{ type: 'result', subtype: 'success', result: 'r', session_id: 's2' }]));
    const controller = new AbortController();
    await runTask('p', { cwd: 'F:/x', resumeSessionId: 'old_sess', signal: controller.signal }, { onProgress: () => {} });
    const opts = (queryMock.mock.calls[0][0] as { options?: { resume?: string; abortController?: AbortController; permissionMode?: string } }).options!;
    expect(opts.resume).toBe('old_sess');
    expect(opts.abortController).toBeInstanceOf(AbortController);
    expect(opts.permissionMode).toBe('default');
    // 外部 signal 触发 abort → 桥接的 abortController 同步中止
    const ac = opts.abortController!;
    expect(ac.signal.aborted).toBe(false);
    controller.abort();
    expect(ac.signal.aborted).toBe(true);
  });
  it('mcpServers 原样透传，plugins 映射为 local 类型，缺省时不出现字段', async () => {
    queryMock.mockReturnValue(fakeStream([{ type: 'result', subtype: 'success', result: 'r', session_id: 's' }]));
    const mcpServers = { 'lcb-notify': { type: 'sdk', name: 'lcb-notify' } } as Record<string, never>;
    await runTask('p', { cwd: 'F:/x', mcpServers, plugins: [{ path: 'F:/plugins/content-producer/plugin' }] }, { onProgress: () => {} });
    let opts = (queryMock.mock.calls[0][0] as { options?: { mcpServers?: unknown; plugins?: unknown } }).options!;
    expect(opts.mcpServers).toBe(mcpServers);
    expect(opts.plugins).toEqual([{ type: 'local', path: 'F:/plugins/content-producer/plugin' }]);
    // 缺省：两个字段均不出现（不影响既有 resume 链路）
    await runTask('p2', { cwd: 'F:/x' }, { onProgress: () => {} });
    opts = (queryMock.mock.calls[1][0] as { options?: { mcpServers?: unknown; plugins?: unknown } }).options!;
    expect('mcpServers' in opts).toBe(false);
    expect('plugins' in opts).toBe(false);
  });
});

describe('OutputCollector', () => {
  it('只跟踪写文件工具且去重', () => {
    const c = new OutputCollector();
    c.track('Write', { file_path: 'a.md' });
    c.track('Write', { file_path: 'a.md' });
    c.track('Edit', { file_path: 'b.ts' });
    c.track('Read', { file_path: 'c.ts' });
    expect(c.files()).toEqual(['a.md', 'b.ts']);
  });
});
