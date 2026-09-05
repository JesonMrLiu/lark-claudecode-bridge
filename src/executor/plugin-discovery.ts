// 插件自动发现：SDK 不会自动加载 CLI 经 marketplace 安装的插件，须显式传安装路径。
// 从 Claude Code 数据目录读取 installed_plugins.json（安装清单）+ settings.json 的
// enabledPlugins（启用状态），把 scope=user 且已启用的插件 installPath 转成 SDK plugins 选项。
// 全程容错：文件缺失/格式异常一律 warn-once 后返回空，绝不阻断任务（插件加载失败 ≠ 桥接器不可用）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/** 主动清缓存：/plugin install 等操作后调用，消除粗粒度文件系统 mtime 同秒不变化的风险 */
export function invalidatePluginCache(claudeConfigDir: string): void {
  cache.delete(claudeConfigDir);
}

/** 已安装插件全量清单（含未启用项；Web 配置页 /api/plugins 用）。文件缺失返回空 */
export function listInstalledPlugins(claudeConfigDir: string): Array<{
  key: string; name: string; marketplace?: string; enabled: boolean; path?: string; version?: string;
}> {
  const installed = readJson<InstalledPluginsDoc>(join(claudeConfigDir, 'plugins', 'installed_plugins.json'));
  if (!installed.ok || installed.doc.version !== 2) return [];
  const settings = readJson<SettingsDoc>(join(claudeConfigDir, 'settings.json'));
  const enabledMap = settings.ok ? (settings.doc.enabledPlugins ?? {}) : {};
  const out: Array<{ key: string; name: string; marketplace?: string; enabled: boolean; path?: string; version?: string }> = [];
  for (const [key, list] of Object.entries(installed.doc.plugins ?? {})) {
    if (!Array.isArray(list)) continue;
    const item = list.find((it) => it.scope === 'user') ?? list[0];
    const at = key.indexOf('@');
    out.push({
      key,
      name: at > 0 ? key.slice(0, at) : key,
      marketplace: at > 0 ? key.slice(at + 1) : undefined,
      enabled: enabledMap[key] === true,
      ...(typeof item?.installPath === 'string' && item.installPath ? { path: item.installPath } : {}),
      ...(typeof item?.version === 'string' ? { version: item.version } : {}),
    });
  }
  return out;
}

/** 市场清单（marketplace.json）里的可安装插件条目 */
export interface MarketplacePluginEntry {
  name: string;
  description?: string;
  version?: string;
}

/** 一个市场的可安装插件目录（安装下拉数据源） */
export interface MarketplaceCatalog {
  /** 市场名（marketplaces/ 下的目录名，即 install key "name@marketplace" 的 @ 后段） */
  name: string;
  description?: string;
  plugins: MarketplacePluginEntry[];
}

/** marketplace.json 的已知形状；字段异常时按市场/条目粒度防御跳过 */
interface MarketplaceDoc {
  name?: string;
  description?: string;
  plugins?: Array<{ name?: string; description?: string; version?: string }>;
}

/**
 * 列出 <claudeConfigDir>/plugins/marketplaces/* 各市场 .claude-plugin/marketplace.json
 * 声明的可安装插件（Web 配置页「安装」下拉数据源；CLI 语义：install 只能装已添加市场里的插件）。
 * 目录缺失（未 marketplace add 过）返回空；单个市场清单损坏按市场粒度跳过，不影响其余。
 */
export function listAvailablePlugins(claudeConfigDir: string): MarketplaceCatalog[] {
  const marketRoot = join(claudeConfigDir, 'plugins', 'marketplaces');
  let entries;
  try {
    entries = readdirSync(marketRoot, { withFileTypes: true });
  } catch {
    return []; // 市场根目录不存在 = 尚未添加任何市场，正常态
  }
  const out: MarketplaceCatalog[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = readJson<MarketplaceDoc>(join(marketRoot, entry.name, '.claude-plugin', 'marketplace.json'));
    if (!manifest.ok) continue;
    const plugins: MarketplacePluginEntry[] = [];
    for (const p of manifest.doc.plugins ?? []) {
      if (typeof p?.name !== 'string' || !p.name) continue;
      plugins.push({
        name: p.name,
        ...(typeof p.description === 'string' ? { description: p.description } : {}),
        ...(typeof p.version === 'string' && p.version ? { version: p.version } : {}),
      });
    }
    out.push({
      name: entry.name,
      ...(typeof manifest.doc.description === 'string' ? { description: manifest.doc.description } : {}),
      plugins,
    });
  }
  return out;
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
