import { describe, it, expect } from 'vitest';
import { buildTextCard, buildProgressCard, buildConfirmCard, buildConfirmResultCard } from '../src/gateway/card-builder.js';
import type { ConfirmationRequest } from '../src/types.js';

const req: ConfirmationRequest = { requestId: 'r1', toolName: 'Bash', summary: 'git push origin main', workspaceName: 'demo' };

describe('card-builder', () => {
  it('所有卡片都是 schema 2.0', () => {
    for (const card of [buildTextCard('hi'), buildProgressCard({ title: 't', status: 's', textTail: '', toolLine: '', startedAt: 0 }), buildConfirmCard(req)]) {
      expect((card as { schema: string }).schema).toBe('2.0');
    }
  });
  it('确认卡片含三按钮与回调值', () => {
    const json = JSON.stringify(buildConfirmCard(req));
    expect(json).toContain('允许');
    expect(json).toContain('拒绝');
    expect(json).toContain('本次会话不再询问');
    expect(json).toContain('"requestId":"r1"');
    expect(json).toContain('"decision":"allow"');
    expect(json).toContain('"decision":"deny"');
    expect(json).toContain('"decision":"allow-session"');
    expect(json).not.toContain('"tag":"action"'); // V2 已废弃 action 包裹，防回归
    expect(json).toContain('"tag":"column_set"'); // 按钮以分栏布局并排
  });
  it('确认卡片展示命令摘要与工作区', () => {
    const json = JSON.stringify(buildConfirmCard(req));
    expect(json).toContain('git push origin main');
    expect(json).toContain('demo');
  });
  it('结果态卡片不含按钮', () => {
    const json = JSON.stringify(buildConfirmResultCard(req, 'allow', '张三'));
    expect(json).toContain('张三');
    expect(json).not.toContain('"tag":"button"');
  });
});
