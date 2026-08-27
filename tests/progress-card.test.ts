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
    // I2：flushIntervalMs 拉长以隔离 flushTimer，本用例只验证心跳分支
    const pc = new ProgressCard(sender, '任务', { flushIntervalMs: 120_000, idleHeartbeatMs: 30_000 });
    await pc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sent.length).toBeGreaterThanOrEqual(2); // 心跳确实触发
    await vi.advanceTimersByTimeAsync(29_000); // 累计 60s
    // I1 回归：心跳刷新后须重置空闲计时，60s 内应只有 30s/60s 两次心跳；退化连刷会是 ~32 张
    expect(sent.length).toBe(3);
    await pc.finish('done');
  });
  it('C1 回归：挂起的旧 flush 后落地也不会覆盖终态', async () => {
    const landed: Array<unknown> = []; // 按「落地顺序」记录（resolve 时刻，非调用时刻）
    let resolveFirst: (() => void) | undefined;
    let firstUpdate = true;
    const sender: CardSender = {
      async sendCard(card) {
        landed.push(card);
        return 'm1';
      },
      updateCard(_messageId, card) {
        if (firstUpdate) {
          firstUpdate = false;
          return new Promise<void>((resolve) => {
            // 第一次 update 模拟网络挂起：稍后手动放行，落地时刻晚于终态调用的发起
            resolveFirst = () => {
              landed.push(card);
              resolve();
            };
          });
        }
        landed.push(card);
        return Promise.resolve();
      },
    };
    const pc = new ProgressCard(sender, '任务', { flushIntervalMs: 120_000 });
    await pc.start();
    pc.appendText('x'.repeat(300)); // 超量触发 flush #1 → updateCard 挂起
    await vi.advanceTimersByTimeAsync(0); // 放行微任务，让 #1 挂起到位
    expect(landed.length).toBe(1); // 此刻只有初始卡：#1 挂起未落地
    const finishPromise = pc.finish('✅ 完成'); // 终态 flush #2 必须排在 #1 之后
    resolveFirst?.(); // #1 旧中间态此刻才落地
    await finishPromise; // #2 随后落地
    expect(landed.length).toBe(3);
    expect(JSON.stringify(landed[1])).not.toContain('完成'); // 中间态先落地
    expect(JSON.stringify(landed[2])).toContain('完成'); // 终态最后落地，未被旧卡覆盖
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
