import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { addApp, removeApp, listApps } from '../src/cli/app-manager.js';

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** loadConfig 只吃路径：写临时 yaml 再读回，校验「写盘结果可被运行时原样加载」 */
function roundTrip(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lcb-appmgr-'));
  tempDirs.push(dir);
  const p = join(dir, 'config.yaml');
  writeFileSync(p, yaml, 'utf8');
  return loadConfig(p);
}

const APPS_RAW = `# 顶部注释，改写必须保留
apps:
  - name: 主力
    app_id: cli_aaaaaaaaaaaaaaaa
    app_secret: s1
workspaces:
  - name: demo
    path: F:/demo
defaults:
  workspace: demo
concurrency: 3
`;

const LEGACY_RAW = `# 旧单应用配置
feishu:
  app_id: cli_oldaaaaaaaaaaaaaa
  app_secret: sec_old
workspaces:
  - name: demo
    path: F:/demo
defaults:
  workspace: demo
`;

const TWO_APPS_RAW = `apps:
  - name: 主力
    app_id: cli_aaaaaaaaaaaaaaaa
    app_secret: s1
  - name: 素材
    app_id: cli_bbbbbbbbbbbbbbbb
    app_secret: s2
    default_workspace: demo
workspaces:
  - name: demo
    path: F:/demo
defaults:
  workspace: demo
`;

describe('addApp', () => {
  it('追加新 app，注释保留，写盘结果可被 loadConfig 读回', () => {
    const r = addApp(APPS_RAW, { name: '素材', appId: 'cli_bbbbbbbbbbbbbbbb', appSecret: 's2' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.yaml).toContain('顶部注释'); // 增量改写不抹注释
    const cfg = roundTrip(r.yaml);
    expect(cfg.apps.map((a) => a.appId)).toEqual(['cli_aaaaaaaaaaaaaaaa', 'cli_bbbbbbbbbbbbbbbb']);
    expect(cfg.apps[1].name).toBe('素材');
  });
  it('新 app 缺省 claudeConfigDir 为独立目录 <CONFIG_DIR>/claude/<appId>', () => {
    const r = addApp(APPS_RAW, { appId: 'cli_bbbbbbbbbbbbbbbb', appSecret: 's2' });
    if (!r.ok) throw new Error(r.error);
    const cfg = roundTrip(r.yaml);
    // loadConfig 归一化：apps 数组里的 app 未写 claude_config_dir → 推导独立目录
    expect(cfg.apps[1].name).toBe('cli_bbbbbbbbbbbbbbbb'); // name 缺省 = appId
    expect(cfg.apps[1].claudeConfigDir.endsWith(join('claude', 'cli_bbbbbbbbbbbbbbbb'))).toBe(true);
  });
  it('appId 重复拒绝（同一应用两条长连接是配置错误）', () => {
    const r = addApp(APPS_RAW, { appId: 'cli_aaaaaaaaaaaaaaaa', appSecret: 's2' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('重复');
  });
  it('旧 feishu 格式原地转 apps：旧 app 显式写 claude_config_dir=~/.claude 保存量会话，feishu 键移除', () => {
    const r = addApp(LEGACY_RAW, { appId: 'cli_bbbbbbbbbbbbbbbb', appSecret: 's2' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.yaml).not.toMatch(/^feishu:/m); // 旧键已被 apps 取代
    expect(r.yaml).toContain('claude_config_dir'); // 旧 app 显式钉住系统默认目录
    const cfg = roundTrip(r.yaml);
    expect(cfg.apps).toHaveLength(2);
    expect(cfg.apps[0]).toMatchObject({ appId: 'cli_oldaaaaaaaaaaaaaa', appSecret: 'sec_old' });
    expect(cfg.apps[0].claudeConfigDir).toBe(join(homedir(), '.claude')); // 存量会话 resume 不中断
    expect(cfg.apps[1].appId).toBe('cli_bbbbbbbbbbbbbbbb');
  });
  it('空 app_id / app_secret 拒绝', () => {
    expect(addApp(APPS_RAW, { appId: '', appSecret: 's' }).ok).toBe(false);
    expect(addApp(APPS_RAW, { appId: 'cli_bbbbbbbbbbbbbbbb', appSecret: '' }).ok).toBe(false);
  });
});

describe('removeApp', () => {
  it('按 name 删除；最后一个拒绝', () => {
    const r = removeApp(TWO_APPS_RAW, '素材');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cfg = roundTrip(r.yaml);
    expect(cfg.apps.map((a) => a.name)).toEqual(['主力']);
    expect(removeApp(r.yaml, '主力').ok).toBe(false); // 最后一个不可删
  });
  it('按 appId 也可删除', () => {
    const r = removeApp(TWO_APPS_RAW, 'cli_bbbbbbbbbbbbbbbb');
    expect(r.ok).toBe(true);
  });
  it('不存在的名字报可读错误', () => {
    const r = removeApp(TWO_APPS_RAW, '不存在');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('不存在');
  });
});

describe('listApps', () => {
  it('列出 name/appId/domain/defaultWorkspace（旧格式也能列）', () => {
    expect(listApps(TWO_APPS_RAW)).toEqual([
      { name: '主力', appId: 'cli_aaaaaaaaaaaaaaaa' },
      { name: '素材', appId: 'cli_bbbbbbbbbbbbbbbb', defaultWorkspace: 'demo' },
    ]);
    expect(listApps(LEGACY_RAW)).toEqual([{ name: 'cli_oldaaaaaaaaaaaaaa', appId: 'cli_oldaaaaaaaaaaaaaa' }]);
  });
});
