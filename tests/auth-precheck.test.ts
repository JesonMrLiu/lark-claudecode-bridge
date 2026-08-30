import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasClaudeAuth, warnIfNoClaudeAuth } from '../src/auth-precheck.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lcb-auth-'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hasClaudeAuth · 认证来源判定', () => {
  it('环境变量带 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY 任一即有认证', () => {
    const dir = tmpDir();
    expect(hasClaudeAuth({ ANTHROPIC_AUTH_TOKEN: 'tok_x' }, dir)).toBe(true);
    expect(hasClaudeAuth({ ANTHROPIC_API_KEY: 'sk_x' }, dir)).toBe(true);
  });
  it('环境变量空白字符串不算认证', () => {
    const dir = tmpDir();
    expect(hasClaudeAuth({ ANTHROPIC_AUTH_TOKEN: '  ' }, dir)).toBe(false);
    expect(hasClaudeAuth({ ANTHROPIC_API_KEY: '' }, dir)).toBe(false);
  });
  it('配置目录存在 .credentials.json（OAuth 登录态）即有认证', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.credentials.json'), '{}', 'utf8');
    expect(hasClaudeAuth({}, dir)).toBe(true);
  });
  it('配置目录 settings.json 的 env 块声明 token / apiKeyHelper 即有认证', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'tok_x' } }), 'utf8');
    expect(hasClaudeAuth({}, dir)).toBe(true);

    const dir2 = tmpDir();
    writeFileSync(join(dir2, 'settings.json'), JSON.stringify({ apiKeyHelper: './helper.sh' }), 'utf8');
    expect(hasClaudeAuth({}, dir2)).toBe(true);
  });
  it('settings.json 损坏（非法 JSON）视为无认证，不抛错', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'settings.json'), '{broken', 'utf8');
    expect(hasClaudeAuth({}, dir)).toBe(false);
  });
  it('全来源落空：无环境变量、无凭证文件、无 settings.json', () => {
    const dir = tmpDir();
    expect(hasClaudeAuth({}, dir)).toBe(false);
  });
});

describe('warnIfNoClaudeAuth · 启动告警', () => {
  it('有认证时不告警，返回 true', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfNoClaudeAuth('主力', { ANTHROPIC_AUTH_TOKEN: 'tok_x' }, tmpDir())).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
  it('无认证时 warn 指引三条出路，返回 false', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = tmpDir();
    expect(warnIfNoClaudeAuth('主力', {}, dir)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain('Not logged in');
    expect(msg).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(msg).toContain(dir);
    expect(msg).toContain('claude login');
  });
});
