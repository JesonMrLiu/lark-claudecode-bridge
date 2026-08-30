// 插件自动发现：SDK 不会自动加载 CLI 经 marketplace 安装的插件，须显式传安装路径。
// 从 Claude Code 数据目录读取 installed_plugins.json（安装清单）+ settings.json 的
// enabledPlugins（启用状态），把 scope=user 且已启用的插件 installPath 转成 SDK plugins 选项。
// 全程容错：文件缺失/格式异常一律 warn-once 后返回空，绝不阻断任务（插件加载失败 ≠ 桥接器不可用）
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginRef } from '../types.js';

export interface DiscoveredPlugin {
  /** 插件名（installed_plugins.json 键 "name@marketplace" 的 @ 前段） */
  name: string;
  marketplace?: string;
  /** 安装目录（含 .claude-plugin/plugin.json） */
  path: string;
  version?: string;
}

/** installed_plugins.json 的已知形状（version 2）；字段异常时按防御分支跳过 */
interface InstalledPluginsDoc {
  version?: number;
  plugins?: Record<string, Array<{ scope?: string; installPath?: string; version?: string }>>;
}

/** settings.json 只取关心的键 */
interface SettingsDoc {
  enabledPlugins?: Record<string, unknown>;
}

// mtime 缓存：用户 CLI 侧 /plugin install/uninstall 后两个文件的 mtime 变化自动失效，
// 任务间复用避免每条消息重复解析 JSON（文件很小，stat 开销可忽略）
const cache = new Map<string, { mtimes: string; result: DiscoveredPlugin[] }>();
// warn-once：同一目录同一原因只提示一次，避免长驻进程每次任务刷屏
const warned = new Set<string>();

function warnOnce(dir: string, reason: string, detail: string): void {
  const k = `${dir}::${reason}`;
  if (warned.has(k)) return;
  warned.add(k);
  console.warn(`[插件发现] ${detail}`);
}

function readJson<T>(path: string): { ok: true; doc: T } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: false, error: 'missing' };
  try {
    return { ok: true, doc: JSON.parse(readFileSync(path, 'utf8')) as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 发现 <claudeConfigDir>/plugins/installed_plugins.json 中 scope=user 且
 * settings.json enabledPlugins 显式启用（=== true）的插件。
 * 典型数据（本机 ~/.claude 实测）：
 *   installed_plugins.json: {version:2, plugins:{"name@marketplace":[{scope:"user",installPath,version}]}}
 *   settings.json: {enabledPlugins:{"name@marketplace":true}}
 */
export function discoverPlugins(claudeConfigDir: string): DiscoveredPlugin[] {
  const installedPath = join(claudeConfigDir, 'plugins', 'installed_plugins.json');
  const settingsPath = join(claudeConfigDir, 'settings.json');
  // installed_plugins.json 不存在 = 没装过任何 marketplace 插件，静默返回空（无插件属正常态）
  if (!existsSync(installedPath)) return [];

  // mtime 缓存命中：两文件任一变化才重新解析
  let mtimes = '';
  try {
    mtimes = `${statSync(installedPath).mtimeMs},${existsSync(settingsPath) ? statSync(settingsPath).mtimeMs : 0}`;
  } catch { /* stat 失败（并发写盘等）不缓存，直接重新解析 */ }
  const hit = cache.get(claudeConfigDir);
  if (hit && mtimes && hit.mtimes === mtimes) return hit.result;

  const result = parseInstalled(claudeConfigDir, installedPath, settingsPath);
  cache.set(claudeConfigDir, { mtimes, result });
  return result;
}

function parseInstalled(dir: string, installedPath: string, settingsPath: string): DiscoveredPlugin[] {
  const installed = readJson<InstalledPluginsDoc>(installedPath);
  if (!installed.ok) {
    warnOnce(dir, 'installed-parse', `installed_plugins.json 无法解析（${installed.error}），跳过插件自动发现`);
    return [];
  }
  const doc = installed.doc;
  if (doc.version !== 2) {
    warnOnce(dir, 'installed-version', `installed_plugins.json 版本为 ${String(doc.version)}（预期 2），格式可能已变化，跳过插件自动发现`);
    return [];
  }
  const entries = Object.entries(doc.plugins ?? {});
  if (entries.length === 0) return [];

  // 启用状态以 settings.json 为准：读不到 enabledPlugins 时视为全部未启用（宁缺勿错，
  // 自动加载用户未启用的插件可能带入意外 MCP/hooks）
  const settings = readJson<SettingsDoc>(settingsPath);
  if (!settings.ok) {
    warnOnce(dir, 'settings-parse', `settings.json 无法解析（${settings.error}），无法确认插件启用状态，跳过插件自动发现`);
    return [];
  }
  const enabled = settings.doc.enabledPlugins ?? {};
  const enabledKeys = Object.entries(enabled).filter(([, v]) => v === true).map(([k]) => k);
  if (enabledKeys.length === 0) {
    warnOnce(dir, 'none-enabled', `已安装 ${entries.length} 个插件但 settings.json 未启用任何插件（enabledPlugins），跳过插件自动发现`);
    return [];
  }

  const out: DiscoveredPlugin[] = [];
  for (const key of enabledKeys) {
    const list = doc.plugins?.[key];
    if (!Array.isArray(list)) continue; // 安装清单与启用状态不一致：该键无安装记录，静默跳过
    // 同键可能有多条（不同 scope），取 scope=user 的第一条
    const item = list.find((it) => it.scope === 'user');
    if (!item) continue;
    const installPath = typeof item.installPath === 'string' ? item.installPath : '';
    if (!installPath) {
      warnOnce(dir, `no-path:${key}`, `插件 ${key} 的安装记录缺少 installPath，已跳过`);
      continue;
    }
    if (!existsSync(installPath)) {
      warnOnce(dir, `missing:${key}`, `插件 ${key} 的安装目录不存在：${installPath}（可能已卸载未清理），已跳过`);
      continue;
    }
    const at = key.indexOf('@');
    out.push({
      name: at > 0 ? key.slice(0, at) : key,
      marketplace: at > 0 ? key.slice(at + 1) : undefined,
      path: installPath,
      version: typeof item.version === 'string' ? item.version : undefined,
    });
  }
  return out;
}

/**
 * 显式配置（config.yaml apps[].plugins，开发期指源码目录）与自动发现结果合并：
 * 按插件名去重，显式优先——防「显式指 dev 副本 + 缓存里正式版」双载导致技能重复。
 */
export function resolvePluginPaths(
  explicit: PluginRef[] | undefined,
  discovered: DiscoveredPlugin[],
): Array<{ name: string; path: string; source: 'explicit' | 'discovered' }> {
  const out: Array<{ name: string; path: string; source: 'explicit' | 'discovered' }> = [];
  const seen = new Set<string>();
  for (const p of explicit ?? []) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ name: p.name, path: p.path, source: 'explicit' });
  }
  for (const p of discovered) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ name: p.name, path: p.path, source: 'discovered' });
  }
  return out;
}
