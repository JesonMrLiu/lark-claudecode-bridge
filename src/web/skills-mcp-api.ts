// Skills / MCP 管理纯函数层（#12）：
//  - Skills 三来源：本机 ~/.claude/skills（用户级·本机）、bridge 自管 <CONFIG_DIR>/claude/skills
//    （用户级·bridge，managed 模式生效目录）、各工作区 <ws>/.claude/skills（项目级）
//  - MCP 三来源：bridge 自管 <CONFIG_DIR>/mcp/servers.json（页面可管理，executeTask 注入生效）、
//    本机 ~/.claude.json 的 mcpServers（用户级·本机，展示+可删）、各工作区 .mcp.json（项目级，只读）
//  - claude mcp add / add-json 命令解析（页面「原生命令方式」添加）
//  - env ${VAR} 引用展开（抽屉展示当前值）
// 本模块无 IO 副作用（读盘聚合由调用方注入目录），tests/web/skills-mcp-api.test.ts 直接单测
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CLAUDE_DIR, MANAGED_CLAUDE_DIR } from '../claude-config.js';
import { CONFIG_DIR } from '../config.js';

// ---------------- Skills ----------------

/** skill 来源：machine-user = 本机 ~/.claude/skills；bridge = bridge 自管目录（managed 生效）；
 *  project = 工作区 .claude/skills（workspaceName 标注归属）；plugin = 已装插件目录内
 *  <plugin-installPath>/skills（pluginName 标注归属 + pluginEnabled 标注启用状态） */
export type SkillSource = 'machine-user' | 'bridge' | 'project' | 'plugin';

/** 插件简表（server.ts 注入扫描层用；插件 installPath 已存在则参与 skill/mcp 聚合） */
export interface PluginLite { name: string; path: string; enabled: boolean }

export interface SkillSummary {
  /** 目录名 = skill name（约束：与 SKILL.md frontmatter.name 一致，目录名作主键以兼容历史目录式布局） */
  name: string;
  /** SKILL.md frontmatter 的 description（缺省空串） */
  description: string;
  /** skill 所在目录绝对路径 */
  path: string;
  source: SkillSource;
  /** project 来源时的工作区名（前端标签展示「项目级 · <名>」） */
  workspaceName?: string;
  /** plugin 来源时的插件名（前端标签展示「插件 · <名>」） */
  pluginName?: string;
  /** plugin 来源时的启用状态（前端 chip 在未启用时追加「（未启用）」） */
  pluginEnabled?: boolean;
}

/** 简单 frontmatter 解析：仅取 name / description 两个键，避开 yaml 依赖；非法格式返回空字段 */
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith('---')) return {};
  const end = md.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = md.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z_-][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].replace(/^["']|["']$/g, '').trim();
    if (key === 'name' && val) out.name = val;
    else if (key === 'description' && val) out.description = val;
  }
  return out;
}

/**
 * 扫描单个 skills 目录，列出 SKILL.md frontmatter 摘要。
 * 缺目录返回空数组（用户首次访问功能时优雅呈现「暂无 skill」而非报错）
 */
