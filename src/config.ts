import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, type YAMLParseError } from 'yaml';
import type { BridgeConfig } from './types.js';

export const CONFIG_DIR = join(homedir(), '.lark-claudecode-bridge');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

export function loadConfig(path: string = CONFIG_PATH): BridgeConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`找不到配置文件 ${path}，请先运行 lcb setup`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`配置文件 YAML 语法错误：${(e as YAMLParseError).message}`);
  }
  const feishu = (doc.feishu ?? {}) as Record<string, string>;
  if (!feishu.app_id) throw new Error('配置缺少 feishu.app_id');
  if (!feishu.app_secret) throw new Error('配置缺少 feishu.app_secret');
  const workspaces = (doc.workspaces ?? []) as Array<{ name: string; path: string }>;
  if (workspaces.length === 0) throw new Error('配置至少需要一个 workspaces 条目');
  const defaults = (doc.defaults ?? {}) as { workspace: string };
  if (!workspaces.some((w) => w.name === defaults.workspace)) {
    throw new Error(`defaults.workspace "${defaults.workspace}" 不在 workspaces 列表中`);
  }
  // 非法值必须在此处抛错：NaN/0 透传给 Semaphore 会导致任务永远拿不到许可（死锁）
  const concurrency = Number(doc.concurrency ?? 3);
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error(`concurrency 必须为 1-100 的数字（当前值：${String(doc.concurrency)}），请检查 config.yaml`);
  }
  return {
    feishu: {
      appId: feishu.app_id,
      appSecret: feishu.app_secret,
      domain: feishu.domain === 'lark' ? 'lark' : 'feishu',
    },
    workspaces,
    defaults: { workspace: defaults.workspace },
    concurrency,
  };
}
