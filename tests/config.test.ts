import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, sameApps, CONFIG_DIR } from '../src/config.js';

const APPS_YAML = `
apps:
  - name: 主力
    app_id: cli_test123
    app_secret: sec_test
  - app_id: cli_second
    app_secret: sec2
    domain: lark
    default_workspace: demo
    concurrency: 5
workspaces:
  - name: demo
    path: F:\\workspace\\demo
defaults:
  workspace: demo
`;

const LEGACY_YAML = `
feishu:
  app_id: cli_legacy
  app_secret: sec_old
workspaces:
  - name: demo
    path: F:\\workspace\\demo
defaults:
  workspace: demo
`;

function tmpYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lcb-'));
  const p = join(dir, 'config.yaml');
  writeFileSync(p, content, 'utf8');
  return p;
}

/** 把 APPS_YAML 第二个 app 的 concurrency 行替换为任意属性行（插入须在条目内部，不能拼接文档末尾） */
function withApp2Field(extra: string): string {
  return APPS_YAML.replace('    concurrency: 5\n', `${extra}`);
}

describe('loadConfig · apps 多应用格式', () => {
  it('解析 apps 数组：显式字段、name 缺省取 appId、domain/concurrency/default_workspace', () => {
    const cfg = loadConfig(tmpYaml(APPS_YAML));
    expect(cfg.apps).toHaveLength(2);
    expect(cfg.apps[0]).toMatchObject({ name: '主力', appId: 'cli_test123', appSecret: 'sec_test', domain: 'feishu' });
    expect(cfg.apps[1]).toMatchObject({
      name: 'cli_second', appId: 'cli_second', appSecret: 'sec2',
      domain: 'lark', defaultWorkspace: 'demo', concurrency: 5,
    });
    expect(cfg.workspaces[0].name).toBe('demo');
    expect(cfg.concurrency).toBe(3); // 全局缺省
  });
  it('新配置 app 的 claudeConfigDir 缺省为独立目录 <CONFIG_DIR>/claude/<appId>', () => {
    const cfg = loadConfig(tmpYaml(APPS_YAML));
    expect(cfg.apps[0].claudeConfigDir).toBe(join(CONFIG_DIR, 'claude', 'cli_test123'));
    expect(cfg.apps[1].claudeConfigDir).toBe(join(CONFIG_DIR, 'claude', 'cli_second'));
  });
  it('显式 claude_config_dir 优先于缺省推导', () => {
    const cfg = loadConfig(tmpYaml(withApp2Field('    concurrency: 5\n    claude_config_dir: D:\\cc\n')));
    expect(cfg.apps[1].claudeConfigDir).toBe('D:\\cc');
  });
  it('app.env 键值对原样解析', () => {
    const cfg = loadConfig(tmpYaml(withApp2Field('    concurrency: 5\n    env:\n      ANTHROPIC_MODEL: glm-4.6\n')));
    expect(cfg.apps[1].env).toEqual({ ANTHROPIC_MODEL: 'glm-4.6' });
  });
  it('app.triggers / app.plugins 解析；缺省为 undefined', () => {
    const cfg = loadConfig(tmpYaml(APPS_YAML));
    expect(cfg.apps[0].triggers).toBeUndefined();
    expect(cfg.apps[0].plugins).toBeUndefined();
    const pluginPath = join(tmpdir(), 'lcb-plugin-fake');
    const withBoth = loadConfig(tmpYaml(withApp2Field(
      '    concurrency: 5\n    triggers:\n      - match: /produce\n        rewrite: 执行内容生产流程：{args}\n      - match: 写文章\n        rewrite: 执行内容生产流程：{text}\n    plugins:\n      - name: content-producer\n        path: ' + pluginPath + '\n',
    )));
    expect(withBoth.apps[1].triggers).toEqual([
      { match: '/produce', rewrite: '执行内容生产流程：{args}' },
      { match: '写文章', rewrite: '执行内容生产流程：{text}' },
    ]);
    expect(withBoth.apps[1].plugins).toEqual([{ name: 'content-producer', path: pluginPath }]);
  });
  it('triggers 的 match/rewrite 空串抛错并带 apps[i](name) 定位', () => {
    expect(() => loadConfig(tmpYaml(withApp2Field('    concurrency: 5\n    triggers:\n      - match: ""\n        rewrite: x{text}\n')))).toThrow(/triggers\[0\]\.match/);
    expect(() => loadConfig(tmpYaml(withApp2Field('    concurrency: 5\n    triggers:\n      - match: /a\n        rewrite: "  "\n')))).toThrow(/triggers\[0\]\.rewrite/);
  });
  it('plugins 的 name/path 空串抛错；路径不存在仅 warn 不阻断', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => loadConfig(tmpYaml(withApp2Field('    concurrency: 5\n    plugins:\n      - name: ""\n        path: F:/x\n')))).toThrow(/plugins\[0\]\.name/);
      expect(() => loadConfig(tmpYaml(withApp2Field('    concurrency: 5\n    plugins:\n      - name: p\n        path: ""\n')))).toThrow(/plugins\[0\]\.path/);
      // 不存在的路径：正常解析 + warn（运行期目录可能挂载较晚，不硬抛阻断启动）
      warn.mockClear();
      const cfg = loadConfig(tmpYaml(withApp2Field('    concurrency: 5\n    plugins:\n      - name: p\n        path: F:/definitely/not/here\n')));
      expect(cfg.apps[1].plugins).toEqual([{ name: 'p', path: 'F:/definitely/not/here' }]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  it('appId 重复抛错（同一应用建两条长连接是配置错误）', () => {
    expect(() => loadConfig(tmpYaml(APPS_YAML.replace('cli_second', 'cli_test123')))).toThrow(/重复/);
  });
  it('apps 条目缺 app_id 报可读错误并带定位', () => {
    const bad = APPS_YAML.replace('app_id: cli_second', '');
    expect(() => loadConfig(tmpYaml(bad))).toThrow(/cli_second|apps\[1\]/);
    expect(() => loadConfig(tmpYaml(bad))).toThrow(/app_id/);
  });
  it('app.default_workspace 不在工作区列表时报错', () => {
    const bad = APPS_YAML.replace('default_workspace: demo', 'default_workspace: nope');
    expect(() => loadConfig(tmpYaml(bad))).toThrow(/nope/);
  });
  it('app.concurrency 非法（NaN/0/越界）抛可读错误', () => {
    expect(() => loadConfig(tmpYaml(APPS_YAML.replace('concurrency: 5', 'concurrency: abc')))).toThrow(/concurrency/);
    expect(() => loadConfig(tmpYaml(APPS_YAML.replace('concurrency: 5', 'concurrency: 0')))).toThrow(/concurrency/);
    expect(() => loadConfig(tmpYaml(APPS_YAML.replace('concurrency: 5', 'concurrency: 101')))).toThrow(/1-100/);
  });
  it('transcripts.retention_days 解析；缺省为 undefined', () => {
    expect(loadConfig(tmpYaml(APPS_YAML)).transcripts).toBeUndefined();
    const cfg = loadConfig(tmpYaml(APPS_YAML + 'transcripts:\n  retention_days: 90\n'));
    expect(cfg.transcripts).toEqual({ retentionDays: 90 });
  });
});

describe('loadConfig · 旧 feishu 单应用格式（向后兼容）', () => {
  it('归一化为 apps[0]，凭证与 domain 正确', () => {
    const cfg = loadConfig(tmpYaml(LEGACY_YAML));
    expect(cfg.apps).toHaveLength(1);
    expect(cfg.apps[0]).toMatchObject({ name: 'cli_legacy', appId: 'cli_legacy', appSecret: 'sec_old', domain: 'feishu' });
  });
  it('旧格式 app 沿用系统默认 ~/.claude 作为 claudeConfigDir（保存量会话 resume）', () => {
    const cfg = loadConfig(tmpYaml(LEGACY_YAML));
    expect(cfg.apps[0].claudeConfigDir).toBe(join(homedir(), '.claude'));
  });
  it('apps 与 feishu 并存时 apps 优先、feishu 被忽略', () => {
    const cfg = loadConfig(tmpYaml(APPS_YAML + 'feishu:\n  app_id: cli_old\n  app_secret: sec_old\n'));
    expect(cfg.apps.map((a) => a.appId)).toEqual(['cli_test123', 'cli_second']);
  });
  it('旧格式缺 app_id 仍报可读错误', () => {
    const noAppId = 'feishu: {}\nworkspaces:\n  - name: d\n    path: /d\ndefaults:\n  workspace: d\n';
    expect(() => loadConfig(tmpYaml(noAppId))).toThrow(/app_id/);
  });
  it('无 apps 也无 feishu 报缺少凭证错误', () => {
    expect(() => loadConfig(tmpYaml('workspaces:\n  - name: d\n    path: /d\ndefaults:\n  workspace: d\n'))).toThrow(/apps|feishu|setup/);
  });
});

describe('loadConfig · 全局校验（保留）', () => {
  it('defaults.workspace 不在工作区列表时报错', () => {
    const bad = APPS_YAML.replace('workspace: demo', 'workspace: nope');
    expect(() => loadConfig(tmpYaml(bad))).toThrow(/nope/);
  });
  it('全局 concurrency 非数字（\'abc\' → NaN）抛可读错误', () => {
    // 修复前 NaN 透传给 Semaphore → 任务永远拿不到许可（死锁）
    expect(() => loadConfig(tmpYaml(APPS_YAML + '\nconcurrency: abc\n'))).toThrow(/concurrency/);
    expect(() => loadConfig(tmpYaml(APPS_YAML + '\nconcurrency: abc\n'))).toThrow(/1-100/);
  });
  it('全局 concurrency 为 0 或超出上限抛错', () => {
    expect(() => loadConfig(tmpYaml(APPS_YAML + '\nconcurrency: 0\n'))).toThrow(/concurrency/);
    expect(() => loadConfig(tmpYaml(APPS_YAML + '\nconcurrency: 101\n'))).toThrow(/concurrency/);
    // 合法边界仍通过
    expect(loadConfig(tmpYaml(APPS_YAML + '\nconcurrency: 1\n')).concurrency).toBe(1);
    expect(loadConfig(tmpYaml(APPS_YAML + '\nconcurrency: 100\n')).concurrency).toBe(100);
  });
});

describe('sameApps（热重载比较）', () => {
  const a = { name: 'x', appId: 'cli_1', appSecret: 's1' };
  it('相同数组返回 true', () => {
    expect(sameApps([a], [{ ...a }])).toBe(true);
  });
  it('凭证/名称/工作区/并发/配置目录任一变化返回 false', () => {
    for (const patch of [
      { name: 'y' }, { appSecret: 's2' }, { defaultWorkspace: 'w' },
      { concurrency: 9 }, { claudeConfigDir: 'D:/x' }, { appendSystemPrompt: 'p' },
    ]) {
      expect(sameApps([a], [{ ...a, ...patch }])).toBe(false);
    }
  });
  it('长度不同返回 false', () => {
    expect(sameApps([a], [a, a])).toBe(false);
    expect(sameApps([], [])).toBe(true);
  });
});
