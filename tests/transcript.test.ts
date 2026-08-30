import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { TranscriptWriter, sweepTranscripts } from '../src/transcript/transcript-writer.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 测试侧自行格式化本地日期（不 import 实现的 localDate，避免断言恒真的自我循环） */
function todayName(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lcb-tr-'));
  tempDirs.push(d);
  return d;
}

const ts = () => new Date().toISOString();
const base0 = { app: 'cli_a', chatId: 'oc_1', userId: 'ou_u' } as const;

describe('TranscriptWriter', () => {
  it('四类事件按天落盘到 <appId 之外的 baseDir>/<chatId>/<日期>.jsonl，每行可解析、字段齐全', () => {
    const base = tmpDir();
    const w = new TranscriptWriter(base);
    w.user({ v: 1, ts: ts(), kind: 'user', ...base0, workspace: 'demo', sessionId: 's-prev', text: '帮我整理' });
    w.assistant({ v: 1, ts: ts(), kind: 'assistant', ...base0, text: '好的' });
    w.tool({ v: 1, ts: ts(), kind: 'tool', ...base0, phase: 'start', tool: 'Bash', summary: 'ls', ok: true });
    w.result({
      v: 1, ts: ts(), kind: 'result', ...base0, workspace: 'demo',
      sessionId: 's1', subtype: 'success', text: '完成', producedFiles: [], turns: 2,
    });
    const file = join(base, 'oc_1', `${todayName()}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.kind)).toEqual(['user', 'assistant', 'tool', 'result']);
    expect(lines[0]).toMatchObject({ v: 1, app: 'cli_a', chatId: 'oc_1', userId: 'ou_u', text: '帮我整理' });
    expect(lines[3]).toMatchObject({ sessionId: 's1', subtype: 'success', turns: 2 });
    // 落盘内容绝不含凭证字段
    expect(readFileSync(file, 'utf8')).not.toContain('appSecret');
    expect(readFileSync(file, 'utf8')).not.toContain('app_secret');
  });
  it('不同 chatId 落到各自目录', () => {
    const base = tmpDir();
    const w = new TranscriptWriter(base);
    w.user({ v: 1, ts: ts(), kind: 'user', ...base0, text: 'a' });
    w.user({ v: 1, ts: ts(), kind: 'user', ...base0, chatId: 'oc_2', text: 'b' });
    expect(existsSync(join(base, 'oc_1', `${todayName()}.jsonl`))).toBe(true);
    expect(existsSync(join(base, 'oc_2', `${todayName()}.jsonl`))).toBe(true);
  });
  it('写失败不向调用方抛出，且告警按分钟节流', () => {
    const dir = tmpDir();
    const blocked = join(dir, 'blocker'); // baseDir 指向普通文件 → mkdir 失败
    writeFileSync(blocked, 'x', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = new TranscriptWriter(blocked);
    expect(() => w.user({ v: 1, ts: ts(), kind: 'user', ...base0, text: 'x' })).not.toThrow();
    expect(() => w.assistant({ v: 1, ts: ts(), kind: 'assistant', ...base0, text: 'y' })).not.toThrow();
    expect(() => w.result({
      v: 1, ts: ts(), kind: 'result', ...base0, sessionId: 's', subtype: 'error', text: 'z',
    })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1); // 同一分钟内最多告警一次
  });
});

describe('sweepTranscripts', () => {
  it('按 mtime 删除过期 .jsonl、保留新文件，返回删除数', () => {
    const base = tmpDir();
    const old = join(base, 'cli_a', 'oc_1', '2026-01-01.jsonl');
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, 'x', 'utf8');
    const fresh = join(base, 'cli_a', 'oc_2', `${todayName()}.jsonl`);
    mkdirSync(dirname(fresh), { recursive: true });
    writeFileSync(fresh, 'x', 'utf8');
    const past = new Date(Date.now() - 40 * 86400 * 1000);
    utimesSync(old, past, past);
    const n = sweepTranscripts(base, 30);
    expect(n).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
  it('baseDir 不存在返回 0 不抛', () => {
    expect(sweepTranscripts(join(tmpdir(), `lcb-none-${Math.random()}`), 30)).toBe(0);
  });
});
