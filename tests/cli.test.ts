import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { answersToConfig, toYamlDocument, APP_ID_RE } from '../src/cli/setup-wizard.js';
import { approvePairingLine } from '../src/cli/stdin-pairing.js';
import { AccessControl } from '../src/access/access-control.js';
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

describe('stdin 配对监听（approvePairingLine）', () => {
  // 主场景（评审 I1）：桥已运行（另一实例先 beginPairing 写入 pending），
  // stdin handler 必须现读 store 才能看到该 pending——复用启动快照会「配对码无效」，
  // 且快照 save() 整盘覆写会抹掉桥内新 pending
  it('现读现批：能看到 handler 创建之前写入的 pending 并批准', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'lcb-pair-')), 'access.json');
    const bridgeSide = AccessControl.load(storePath); // 模拟桥内实例
    const code = bridgeSide.beginPairing('ou_user1', 'user1'); // 桥运行中产生的新 pending

    approvePairingLine(`  ${code}  \n`, storePath); // 含空白，验证 trim

    const reread = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(reread.users['ou_user1']?.role).toBe('admin'); // 首个批准者成为 admin
    expect(reread.pending['ou_user1']).toBeUndefined(); // pending 已清
  });

  it('桥内后续新增的 pending 也能被后续输入批准（每次现 load）', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'lcb-pair-')), 'access.json');
    // 写入方每次现读再 beginPairing（长存的旧实例整盘覆写会抹掉已有 users，
    // 属 AccessControl 多实例 last-writer-wins 的已知特性，见 task-11 报告疑虑 3；
    // 本用例聚焦 I1：handler 的第二次调用能看到第一次调用之后才写入的 pending）
    const c1 = AccessControl.load(storePath).beginPairing('ou_a', 'a');
    approvePairingLine(c1, storePath);

    const c2 = AccessControl.load(storePath).beginPairing('ou_b', 'b'); // 第一次批准之后才写入
    approvePairingLine(c2, storePath); // 第二次输入：现读才能看到 c2（旧实现复用快照则没有）

    const reread = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(Object.keys(reread.users).sort()).toEqual(['ou_a', 'ou_b']);
    expect(reread.users['ou_b']?.role).toBe('member'); // 第二个是 member
  });

  it('非 6 位数字静默忽略；无效码打错误但不抛、不落盘', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'lcb-pair-')), 'access.json');
    expect(() => approvePairingLine('hello', storePath)).not.toThrow();
    expect(() => approvePairingLine('12345', storePath)).not.toThrow();
    expect(() => approvePairingLine('000000', storePath)).not.toThrow(); // 无此 pending
    // approve 失败路径不 save：store 文件不应被创建
    expect(existsSync(storePath)).toBe(false);
  });
});
