import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const VALID = `
feishu:
  app_id: cli_test123
  app_secret: sec_test
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

describe('loadConfig', () => {
  it('加载合法配置并填默认值', () => {
    const cfg = loadConfig(tmpYaml(VALID));
    expect(cfg.feishu.appId).toBe('cli_test123');
    expect(cfg.workspaces[0].name).toBe('demo');
    expect(cfg.concurrency).toBe(3); // 默认
    expect(cfg.feishu.domain).toBe('feishu'); // 默认
  });
  it('正斜杠 Windows 路径也接受', () => {
    // 注：brief 原文 replace('\\\\', '/') 的参数为两个字面反斜杠，匹配不到模板串中的单反斜杠（空操作），
    // 此处改为正则全局替换，真正生成正斜杠路径，测试意图不变
    const cfg = loadConfig(tmpYaml(VALID.replace(/\\/g, '/')));
    expect(cfg.workspaces[0].path).toContain('/');
  });
  it('缺 app_id 报可读错误', () => {
    expect(() => loadConfig(tmpYaml('feishu: {}\n'))).toThrow(/app_id/);
  });
  it('defaults.workspace 不在工作区列表时报错', () => {
    const bad = VALID.replace('workspace: demo', 'workspace: nope');
    expect(() => loadConfig(tmpYaml(bad))).toThrow(/nope/);
  });
  it('concurrency 非数字（\'abc\' → NaN）抛可读错误', () => {
    // 修复前 NaN 透传给 Semaphore → 任务永远拿不到许可（死锁）
    expect(() => loadConfig(tmpYaml(VALID + '\nconcurrency: abc\n'))).toThrow(/concurrency/);
    expect(() => loadConfig(tmpYaml(VALID + '\nconcurrency: abc\n'))).toThrow(/1-100/);
  });
  it('concurrency 为 0 或超出上限抛错', () => {
    expect(() => loadConfig(tmpYaml(VALID + '\nconcurrency: 0\n'))).toThrow(/concurrency/);
    expect(() => loadConfig(tmpYaml(VALID + '\nconcurrency: 101\n'))).toThrow(/concurrency/);
    // 合法边界仍通过
    expect(loadConfig(tmpYaml(VALID + '\nconcurrency: 1\n')).concurrency).toBe(1);
    expect(loadConfig(tmpYaml(VALID + '\nconcurrency: 100\n')).concurrency).toBe(100);
  });
});
