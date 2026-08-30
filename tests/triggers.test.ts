import { describe, it, expect } from 'vitest';
import { rewriteByTrigger } from '../src/session/triggers.js';
import type { TriggerRule } from '../src/types.js';

const rules: TriggerRule[] = [
  { match: '/produce', rewrite: '执行 content-producer 内容生产流程。任务参数：{args}' },
  { match: '写文章', rewrite: '执行 content-producer 流程。任务描述：{text}' },
];

describe('rewriteByTrigger', () => {
  it('斜杠形态：首 token 精确匹配，{args} 为剩余参数', () => {
    expect(rewriteByTrigger('/produce https://mp.weixin.qq.com/s/xxx 公众号', rules))
      .toBe('执行 content-producer 内容生产流程。任务参数：https://mp.weixin.qq.com/s/xxx 公众号');
  });
  it('斜杠形态仅前缀相似不命中（/produced ≠ /produce）', () => {
    expect(rewriteByTrigger('/produced 什么', rules)).toBeNull();
  });
  it('本地命令最高优先级不被劫持（/stop /new /help /status /resume /ws）', () => {
    for (const cmd of ['/stop', '/new', '/help', '/status', '/resume 2', '/ws list', '/STOP']) {
      expect(rewriteByTrigger(cmd, [{ match: '/stop', rewrite: '劫持 {text}' }])).toBeNull();
    }
  });
  it('未知斜杠命令返回 null（保持「未知命令」防呆 UX，不被关键词规则捞走）', () => {
    expect(rewriteByTrigger('/foo 写文章', rules)).toBeNull();
  });
  it('关键词形态：包含即命中，{text} 为全文', () => {
    expect(rewriteByTrigger('帮我写文章，主题是咖啡', rules))
      .toBe('执行 content-producer 流程。任务描述：帮我写文章，主题是咖啡');
  });
  it('多规则按数组顺序首个命中', () => {
    const multi: TriggerRule[] = [
      { match: '写文章', rewrite: 'A：{text}' },
      { match: '文章', rewrite: 'B：{text}' },
    ];
    expect(rewriteByTrigger('写文章吧', multi)).toBe('A：写文章吧');
  });
  it('斜杠规则不参与关键词匹配，关键词规则不参与斜杠匹配', () => {
    // 消息含「/produce」字样但非首 token：斜杠规则不应命中；关键词规则按全文包含正常命中
    expect(rewriteByTrigger('看看 /produce 的用法', [{ match: '/produce', rewrite: 'X {args}' }])).toBeNull();
    expect(rewriteByTrigger('/produce', [{ match: 'produce', rewrite: 'Y {text}' }])).toBeNull();
  });
  it('无规则 / 空文本 / 消息仅为空白返回 null', () => {
    expect(rewriteByTrigger('任意', undefined)).toBeNull();
    expect(rewriteByTrigger('任意', [])).toBeNull();
    expect(rewriteByTrigger('   ', rules)).toBeNull();
  });
});
