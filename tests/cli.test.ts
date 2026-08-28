import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { answersToConfig, toYamlDocument, APP_ID_RE } from '../src/cli/setup-wizard.js';
import { VERSION } from '../src/index.js';

describe('setup 向导（纯逻辑）', () => {
  it('answersToConfig：默认工作区不在列表时回退到第一个', () => {
    const cfg = answersToConfig({
      appId: 'cli_aabbccddeeff0011',
      appSecret: 'sec',
      workspaces: [
        { name: 'demo', path: 'F:\\demo' },
        { name: 'blog', path: 'F:\\blog' },
      ],
      defaultWorkspace: 'demo',
    });
    expect(cfg.defaults.workspace).toBe('demo');
    expect(cfg.concurrency).toBe(3);
    expect(cfg.workspaces).toHaveLength(2);
  });

  it('往返：向导写盘的 YAML 能被 loadConfig 原样读回', () => {
    // ⚠️ 关键回归：toYamlDocument 必须写 snake_case 键（app_id / app_secret），
    // 若直接 stringify(camelCase BridgeConfig)，loadConfig 将抛「缺少 feishu.app_id」
    const answers = {
      appId: 'cli_aabbccddeeff0011',
      appSecret: 'sec_test',
      workspaces: [{ name: 'demo', path: 'F:\\demo' }],
      defaultWorkspace: 'demo',
    };
    const dir = mkdtempSync(join(tmpdir(), 'lcb-cli-'));
    const p = join(dir, 'config.yaml');
    writeFileSync(p, stringify(toYamlDocument(answersToConfig(answers))), 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.feishu.appId).toBe('cli_aabbccddeeff0011');
    expect(cfg.feishu.appSecret).toBe('sec_test');
    expect(cfg.workspaces[0]).toEqual({ name: 'demo', path: 'F:\\demo' });
    expect(cfg.defaults.workspace).toBe('demo');
    expect(cfg.concurrency).toBe(3);
  });

  it('toYamlDocument：domain 为 lark 时写入，feishu 默认省略', () => {
    const base = answersToConfig({
      appId: 'cli_aabbccddeeff0011', appSecret: 's',
      workspaces: [{ name: 'a', path: '/a' }], defaultWorkspace: 'a',
    });
    expect((toYamlDocument(base).feishu as Record<string, unknown>).domain).toBeUndefined();
    const lark = structuredClone(base);
    lark.feishu.domain = 'lark';
    expect((toYamlDocument(lark).feishu as Record<string, unknown>).domain).toBe('lark');
  });

  it('APP_ID_RE：16 位十六进制通过，其他形状不通过', () => {
    expect(APP_ID_RE.test('cli_aabbccddeeff0011')).toBe(true);
    expect(APP_ID_RE.test('cli_AABBCCDDEEFF0011')).toBe(true);
    expect(APP_ID_RE.test('cli_aabbccddeeff001')).toBe(false); // 15 位
    expect(APP_ID_RE.test('cli_aabbccddeeff00111')).toBe(false); // 17 位
    expect(APP_ID_RE.test('cli_test123')).toBe(false);
    expect(APP_ID_RE.test('app_xxxxxxxxxxxxxxxx')).toBe(false);
  });
});

describe('VERSION 单一来源', () => {
  it('index re-export 与 version.ts 一致且为 0.1.0', async () => {
    const { VERSION: v } = await import('../src/version.js');
    expect(VERSION).toBe('0.1.0');
    expect(VERSION).toBe(v);
    // dist/bin/lcb.js version 依赖同一来源；与 package.json 版本保持同步
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(pkg.version).toBe(VERSION);
  });
});
