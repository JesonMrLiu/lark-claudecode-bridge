import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressCard, type CardSender } from '../src/gateway/progress-card.js';

function fakeSender() {
  const sent: Array<{ id: string; card: unknown }> = [];
  let n = 0;
  const sender: CardSender = {
    async sendCard(card) {
      const id = `m${++n}`;
      sent.push({ id, card });
      return id;
    },
    async updateCard(messageId, card) {
      sent.push({ id: messageId, card });
    },
  };
  return { sender, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ProgressCard', () => {
  it('start 立即发送一张卡片', async () => {
    const { sender, sent } = fakeSender();
    const pc = new ProgressCard(sender, '任务');
    await pc.start();
    expect(sent.length).toBe(1);
    await pc.finish('done');
  });
  it('文本增量节流：不超阈值不刷，超时/超量才刷', async () => {
    const { sender, sent } = fakeSender();
    const pc = new ProgressCard(sender, '任务', { flushIntervalMs: 1500 });
    await pc.start();
    pc.appendText('abc');
    expect(sent.length).toBe(1);            // 未到阈值未刷
    await vi.advanceTimersByTimeAsync(1600);
    expect(sent.length).toBe(2);            // 定时器到点刷出
    await pc.finish('done');
  });
  it('心跳：空闲 30s 也会刷新（显示运行时长）', async () => {
    const { sender, sent } = fakeSender();
    const pc = new ProgressCard(sender, '任务', { idleHeartbeatMs: 30_000 });
    await pc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    await pc.finish('done');
  });
  it('finish 后不再刷新', async () => {
    const { sender, sent } = fakeSender();
    const pc = new ProgressCard(sender, '任务');
    await pc.start();
    await pc.finish('✅ 完成');
    const n = sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    pc.appendText('late');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent.length).toBe(n);
    expect(JSON.stringify(sent[n - 1].card)).toContain('完成');
  });
});
