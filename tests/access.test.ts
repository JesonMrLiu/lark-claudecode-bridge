import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessControl } from '../src/access/access-control.js';

function fresh(): AccessControl {
  return AccessControl.load(join(mkdtempSync(join(tmpdir(), 'lcb-a-')), 'access.json'));
}

describe('AccessControl', () => {
  it('陌生人不允许', () => {
    expect(fresh().isAllowed('ou_a')).toBe(false);
  });
  it('配对码批准后允许，首个用户成为 admin', () => {
    const a = fresh();
    const code = a.beginPairing('ou_a', '张三');
    expect(code).toMatch(/^\d{6}$/);
    const r = a.approvePairing(code);
    expect(r.ok).toBe(true);
    expect(r.isFirstAdmin).toBe(true);
    expect(a.isAllowed('ou_a')).toBe(true);
    expect(a.isAdmin('ou_a')).toBe(true);
  });
  it('第二个配对的是 member', () => {
    const a = fresh();
    a.approvePairing(a.beginPairing('ou_a', 'A'));
    const r = a.approvePairing(a.beginPairing('ou_b', 'B'));
    expect(r.isFirstAdmin).toBe(false);
    expect(a.isAdmin('ou_b')).toBe(false);
    expect(a.isAllowed('ou_b')).toBe(true);
  });
  it('错误码拒绝', () => {
    const a = fresh();
    a.beginPairing('ou_a', 'A');
    expect(a.approvePairing('000000').ok).toBe(false);
  });
  it('过期配对码拒绝', () => {
    const a = fresh();
    const code = a.beginPairing('ou_a', 'A');
    // 直接改库模拟过期：读内部数据文件不方便，用 rejectPairing 后再 approve 验证一次性
    a.rejectPairing(code);
    expect(a.approvePairing(code).ok).toBe(false);
  });
  it('同一用户重复配对覆盖旧码', () => {
    const a = fresh();
    a.beginPairing('ou_a', 'A');
    const c2 = a.beginPairing('ou_a', 'A');
    expect(a.listPending().length).toBe(1);
    expect(a.approvePairing(c2).ok).toBe(true);
  });
  it('配对结果持久化：重新 load 后仍在白名单（round-trip）', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'lcb-a-')), 'access.json');
    const a = AccessControl.load(storePath);
    a.approvePairing(a.beginPairing('ou_persist', '持久'));
    // 用同一路径重新加载，断言状态确实落盘而非仅内存
    const b = AccessControl.load(storePath);
    expect(b.isAllowed('ou_persist')).toBe(true);
    expect(b.isAdmin('ou_persist')).toBe(true);
  });
  it('超过 15 分钟的配对码过期拒绝（真实时钟推进）', () => {
    vi.useFakeTimers();
    const a = fresh();
    const code = a.beginPairing('ou_late', '迟到');
    // 推进 16 分钟，覆盖 evict 的 expiresAt 分支
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect(a.approvePairing(code).ok).toBe(false);
    expect(a.listPending().length).toBe(0);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