export function listSkills(rootDir: string, source: SkillSource, workspaceName?: string): SkillSummary[] {
  if (!existsSync(rootDir)) return [];
  let entries: string[];
  try {
    const raw = readdirSync(rootDir);
    entries = [];
    for (const n of raw) {
      try { if (statSync(join(rootDir, n.toString())).isDirectory()) entries.push(n.toString()); }
      catch { /* 单条 stat 失败跳过 */ }
    }
  } catch { return []; }
  const out: SkillSummary[] = [];
  for (const name of entries) {
    const skillPath = join(rootDir, name);
    const mdPath = join(skillPath, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    let md: string;
    try { md = readFileSync(mdPath, 'utf8'); } catch { continue; }
    const fm = parseSkillFrontmatter(md);
    out.push({ name, description: fm.description ?? '', path: skillPath, source, ...(workspaceName ? { workspaceName } : {}) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** skill 三来源目录清单（server.ts 聚合调用；workspaces 由 config 提供） */
export function skillRoots(workspaces: Array<{ name: string; path: string }>): Array<{
  dir: string; source: SkillSource; workspaceName?: string;
}> {
  return [
    { dir: join(DEFAULT_CLAUDE_DIR, 'skills'), source: 'machine-user' as const },
    { dir: join(MANAGED_CLAUDE_DIR, 'skills'), source: 'bridge' as const },
    ...workspaces.map((w) => ({ dir: join(w.path, '.claude', 'skills'), source: 'project' as const, workspaceName: w.name })),
  ];
}

/**
 * 全量 skills 聚合（#12 + 插件来源补全）：三目录来源 + 已装插件目录。
 * 插件来源遍历 plugins，每个扫 `<plugin.path>/skills`，每条标 source=plugin + pluginName/pluginEnabled。
 * 沿用 listSkills 单目录版做底；同名 skill 允许跨来源并存（删除按 source+workspaceName/pluginName 定位互不串扰）
 */
export function listAllSkills(
  workspaces: Array<{ name: string; path: string }>,
  plugins: PluginLite[],
): SkillSummary[] {
  const out: SkillSummary[] = [];
  for (const r of skillRoots(workspaces)) {
    out.push(...listSkills(r.dir, r.source, r.workspaceName));
  }
  for (const p of plugins) {
    for (const s of listSkills(join(p.path, 'skills'), 'plugin')) {
      out.push({ ...s, pluginName: p.name, pluginEnabled: p.enabled });
    }
  }
  return out;
}

/** skill 名合法字符：字母数字下划线连字符（与 SKILL.md frontmatter 约束一致，避开路径穿越） */
export const SKILL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------- MCP ----------------

/** MCP server 来源：bridge = <CONFIG_DIR>/mcp/servers.json（页面管理 + 注入生效）；
 *  machine-user = ~/.claude.json mcpServers（展示+可删，页面不再写入）；project = 工作区 .mcp.json（只读）；
 *  plugin = 已装插件目录内 <plugin-installPath>/.mcp.json（pluginName + pluginEnabled 同 skill） */
export type McpSource = 'bridge' | 'machine-user' | 'project' | 'plugin';

/** MCP server 入口（mcpServers[name] = { type?, command?, args?, env?, url?, ... }） */
export interface McpServerEntry {
  name: string;
  /** 原 JSON 值（type/command/args/env/url 等任意字段，原样回传前端供编辑） */
  config: Record<string, unknown>;
  source: McpSource;
  /** project 来源时的工作区名 */
  workspaceName?: string;
  /** plugin 来源时的插件名 */
  pluginName?: string;
  /** plugin 来源时的启用状态 */
  pluginEnabled?: boolean;
  /** 所属配置文件绝对路径（前端展示） */
  path: string;
}

/** bridge 自管 MCP 配置文件（页面添加统一落这里；executeTask 每任务现读注入 SDK） */
export const BRIDGE_MCP_JSON = join(CONFIG_DIR, 'mcp', 'servers.json');
/** 本机用户级 Claude CLI 配置（mcpServers 字段；只展示+可删） */
export const USER_CLAUDE_JSON = join(homedir(), '.claude.json');

/** 解析 JSON 文件的 mcpServers 段；文件不存在/解析失败返回空（缺失不报错——首装常态） */
export function readMcpServersFromJsonFile(file: string): { servers: Record<string, Record<string, unknown>>; exists: boolean } {
  if (!existsSync(file)) return { servers: {}, exists: false };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> };
    const servers = raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)
      ? raw.mcpServers
      : {};
    return { servers, exists: true };
  } catch {
    return { servers: {}, exists: false };
  }
}

/**
 * 读取插件清单 .claude-plugin/plugin.json 内的 mcpServers 字段（Claude Code 插件规范的第二 MCP 位置——
 * 独立 .mcp.json 之外的清单内嵌形态）。同一 plugin 两处都写时调用方需自行决定优先级。
 */
export function readPluginMcpFromManifest(pluginDir: string): { servers: Record<string, Record<string, unknown>>; exists: boolean } {
  return readMcpServersFromJsonFile(join(pluginDir, '.claude-plugin', 'plugin.json'));
}

/** 聚合 MCP 三来源清单（server.ts GET /api/mcp 调用；workspaces 由 config 提供，plugins 提供插件来源） */
export function listMcpServers(
  workspaces: Array<{ name: string; path: string }>,
  plugins: PluginLite[] = [],
): McpServerEntry[] {
  const out: McpServerEntry[] = [];
  const push = (file: string, source: McpSource, workspaceName?: string, pluginName?: string, pluginEnabled?: boolean): void => {
    for (const [name, cfg] of Object.entries(readMcpServersFromJsonFile(file).servers)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const entry: McpServerEntry = {
        name, config: cfg, source, path: file,
        ...(workspaceName ? { workspaceName } : {}),
        ...(pluginName ? { pluginName, pluginEnabled: !!pluginEnabled } : {}),
      };
      out.push(entry);
    }
  };
  push(BRIDGE_MCP_JSON, 'bridge');
  push(USER_CLAUDE_JSON, 'machine-user');
  for (const w of workspaces) push(join(w.path, '.mcp.json'), 'project', w.name);
  // plugin 来源合并两种位置：独立 .mcp.json 优先（作者有意独立写则尊重），再用清单内 mcpServers 字段补
  for (const p of plugins) {
    const a = readMcpServersFromJsonFile(join(p.path, '.mcp.json'));
    const b = readPluginMcpFromManifest(p.path);
    const merged: Record<string, Record<string, unknown>> = { ...b.servers, ...a.servers };
    for (const [name, cfg] of Object.entries(merged)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const entry: McpServerEntry = {
        name, config: cfg, source: 'plugin', path: a.exists && name in a.servers ? join(p.path, '.mcp.json') : join(p.path, '.claude-plugin', 'plugin.json'),
        pluginName: p.name, pluginEnabled: !!p.enabled,
      };
      out.push(entry);
    }
  }
  out.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  return out;
}

/** MCP server 名合法字符（避用 / \ 与空格等，与磁盘配置键兼容） */
export const MCP_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// ---------------- claude mcp add 命令解析 ----------------

export type ParsedMcpCommand = { ok: true; name: string; config: Record<string, unknown> } | { ok: false; error: string };

/**
 * 解析 `claude mcp add` / `claude mcp add-json` 命令子集（页面「原生命令方式」添加）：
 *   claude mcp add <name> [-s scope] [-t stdio|http|sse] [-e KEY=VAL]... [-H "k: v"]... [--] <command> [args...]
 *   claude mcp add-json <name> '<json>'
 * scope（-s/--scope）忽略——页面添加统一进 bridge 目录；<command> 为 http(s) URL 时按 http 类型处理。
 */
/** shell 风格分词：引号内的空格不断词（-H "Authorization: Bearer x" 是单参数），引号本身剥离 */
function shellTokens(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function parseClaudeMcpAdd(cmd: string): ParsedMcpCommand {
  const tokens = shellTokens(cmd);
  if (tokens.length < 4 || tokens[0] !== 'claude' || tokens[1] !== 'mcp') {
    return { ok: false, error: '命令须以 "claude mcp add" 或 "claude mcp add-json" 开头' };
  }
  const name = tokens[3];
  if (!MCP_NAME_RE.test(name)) {
    return { ok: false, error: `名字 "${name}" 不合法（1-64 位字母/数字/下划线/点/连字符）` };
  }
  if (tokens[2] === 'add-json') {
    const raw = tokens.slice(4).join(' ').trim().replace(/^["']|["']$/g, '');
    if (!raw) return { ok: false, error: 'add-json 缺少配置 JSON' };
    try {
      const cfg = JSON.parse(raw);
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, error: 'JSON 必须为对象' };
      return { ok: true, name, config: cfg as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (tokens[2] !== 'add') return { ok: false, error: '仅支持 add / add-json 子命令' };

  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let transport: string | undefined;
  let url: string | undefined;
  const argv: string[] = [];
  let i = 4;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { argv.push(...tokens.slice(i + 1)); break; }
    if (t === '-e' || t === '--env') {
      const kv = tokens[++i];
      const m = kv ? /^([^=]+)=(.*)$/.exec(kv) : null;
      if (!m) return { ok: false, error: `-e 参数格式应为 KEY=VAL（当前：${kv ?? '缺失'}）` };
      env[m[1]] = m[2];
      continue;
    }
    if (t === '-H' || t === '--header') {
      const hv = (tokens[++i] ?? '').replace(/^["']|["']$/g, '');
      const m = /^([^:]+):\s*(.*)$/.exec(hv);
      if (!m) return { ok: false, error: `-H 参数格式应为 "Key: Value"（当前：${hv || '缺失'}）` };
      headers[m[1].trim()] = m[2];
      continue;
    }
    if (t === '-t' || t === '--transport') {
      transport = tokens[++i];
      if (!transport || !['stdio', 'http', 'sse'].includes(transport)) {
        return { ok: false, error: `-t 传输类型须为 stdio / http / sse（当前：${transport ?? '缺失'}）` };
      }
      continue;
    }
    if (t === '-s' || t === '--scope') { i++; continue; } // scope 忽略：统一写 bridge 目录
    if (/^--(env|header|transport|scope)=/.test(t)) {
      // --key=value 长选项等价形态：拆回 key value 走同一分支
      const eq = t.indexOf('=');
      tokens.splice(i, 1, t.slice(0, eq), t.slice(eq + 1));
      i--;
      continue;
    }
    // 非选项 token：命令位（claude CLI 语义）——http(s) URL 按远程 server 处理，否则按 stdio 命令
    if (argv.length === 0 && /^https?:\/\//.test(t)) { url = t; continue; }
    argv.push(t);
  }
  if (url) {
    return { ok: true, name, config: { type: transport ?? 'http', url, ...(Object.keys(headers).length ? { headers } : {}) } };
  }
  if (argv.length === 0) return { ok: false, error: '缺少启动命令（stdio 形如 `-- npx -y xxx`，http 形如 `https://…`）' };
  const [command, ...args] = argv;
  return { ok: true, name, config: { type: transport ?? 'stdio', command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) } };
}

// ---------------- env 引用展开（抽屉展示当前值） ----------------

/** 展开配置 env 值中的 ${VAR} 引用为进程当前环境值；未设置的变量保留原样并计入 missing
 *  （前端对 missing 项标注「未设置」——抽屉「同步展示环境变量当前配置的值」的数据源） */
export function resolveEnvRefs(env: Record<string, unknown> | undefined): {
  resolved: Record<string, string>;
  missing: string[];
} {
  const resolved: Record<string, string> = {};
  const missing = new Set<string>();
  if (!env || typeof env !== 'object') return { resolved, missing: [] };
  for (const [k, v] of Object.entries(env)) {
    const raw = typeof v === 'string' ? v : JSON.stringify(v);
    resolved[k] = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, varName: string) => {
      const cur = process.env[varName];
      if (cur === undefined) { missing.add(varName); return whole; }
      return cur;
    });
  }
  return { resolved, missing: [...missing] };
}
