// lcb ws add/remove 的纯逻辑单测：yaml 包 parseDocument 增量改写 + 校验规则。
// 关键回归：① 写回后 loadConfig 能原样读回（snake_case / defaults 一致性）
//          ② 手写配置的注释必须保留（区别于 setup 向导的全量 stringify 重写）
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { addWorkspace, removeWorkspace } from '../src/cli/ws-manager.js';

/** 造一份合法、带注释的配置原文（模拟用户手写 + setup 向导产物两种形态） */
function rawConfig(workspaces: Array<{ name: string; path: string }>, def: string, withComments = true): string {
  const lines = [
    'feishu:',
    '  app_id: cli_aabbccddeeff0011',
    '  app_secret: sec_test',
  ];
  if (withComments) {
    lines.push('', '# 工作区白名单：名字 + 路径');
  }
  lines.push('workspaces:');
  for (const w of workspaces) lines.push(`  - name: ${w.name}`, `    path: ${w.path}`);
  lines.push('defaults:', `  workspace: ${def}`, 'concurrency: 3');
  return lines.join('\n') + '\n';
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lcb-ws-'));
}

describe('ws add', () => {
  it('成功：写盘后 loadConfig 原样读回新工作区', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'blog'), { recursive: true }); // 被添加的路径须是已存在的目录（add 校验点）
    const r = addWorkspace(rawConfig([{ name: 'demo', path: join(dir, 'demo') }], 'demo'), 'blog', join(dir, 'blog'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = join(dir, 'config.yaml');
    writeFileSync(p, r.yaml, 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.workspaces).toEqual([
      { name: 'demo', path: join(dir, 'demo') },
      { name: 'blog', path: join(dir, 'blog') },
    ]);
    expect(cfg.defaults.workspace).toBe('demo'); // defaults 不受 add 影响
  });

  it('成功：路径是真实目录（相对路径由调用方传入，函数侧只验存在性）', () => {
    const dir = tmpDir();
    const r = addWorkspace(rawConfig([{ name: 'demo', path: dir }], 'demo'), 'new', dir);
    expect(r.ok).toBe(true);
  });

  it('重名拒绝', () => {
    const dir = tmpDir();
    const r = addWorkspace(rawConfig([{ name: 'demo', path: dir }], 'demo'), 'demo', dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('已存在');
  });

  it('名字含空白拒绝（/ws use 按空格分词，含空格名字无法切换）', () => {
    const dir = tmpDir();
    const r = addWorkspace(rawConfig([{ name: 'demo', path: dir }], 'demo'), 'my ws', dir);
    expect(r.ok).toBe(false);
  });

  it('名字为空或纯空白拒绝', () => {
    const dir = tmpDir();
    const raw = rawConfig([{ name: 'demo', path: dir }], 'demo');
    expect(addWorkspace(raw, '', dir).ok).toBe(false);
    expect(addWorkspace(raw, '   ', dir).ok).toBe(false);
  });

  it('路径不存在拒绝', () => {
    const dir = tmpDir();
    const r = addWorkspace(rawConfig([{ name: 'demo', path: dir }], 'demo'), 'nope', join(dir, 'does-not-exist'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('不存在');
  });

  it('路径是文件而非目录拒绝', () => {
    const dir = tmpDir();
    const file = join(dir, 'afile.txt');
    writeFileSync(file, 'x', 'utf8');
    const r = addWorkspace(rawConfig([{ name: 'demo', path: dir }], 'demo'), 'bad', file);
    expect(r.ok).toBe(false);
  });

  it('注释保留：手写配置的注释在写回后仍在', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'blog'), { recursive: true });
    const raw = rawConfig([{ name: 'demo', path: join(dir, 'demo') }], 'demo', true);
    const r = addWorkspace(raw, 'blog', join(dir, 'blog'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.yaml).toContain('# 工作区白名单：名字 + 路径');
    // 写回磁盘再读一遍，确认注释落在最终产物里（非仅内存文档）
    const p = join(dir, 'config.yaml');
    writeFileSync(p, r.yaml, 'utf8');
    expect(readFileSync(p, 'utf8')).toContain('# 工作区白名单：名字 + 路径');
  });

  it('失败时不产出 yaml（调用方凭 ok 决定是否写盘）', () => {
    const dir = tmpDir();
    const r = addWorkspace(rawConfig([{ name: 'demo', path: dir }], 'demo'), 'demo', dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect('yaml' in r).toBe(false);
  });
});

describe('ws remove', () => {
  it('成功：删除非默认工作区，defaults 不动', () => {
    const dir = tmpDir();
    const r = removeWorkspace(rawConfig([
      { name: 'demo', path: join(dir, 'demo') },
      { name: 'blog', path: join(dir, 'blog') },
    ], 'demo'), 'blog');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = join(dir, 'config.yaml');
    writeFileSync(p, r.yaml, 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.workspaces).toEqual([{ name: 'demo', path: join(dir, 'demo') }]);
    expect(cfg.defaults.workspace).toBe('demo');
  });

  it('删除默认工作区：defaults 回退到剩余第一个，loadConfig 校验通过', () => {
    const dir = tmpDir();
    const r = removeWorkspace(rawConfig([
      { name: 'demo', path: join(dir, 'demo') },
      { name: 'blog', path: join(dir, 'blog') },
    ], 'demo'), 'demo');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = join(dir, 'config.yaml');
    writeFileSync(p, r.yaml, 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.workspaces.map((w) => w.name)).toEqual(['blog']);
    expect(cfg.defaults.workspace).toBe('blog');
  });

  it('最后一个工作区禁删（loadConfig 要求至少一个）', () => {
    const dir = tmpDir();
    const r = removeWorkspace(rawConfig([{ name: 'demo', path: dir }], 'demo'), 'demo');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('最后一个');
  });

  it('删除不存在的工作区报错', () => {
    const dir = tmpDir();
    const r = removeWorkspace(rawConfig([{ name: 'demo', path: dir }], 'demo'), 'ghost');
    expect(r.ok).toBe(false);
  });

  it('联动清理：删掉的工作区若被 apps[].default_workspace 引用，引用一并删除（防下次 loadConfig 抛错）', () => {
    const dir = tmpDir();
    const raw = [
      'apps:',
      '  - name: 主力',
      '    app_id: cli_aaaaaaaaaaaaaaaa',
      '    app_secret: s1',
      '    default_workspace: two',
      'workspaces:',
      `  - name: demo`, `    path: ${join(dir, 'demo')}`,
      `  - name: two`, `    path: ${join(dir, 'two')}`,
      'defaults:',
      '  workspace: demo',
    ].join('\n') + '\n';
    const r = removeWorkspace(raw, 'two');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = join(dir, 'config.yaml');
    writeFileSync(p, r.yaml, 'utf8');
    const cfg = loadConfig(p); // 引用未清理时此处直接抛错（default_workspace 不在列表）
    expect(cfg.apps[0].defaultWorkspace).toBeUndefined();
    expect(cfg.workspaces.map((w) => w.name)).toEqual(['demo']);
  });
});
