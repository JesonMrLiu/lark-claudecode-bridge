// Web 配置页 server：node:http 零新依赖，随 lcb start 常驻 / lcb ui 独立启动。
// 安全基线：默认只绑 127.0.0.1；Host/Origin 校验防 DNS rebinding；body ≤1MB；
// secret 永不出进程（GET 脱敏回显，PUT 空值=不修改）。改动写盘后由现有热重载器/重启消费
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import AdmZip from 'adm-zip';
import { CONFIG_DIR, CONFIG_PATH, SLASH_COMMAND_RE, loadConfig, parseConfigText } from '../config.js';
import { DEFAULT_CLAUDE_DIR, MANAGED_CLAUDE_DIR, initManagedClaudeDir, resolveClaudeDir } from '../claude-config.js';
import { switchProfile } from '../claude-profile.js';
import { hasClaudeAuth } from '../auth-precheck.js';
import { defaultPermissionsDoc, defaultServerDoc } from '../config-defaults.js';
import { VERSION } from '../version.js';
import type { BridgeConfig, ServerConfig } from '../types.js';
import { appStatusSummary, applyPermissionDisplayDefaults, applySecrets, claudeSettingsSummary, computeRestartRequired, docForClient, isAllowedHost, isAllowedOrigin, type ClaudeCurrentSummary } from './config-api.js';
import {
  BRIDGE_MCP_JSON, MCP_NAME_RE, SKILL_NAME_RE, USER_CLAUDE_JSON,
  listAllSkills, listMcpServers, listSkills, parseClaudeMcpAdd, readMcpServersFromJsonFile, readPluginMcpFromManifest, resolveEnvRefs, resolveSpawnCommand,
} from './skills-mcp-api.js';
import { fetchModelList, resolveModelFetchParams } from './model-list.js';
import { SLASH_COMMAND_META } from '../session/commands.js';
import { DEFAULT_ALLOW_TOOLS_LIST, DEFAULT_DANGEROUS_COMMAND_SOURCES } from '../executor/permission-gate.js';
import { openBrowser } from '../util/open-browser.js';
import { ensureRuntimeDirs } from '../util/runtime-dirs.js';
import { builtinCommands, createSlashApiClient, ensureBuiltins, expectedCommands, syncSlashCommands } from '../feishu/slash-commands.js';
import { runPluginCli, updateAllPlugins } from '../executor/plugin-manager.js';
import { invalidatePluginCache, listAvailablePlugins, listInstalledPlugins, loadEnabledPlugins } from '../executor/plugin-discovery.js';
import { bridgeStatus, resolveLcbEntry, restartBridgeWithHelper, spawnBridgeDetached, stopBridgeByPid } from './lifecycle.js';
import { checkUpdate, installMode, runUpdate } from './update.js';

/** PUT /api/config 参与整段替换的顶级键；body 未携带的键保持磁盘原文（含注释） */
const PUT_SECTIONS = ['apps', 'workspaces', 'defaults', 'concurrency', 'permissions', 'server', 'claude', 'slash_commands', 'transcripts', 'session', 'card'] as const;

export interface WebServerOptions {
  /** server 段配置；缺省用默认（firstRun 无配置文件场景） */
  server?: ServerConfig;
  configPath?: string;
  /** true = lcb start 内嵌（页面顶栏标识 + status.apps 显示启动态） */
  embedded?: boolean;
  /** 启动后自动开浏览器 */
  autoOpen?: boolean;
  appsStarted?: Array<{ name: string; started: boolean }>;
  /** embedded 模式下页面停止/重启自身进程的优雅关闭回调（lcb start 注入 shutdown） */
  selfStop?: () => void;
}

export interface WebServerHandle { url: string; port: number; close(): void }

const WEB_ROOT = fileURLToPath(new URL('../../assets/web', import.meta.url));
const INDEX_HTML_PATH = join(WEB_ROOT, 'index.html');
/** 静态模块仅限 js/css 两前缀 + 扩展名白名单（纵深防御：目录内误放的敏感文件不可被 serve） */
const STATIC_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const BODY_LIMIT = 1024 * 1024;
const startedAt = Date.now();

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${Math.floor(limit / 1024 / 1024)}MB 上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readJsonBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  return readBody(req, limit).then((text) => {
    if (!text.trim()) return {};
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('请求体必须为 JSON 对象');
    return v as Record<string, unknown>;
  });
}

/**
 * 原子写盘（tmp + rename），与 claude-config 同款防半截文件。
 * - 先递归建父目录：首装 bootstrap 时 ~/.lark-claudecode-bridge 可能尚不存在
 *   （lcb start/ui 仅起 Web server 不建目录），缺 mkdir 直接 ENOENT（0.17.0 首装保存报错根因）；
 * - tmp 带 pid 后缀：固定名在并发 PUT（多标签页/双击保存）下会发生 A rename 消费掉
 *   B 的 tmp、B rename 报 ENOENT 的竞态（claude-profile.ts 同款防法）。
 */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/** 盘符根（C:\）/ posix 根（/）无上级 → null（前端据此回到根/盘符列表层） */
function parentOf(abs: string): string | null {
  return parse(abs).root === abs ? null : dirname(abs);
}

/**
 * 目录浏览（工作区路径选择弹层数据源）：列出某路径下的子目录与上级导航。
 * 只返回目录名不返回文件。手输路径跳转是浏览常态操作，出错（不存在/不是目录/
 * 无权限）不打断弹层——200 + error 字段内联展示；盘符根之上的「此电脑」层用
 * drives（Windows 专属，逐盘符 existsSync 探测）。
 */
function listSubdirs(input: string): {
  path: string; parent: string | null; dirs: string[]; drives?: string[]; error?: string;
} {
  if (!input.trim()) {
    if (process.platform === 'win32') {
      const drives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`).filter((d) => existsSync(d));
      return { path: '', parent: null, dirs: [], drives };
    }
    return listSubdirs('/');
  }
  const abs = resolve(input);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { path: abs, parent: parentOf(abs), dirs: [], error: '路径不存在' };
  }
  if (!st.isDirectory()) {
    return { path: abs, parent: parentOf(abs), dirs: [], error: '该路径不是目录' };
  }
  try {
    const dirs = readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    return { path: abs, parent: parentOf(abs), dirs };
  } catch (e) {
    return { path: abs, parent: parentOf(abs), dirs: [], error: `无法读取：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 读 Claude 配置目录下 settings.json（不存在/损坏 → undefined；内容仅供脱敏摘要） */
function readSettingsJson(dir: string): unknown {
  try {
    const p = join(dir, 'settings.json');
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

/** managed 模式时把 claude 段最新认证立即同步进自管目录 settings.json（后续任务即生效，无需等重启） */
function syncManagedClaude(config: BridgeConfig): void {
  if (config.claude?.mode === 'managed') initManagedClaudeDir(config);
}

/** 从磁盘原文读 snake_case doc（PUT 的 secret 回填基准） */
function readRawDoc(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  try {
    return parseDocument(readFileSync(configPath, 'utf8')).toJS() as Record<string, unknown>;
  } catch {
    return null; // 磁盘文件损坏：PUT 走全量重建路径（parseDocument 抛错由调用方处理）
  }
}

export async function startWebServer(opts: WebServerOptions = {}): Promise<WebServerHandle | null> {
  ensureRuntimeDirs(); // 独立入口兜底：即使不经 lcb CLI（测试/嵌入式调用），首装写盘也有目录
  const serverCfg = opts.server ?? (defaultServerDoc() as unknown as ServerConfig);
  if (serverCfg.enabled === false) return null;
  const configPath = opts.configPath ?? CONFIG_PATH;
  const host = serverCfg.host ?? '127.0.0.1';
  let port = serverCfg.port ?? 17317; // listen 后回写实际端口：port:0 随机分配时 Origin 校验须用实际值

  const server: Server = createServer((req, res) => {
    void handle(req, res, { configPath, host, port, embedded: opts.embedded ?? false, appsStarted: opts.appsStarted, selfStop: opts.selfStop }).catch((e) => {
      console.error('[配置页] 请求处理异常：', e);
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  port = (server.address() as { port: number }).port;
  const url = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  console.log(`🧭 配置页已就绪：${url}${opts.embedded ? '' : '（lcb ui 独立模式，桥接器未启动）'}`);
  if (opts.autoOpen) openBrowser(url);
  return {
    url,
    port,
    close: () => server.close(),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    configPath: string; host: string; port: number;
    embedded: boolean; appsStarted?: Array<{ name: string; started: boolean }>;
    selfStop?: () => void;
  },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  // 每请求现查（不能用启动快照）：bootstrap 写盘成功后，后续请求立即按「已有配置」处理
  const firstRun = !existsSync(ctx.configPath);
  // 安全闸：Host / Origin 校验（防 DNS rebinding 拿本机页面读写配置）
  if (!isAllowedHost(req.headers.host, ctx.host) || !isAllowedOrigin(req.headers.origin, ctx.host, ctx.port)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  // 静态页与模块：入口单文件 + js/css 目录服务（防穿越见下）
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    try {
      const html = readFileSync(INDEX_HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('配置页资源缺失（assets/web/index.html）');
    }
    return;
  }
  // js/css 静态模块：decode → resolve 归一 → 必须仍在 WEB_ROOT 内（前缀+分隔符，杜绝同前缀绕过）
  // + 扩展名白名单第二道闸；非文件（目录）→ 404，无目录列举。目录内新增页面模块无需改后端
  if (req.method === 'GET' && (path.startsWith('/js/') || path.startsWith('/css/'))) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad encoding');
      return;
    }
    const mime = STATIC_MIME[extname(decoded).toLowerCase()];
    const file = resolve(WEB_ROOT, `.${decoded}`);
    if (!mime || !file.startsWith(WEB_ROOT + sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
    return;
  }
  if (path === '/api/status' && req.method === 'GET') {
    let claude: { mode: string; hasAuth: boolean | null; current?: ClaudeCurrentSummary; settingsPath?: string } = { mode: 'inherit', hasAuth: null };
    let apps: ReturnType<typeof appStatusSummary> = [];
    if (!firstRun) {
      try {
        const config = loadConfig(ctx.configPath);
        const dir = resolveClaudeDir(config);
        claude = {
          mode: config.claude?.mode ?? 'inherit',
          hasAuth: hasClaudeAuth(process.env as Record<string, string | undefined>, dir),
          // 当前实际生效配置（inherit=~/.claude 状态 / managed=自管目录），凭证脱敏不出进程
          current: claudeSettingsSummary(readSettingsJson(dir)),
          settingsPath: join(dir, 'settings.json'),
        };
        apps = appStatusSummary(config.apps, ctx.appsStarted);
      } catch { /* 磁盘配置损坏：status 仍可用（页面提示重配） */ }
    }
    return json(res, 200, {
      version: VERSION, uptimeMs: Date.now() - startedAt, configPath: ctx.configPath,
      firstRun, embedded: ctx.embedded,
      bridge: { ...bridgeStatus(), spawnable: resolveLcbEntry().ok },
      server: { host: ctx.host, port: ctx.port },
      claude, apps,
      // 内置命令清单（概览「常用命令」卡）与权限运行时默认（权限页「恢复默认」）——均与配置无关的静态单源
      commands: Object.entries(SLASH_COMMAND_META).map(([command, meta]) => ({ command, description: meta.description })),
      permissionDefaults: {
        allowTools: [...DEFAULT_ALLOW_TOOLS_LIST],
        dangerousCommands: [...DEFAULT_DANGEROUS_COMMAND_SOURCES],
      },
    });
  }
  // ---- 目录浏览（工作区路径选择弹层；不依赖配置文件，首装向导同样可用） ----
  if (path === '/api/fs/dirs' && req.method === 'GET') {
    return json(res, 200, listSubdirs(url.searchParams.get('p') ?? ''));
  }
  if (path === '/api/config' && req.method === 'GET') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请提交 bootstrap 向导' });
    const rawDoc = readRawDoc(ctx.configPath);
    if (rawDoc === null) return json(res, 500, { error: 'config.yaml 读取失败（语法错误？），lcb setup 或手工修复后重试' });
    return json(res, 200, applyPermissionDisplayDefaults(docForClient(rawDoc)));
  }
  if (path === '/api/config' && req.method === 'PUT') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件，请先提交 bootstrap 向导' });
    const body = await readJsonBody(req);
    // secret 回填：以磁盘原文为基准，客户端未改的 secret 字段（空/缺省/仍是脱敏对象）回填现值
    const rawText = readFileSync(ctx.configPath, 'utf8');
    const oldJs = parseDocument(rawText).toJS() as Record<string, unknown>;
    const merged = applySecrets(body, oldJs);
    const doc = parseDocument(rawText);
    for (const key of PUT_SECTIONS) {
      if (merged[key] === undefined) continue;
      // 值未变的段落跳过重写：整段 set 会丢掉段内手写注释（ws-manager 同款折损），「打开页面直接保存」应无损
      if (JSON.stringify(merged[key]) === JSON.stringify(oldJs[key] ?? null)) continue;
      doc.set(key, merged[key]);
    }
    const text = doc.toString();
    let after: BridgeConfig;
    try {
      after = parseConfigText(text, ctx.configPath); // 写盘前内存校验：拒绝坏配置落盘
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    let restartRequired: string[] = [];
    try {
      restartRequired = computeRestartRequired(loadConfig(ctx.configPath), after);
    } catch { /* 磁盘原配置损坏：全部视为需重启 */ restartRequired = ['apps', 'concurrency', 'claude', 'server']; }
    writeAtomic(ctx.configPath, text);
    syncManagedClaude(after);
    return json(res, 200, { ok: true, restartRequired });
  }
  // ---- 模型列表拉取（厂商无关；凭证用磁盘现值或本次表单输入，响应只含模型 id，绝不回传凭证） ----
  if (path === '/api/models/fetch' && req.method === 'POST') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件，请先完成 bootstrap' });
    const body = await readJsonBody(req);
    let config: BridgeConfig;
    try {
      config = loadConfig(ctx.configPath);
    } catch (e) {
      return json(res, 500, { error: `配置加载失败：${e instanceof Error ? e.message : String(e)}` });
    }
    const resolved = resolveModelFetchParams(body, config.claude);
    if ('error' in resolved) return json(res, 400, { error: resolved.error });
    try {
      const models = await fetchModelList(resolved);
      return json(res, 200, { models });
    } catch (e) {
      return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // ---- 切换当前生效厂商档案：前端拿不到档案凭证明文（脱敏模型），切换必须由后端完成并即时落盘。
  //      内核在 claude-profile.ts（飞书端 /model-profile 命令复用同一份逻辑），此处仅 HTTP 薄壳 ----
  if (path === '/api/claude/use-profile' && req.method === 'POST') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件，请先完成 bootstrap' });
    const body = await readJsonBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) return json(res, 400, { error: '缺少档案名 name' });
    const r = switchProfile(ctx.configPath, name, String(body.model ?? '').trim() || undefined);
    return r.ok ? json(res, 200, r) : json(res, r.status, { error: r.error });
  }
  if (path === '/api/bootstrap' && req.method === 'POST') {
    if (!firstRun) return json(res, 409, { error: '配置文件已存在（bootstrap 仅用于首次安装），请改用配置页编辑' });    const body = await readJsonBody(req);
    const apps = Array.isArray(body.apps) ? body.apps : [];
    const ws = body.workspace && typeof body.workspace === 'object' ? body.workspace as Record<string, unknown> : null;
    if (apps.length === 0 || !ws?.name || !ws?.path) {
      return json(res, 400, { error: 'bootstrap 需要 apps（≥1 个应用凭证）与 workspace（name/path）' });
    }
    const doc: Record<string, unknown> = {
      apps,
      workspaces: [{ name: String(ws.name), path: String(ws.path) }],
      defaults: { workspace: String(ws.name) },
      concurrency: 3,
      permissions: defaultPermissionsDoc(),
      server: defaultServerDoc(),
      ...(body.claude && typeof body.claude === 'object' ? { claude: body.claude } : {}),
    };
    const text = stringify(doc);
    let config: BridgeConfig;
    try {
      config = parseConfigText(text, ctx.configPath);
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    writeAtomic(ctx.configPath, text);
    syncManagedClaude(config);
    return json(res, 200, { ok: true, message: '配置已写入。请启动/重启 lcb start 开始使用' });
  }
  // ---- 斜杠命令（需已配置 app 凭证；lcb ui 独立进程同样可用） ----
  if (path.startsWith('/api/slash-commands')) {
    if (firstRun) return json(res, 404, { error: '尚无配置文件，请先完成 bootstrap' });
    let config: BridgeConfig;
    try {
      config = loadConfig(ctx.configPath);
    } catch (e) {
      return json(res, 500, { error: `配置加载失败：${e instanceof Error ? e.message : String(e)}` });
    }
    if (path === '/api/slash-commands/expected' && req.method === 'GET') {
      return json(res, 200, { expected: expectedCommands(config) });
    }
    const body = path === '/api/slash-commands/remote' && req.method === 'GET'
      ? {}
      : await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
    const appName = path === '/api/slash-commands/remote'
      ? url.searchParams.get('app')
      : String(body.app ?? '');
    const app = config.apps.find((a) => a.name === appName || a.appId === appName);
    if (!app) return json(res, 400, { error: `应用 "${String(appName)}" 不存在，可用：${config.apps.map((a) => a.name).join('、')}` });
    const client = createSlashApiClient(app);
    try {
      if (path === '/api/slash-commands/remote' && req.method === 'GET') {
        return json(res, 200, { remote: await client.list() });
      }
      if (path === '/api/slash-commands/sync' && req.method === 'POST') {
        // mode=builtins-only 只补齐缺失的内置命令（绝不删除远端已有命令）；缺省全量对齐（兼容既有 API/脚本）
        const report = body.mode === 'builtins-only'
          ? await ensureBuiltins(client, builtinCommands())
          : await syncSlashCommands(client, expectedCommands(config));
        return json(res, 200, report);
      }
      if (path === '/api/slash-commands/action' && req.method === 'POST') {
        // 远端单条 CRUD（0.13 页面直操作飞书 API；与 config.yaml 的 slash_commands.extra 无关）
        const op = String(body.op ?? '');
        const command = String(body.command ?? '').trim();
        const commandId = String(body.commandId ?? '').trim();
        const description = String(body.description ?? '').trim();
        const icon = String(body.icon ?? '').trim();
        if (op === 'create') {
          if (!command) return json(res, 400, { error: '缺少 command（命令名，不带 /）' });
          if (!SLASH_COMMAND_RE.test(command)) return json(res, 400, { error: `command "${command}" 须为 1-32 位字母/数字/下划线/连字符` });
          if (!description) return json(res, 400, { error: '缺少 description（飞书指令面板展示用）' });
          const id = await client.create({ command, description, ...(icon ? { icon } : {}) });
          return json(res, 200, { ok: true, commandId: id });
        }
        if (op === 'update') {
          if (!commandId) return json(res, 400, { error: 'update 需要 commandId（列表行的飞书侧命令 ID）' });
          if (!description) return json(res, 400, { error: '缺少 description（飞书 PATCH 仅支持描述与图标，命令名不可改）' });
          await client.update(commandId, { command: command || '(unchanged)', description, ...(icon ? { icon } : {}) });
          return json(res, 200, { ok: true });
        }
        if (op === 'delete') {
          if (!commandId) return json(res, 400, { error: 'delete 需要 commandId（列表行的飞书侧命令 ID）' });
          await client.remove(commandId);
          return json(res, 200, { ok: true });
        }
        return json(res, 400, { error: `未知 op "${op}"（支持 create / update / delete）` });
      }
    } catch (e) {
      // API 原文透传（缺 scope 等场景页面直接展示开放平台错误）
      return json(res, 502, { error: `飞书 API 调用失败：${e instanceof Error ? e.message : String(e)}（请确认已开通 application:app_slash_command 读写权限并发布版本）` });
    }
  }
  // ---- 插件管理（本机页面即可操作；与飞书端 /plugin 命令同一执行器） ----
  // managed 模式双目录：自管目录（bridge）+ 本机 ~/.claude（user）。会话加载合并两处
  //（index.ts discoverPlugins 合并）；安装默认装 ~/.claude（与本机 claude CLI 共用一份）
  if (path.startsWith('/api/plugins')) {
    if (firstRun) return json(res, 404, { error: '尚无配置文件，请先完成 bootstrap' });
    let config: BridgeConfig;
    try {
      config = loadConfig(ctx.configPath);
    } catch (e) {
      return json(res, 500, { error: `配置加载失败：${e instanceof Error ? e.message : String(e)}` });
    }
    const bridgeDir = resolveClaudeDir(config);
    const userDir = DEFAULT_CLAUDE_DIR;
    const sameDir = bridgeDir === userDir;
    if (path === '/api/plugins' && req.method === 'GET') {
      // 市场清单里的最新可装版本，附到已装插件上（前端「0.7.0 → 0.7.1」有新版提示）；
      // 优先按 name@marketplace 精确匹配，市场名对不上时退化按插件名（提示性质，宁多勿漏）
      const from = (dir: string, source: 'bridge' | 'user') => {
        const latestByKey = new Map<string, string>();
        const latestByName = new Map<string, string>();
        for (const m of listAvailablePlugins(dir)) {
          for (const p of m.plugins) {
            if (!p.version) continue;
            latestByKey.set(`${p.name}@${m.name}`, p.version);
            latestByName.set(p.name, p.version);
          }
        }
        return listInstalledPlugins(dir).map((p) => {
          const latest = (p.marketplace && latestByKey.get(`${p.name}@${p.marketplace}`)) ?? latestByName.get(p.name);
          return { ...p, source, ...(latest && latest !== p.version ? { latestVersion: latest } : {}) };
        });
      };
      return json(res, 200, {
        configDir: bridgeDir,
        userDir,
        // inherit 模式两目录相同 → 单份（source=user）；managed 合并两处各自可启停
        plugins: sameDir ? from(bridgeDir, 'user') : [...from(bridgeDir, 'bridge'), ...from(userDir, 'user')],
      });
    }
    if (path === '/api/plugins/available' && req.method === 'GET') {
      // 安装下拉数据源：该目录已添加市场声明的可安装插件（CLI 语义：install 只能装已添加市场里的）
      const dir = url.searchParams.get('dir') === 'bridge' ? bridgeDir : userDir;
      return json(res, 200, { marketplaces: listAvailablePlugins(dir) });
    }
    if (path === '/api/plugins/action' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const arg = String(body.arg ?? '').trim();
      const op = String(body.op ?? '');
      // 目标目录：enable/disable/uninstall 前端按插件来源传 dir；install/marketplace 缺省装本机 ~/.claude
      const dir = body.dir === 'bridge' ? bridgeDir : userDir;
      const argsTable: Record<string, string[]> = {
        install: arg ? ['install', arg] : [],
        uninstall: arg ? ['uninstall', arg] : [],
        enable: arg ? ['enable', arg] : [],
        disable: arg ? ['disable', arg] : [],
        update: arg ? ['update', arg] : [],
        'marketplace-add': arg ? ['marketplace', 'add', arg] : [],
        'marketplace-remove': arg ? ['marketplace', 'remove', arg] : [],
        'marketplace-update': ['marketplace', 'update', ...(arg ? [arg] : [])],
      };
      // 全部更新 = 刷新市场索引 + 逐个更新已装插件（marketplace update 不会升级已装插件本体）
      if (op === 'update-all') {
        const r = await updateAllPlugins(dir);
        invalidatePluginCache(bridgeDir);
        if (!sameDir) invalidatePluginCache(userDir);
        return json(res, 200, r);
      }
      const args = argsTable[op];
      if (!args || args.length === 0) return json(res, 400, { error: `操作 ${op || '(空)'} 需要参数或未知` });
      const r = await runPluginCli(args, { claudeConfigDir: dir });
      invalidatePluginCache(bridgeDir);
      if (!sameDir) invalidatePluginCache(userDir);
      // 卸载后校验：CLI 退出码 0 但 installed_plugins.json 仍留有条目 = 半完成卸载
      // （仅从 enabledPlugins 移除、安装记录未清，CLI /plugins list 里表现为 disabled）。
      // 显式失败返回，把 CLI 输出带给前端，避免「以为卸载了其实只是禁用」
      if (op === 'uninstall' && r.ok && listInstalledPlugins(dir).some((p) => p.key === arg)) {
        return json(res, 200, {
          ok: false,
          text: `卸载后 ${arg} 仍存在于安装清单（installed_plugins.json 未清除，可能仅被禁用）。CLI 输出：\n${r.text}\n可尝试在本机 claude CLI 中执行 /plugins 手动卸载，或检查目录是否选对（user/bridge 双目录可能各装有一份）。`,
        });
      }
      return json(res, 200, r);
    }
  }
  // ---- Skills 管理（#12）：三来源聚合（用户级·本机 / 用户级·bridge / 项目级·工作区）+ create/delete + zip 导入。
  // 首装（无 config.yaml）不拦截：两个用户级目录照常可看可管，仅项目级来源为空 ----
  /** 磁盘 config 的 workspaces（project 来源与 zip 导入目标依据）；解析失败/首装返回空数组 */
  const currentWorkspaces = (): Array<{ name: string; path: string }> => {
    const doc = readRawDoc(ctx.configPath);
    const ws = doc?.workspaces;
    if (!Array.isArray(ws)) return [];
    return ws.filter((w): w is { name: string; path: string } =>
      !!w && typeof w === 'object' && typeof (w as { name?: unknown }).name === 'string' && typeof (w as { path?: unknown }).path === 'string');
  };
  /** skill 生效目录（用户级）：managed 模式 → bridge 自管 claude/skills；否则共享本机 ~/.claude/skills */
  const effectiveSkillsDir = (): string => {
    const doc = readRawDoc(ctx.configPath);
    return (doc?.claude as { mode?: string } | undefined)?.mode === 'managed'
      ? join(CONFIG_DIR, 'claude', 'skills')
      : join(homedir(), '.claude', 'skills');
  };
  /** 插件清单（#12 插件来源补全）：扫描双 claude 目录的 installed_plugins.json（本机必扫；
   *  managed 时额外扫 bridge 自管目录——managed 模式生效目录），合并去重（installPath 主键）。
   *  enabled 字段联合两目录 settings.json 的 enabledPlugins 判定（任一处开启即视为启用——
   *  保守显示启用，与 executeTask 任一处目录可加载语义一致） */
  const currentPlugins = (): Array<{ name: string; path: string; enabled: boolean }> => {
    const doc = readRawDoc(ctx.configPath);
    const isManaged = (doc?.claude as { mode?: string } | undefined)?.mode === 'managed';
    const dirs: string[] = [DEFAULT_CLAUDE_DIR];
    if (isManaged) dirs.push(MANAGED_CLAUDE_DIR);
    const enabledKeys = new Set<string>();
    for (const d of dirs) for (const k of loadEnabledPlugins(d)) enabledKeys.add(k);
    const byPath = new Map<string, { name: string; path: string; enabled: boolean }>();
    for (const d of dirs) {
      for (const p of listInstalledPlugins(d)) {
        if (!p.path) continue;
        if (byPath.has(p.path)) continue; // installPath 重复（双目录登记同一 install）按先到先得
        byPath.set(p.path, { name: p.name, path: p.path, enabled: enabledKeys.has(p.key) });
      }
    }
    return [...byPath.values()];
  };
  if (path === '/api/skills' && req.method === 'GET') {
    const plugins = currentPlugins();
    return json(res, 200, {
      skills: listAllSkills(currentWorkspaces(), plugins),
      effectiveDir: effectiveSkillsDir(),
      pluginStats: { total: plugins.length, withSkills: plugins.filter((p) => listSkills(join(p.path, 'skills'), 'plugin').length > 0).length },
    });
  }
  if (path === '/api/skills/action' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const op = String(body.op ?? '');
    const name = String(body.name ?? '').trim();
    if (!SKILL_NAME_RE.test(name)) return json(res, 400, { error: `skill 名 "${name}" 须为 1-64 位字母/数字/下划线/连字符` });
    if (op === 'create') {
      const description = String(body.description ?? '').trim();
      const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n（请补充 skill 说明）\n`;
      const skillDir = join(effectiveSkillsDir(), name);
      if (existsSync(skillDir)) return json(res, 409, { error: `skill "${name}" 已存在（${skillDir}）` });
      try {
        mkdirSync(skillDir, { recursive: true });
        writeAtomic(join(skillDir, 'SKILL.md'), md);
      } catch (e) {
        return json(res, 500, { error: `创建 skill 失败：${e instanceof Error ? e.message : String(e)}` });
      }
      return json(res, 200, { ok: true, skill: { name, description, path: skillDir } });
    }
    if (op === 'delete') {
      // 按来源定位目录：machine-user / bridge（自管） / project（workspaceName 定位工作区）
      const source = String(body.source ?? 'machine-user') as 'machine-user' | 'bridge' | 'project';
      const root = source === 'bridge'
        ? join(CONFIG_DIR, 'claude', 'skills')
        : source === 'project'
          ? join(currentWorkspaces().find((w) => w.name === String(body.workspaceName ?? ''))?.path ?? '\0not-found', '.claude', 'skills')
          : join(homedir(), '.claude', 'skills');
      const skillDir = join(root, name);
      if (!existsSync(skillDir)) return json(res, 400, { error: `skill "${name}" 不存在（${root}）` });
      try {
        rmSync(skillDir, { recursive: true, force: true });
      } catch (e) {
        return json(res, 500, { error: `删除 skill 失败：${e instanceof Error ? e.message : String(e)}` });
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: `未知 op "${op}"（支持 create / delete）` });
  }
  // ---- Skill 文件浏览（#3）：目录列举 + 文件原文读取。
  // 安全：所有路径必须解析后落在任一已知 skill 根目录内（防路径穿越读到 ~/.claude/credentials.json 等）；
  // 原文读取另有扩展名白名单 + 1MB 上限 ----
  /** 全部已知 skill 根（用户级本机/bridge 自管/各工作区项目级/各已装插件），resolve 后的绝对路径 */
  const skillRootsAll = (): string[] => {
    const roots = [join(homedir(), '.claude', 'skills'), join(CONFIG_DIR, 'claude', 'skills')];
    for (const w of currentWorkspaces()) roots.push(join(w.path, '.claude', 'skills'));
    for (const p of currentPlugins()) roots.push(join(p.path, 'skills'));
    return roots.map((r) => resolve(r));
  };
  const isUnderSkillRoots = (p: string): boolean => {
    const rp = resolve(p);
    return skillRootsAll().some((root) => rp === root || rp.startsWith(root + sep));
  };
  if (path === '/api/skills/files' && req.method === 'GET') {
    const dir = String(url.searchParams.get('path') ?? '');
    if (!dir || !isUnderSkillRoots(dir)) return json(res, 403, { error: '路径不在允许的 skill 目录内' });
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return json(res, 400, { error: `目录读取失败：${e instanceof Error ? e.message : String(e)}` });
    }
    const files = dirents.map((d) => {
      let size = 0;
      let mtime = '';
      try {
        const st = statSync(join(dir, d.name));
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch { /* 单条 stat 失败按 0 处理 */ }
      return { name: d.name, isDir: d.isDirectory(), size, mtime };
    }).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return json(res, 200, { path: resolve(dir), files });
  }
  if (path === '/api/skills/raw' && req.method === 'GET') {
    const fp = String(url.searchParams.get('path') ?? '');
    if (!fp || !isUnderSkillRoots(fp)) return json(res, 403, { error: '路径不在允许的 skill 目录内' });
    // 扩展名白名单：只放行文本类文件（防借道读凭证/二进制）
    const RAW_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.sh', '.py', '.ts', '.js', '.mjs', '.cjs', '.toml', '.xml', '.csv', '.html', '.css']);
    const ext = extname(fp).toLowerCase();
    if (!RAW_EXTS.has(ext)) return json(res, 400, { error: `不支持预览 ${ext || '无扩展名'} 类型文件（仅文本类可查看）` });
    try {
      const st = statSync(fp);
      if (!st.isFile()) return json(res, 400, { error: '不是文件' });
      if (st.size > 1024 * 1024) return json(res, 400, { error: `文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB > 1MB），请本地查看` });
      return json(res, 200, { path: resolve(fp), name: parse(fp).base, ext, size: st.size, content: readFileSync(fp, 'utf8') });
    } catch (e) {
      return json(res, 400, { error: `文件读取失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  if (path === '/api/skills/import' && req.method === 'POST') {
    // zip 导入（#12）：base64 上传，独立放宽到 10MB（全局 1MB 不放 zip）；解压后复制进用户级生效目录
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, 10 * 1024 * 1024);
    } catch (e) {
      return json(res, 413, { error: e instanceof Error ? e.message : String(e) });
    }
    const zipBase64 = String(body.zipBase64 ?? '');
    if (!zipBase64) return json(res, 400, { error: '缺少 zipBase64' });
    let entries: Array<{ entryName: string; isDirectory: boolean }>;
    try {
      const zip = new AdmZip(Buffer.from(zipBase64, 'base64'));
      entries = zip.getEntries().map((e) => ({ entryName: e.entryName, isDirectory: e.isDirectory }));
      // 兼容两种打包结构：根即 skill 目录（SKILL.md 在根）/ 单层子目录是 skill 目录
      const skillMd = entries.find((e) => !e.isDirectory && (e.entryName === 'SKILL.md' || /^[^/\\]+[/\\]SKILL\.md$/.test(e.entryName)));
      if (!skillMd) return json(res, 400, { error: 'zip 内未找到 SKILL.md（须为 skill 目录打包，或压缩包根含 SKILL.md）' });
      const prefix = skillMd.entryName === 'SKILL.md' ? '' : skillMd.entryName.replace(/[/\\]SKILL\.md$/, '') + '/';
      const name = prefix ? prefix.replace(/[/\\]$/, '') : String(body.name ?? '').trim();
      if (!SKILL_NAME_RE.test(name)) {
        return json(res, 400, { error: `skill 名 "${name}" 不合法（1-64 位字母/数字/下划线/连字符；根打包时请传 name 或改为目录打包）` });
      }
      const targetDir = join(effectiveSkillsDir(), name);
      if (existsSync(targetDir)) return json(res, 409, { error: `skill "${name}" 已存在（${targetDir}），如需覆盖请先删除` });
      mkdirSync(targetDir, { recursive: true });
      let extracted = 0;
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        if (!e.entryName.startsWith(prefix)) continue;
        // 路径穿越防御：跳过含 .. 的条目；落盘路径去掉 prefix 前缀
        const rel = e.entryName.slice(prefix.length).replace(/\\/g, '/');
        if (!rel || rel.split('/').some((seg) => seg === '..')) continue;
        const dest = join(targetDir, ...rel.split('/'));
        mkdirSync(dirname(dest), { recursive: true });
        zip.extractEntryTo(e.entryName, dirname(dest), false, true);
        extracted++;
      }
      if (extracted === 0 || !existsSync(join(targetDir, 'SKILL.md'))) {
        rmSync(targetDir, { recursive: true, force: true });
        return json(res, 400, { error: '解压后未得到有效 skill（SKILL.md 缺失），已回滚' });
      }
      return json(res, 200, { ok: true, name, path: targetDir, files: extracted });
    } catch (e) {
      return json(res, 500, { error: `zip 导入失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // ---- MCP server 管理（#12）：页面可管理存储 = bridge 自管 <CONFIG_DIR>/mcp/servers.json（executeTask
  // 注入 SDK 生效）；~/.claude.json（用户级·本机）展示+可删不写入；工作区 .mcp.json（项目级）只读 ----
  /** MCP env 多来源合并（#4/#8）：优先级 高→低 = 飞书应用 env（apps[].env，多应用按配置序先写胜出）
   *  > claude.env > 生效 Claude 目录 settings.json env > process.env。MCP 列表 resolvedEnv
   *  与 check 探测 spawn env 的统一数据源——只查 process.env 会把应用在配置页/env 块里
   *  设的变量误判为「未设置」 */
  const currentMergedEnv = (): Record<string, string> => {
    const merged: Record<string, string> = {};
    const put = (src: unknown): void => {
      if (!src || typeof src !== 'object' || Array.isArray(src)) return;
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (typeof v === 'string' && v && !(k in merged)) merged[k] = v; // 先写胜出：调用顺序即优先级
      }
    };
    const doc = readRawDoc(ctx.configPath);
    const rawApps = Array.isArray(doc?.apps) ? doc.apps : doc?.feishu ? [doc.feishu] : [];
    for (const a of rawApps) put((a as { env?: unknown }).env);
    put((doc?.claude as { env?: unknown } | undefined)?.env);
    const isManaged = (doc?.claude as { mode?: string } | undefined)?.mode === 'managed';
    try {
      const s = JSON.parse(readFileSync(join(isManaged ? MANAGED_CLAUDE_DIR : DEFAULT_CLAUDE_DIR, 'settings.json'), 'utf8')) as { env?: unknown };
      put(s.env);
    } catch { /* settings.json 不存在/损坏：跳过该来源 */ }
    put(process.env);
    return merged;
  };
  if (path === '/api/mcp' && req.method === 'GET') {
    const plugins = currentPlugins();
    const mergedEnv = currentMergedEnv();
    const servers = listMcpServers(currentWorkspaces(), plugins).map((s) => {
      const { resolved, missing } = resolveEnvRefs(s.config.env as Record<string, unknown> | undefined, mergedEnv);
      return { ...s, resolvedEnv: resolved, missingEnv: missing };
    });
    return json(res, 200, {
      servers,
      bridgePath: BRIDGE_MCP_JSON,
      pluginStats: { total: plugins.length, withMcp: plugins.filter((p) =>
        Object.keys(readMcpServersFromJsonFile(join(p.path, '.mcp.json')).servers).length > 0
        || Object.keys(readPluginMcpFromManifest(p.path).servers).length > 0
      ).length },
    });
  }
  if (path === '/api/mcp/action' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const op = String(body.op ?? '');
    const name = String(body.name ?? '').trim();
    if (!MCP_NAME_RE.test(name)) return json(res, 400, { error: `mcp 名 "${name}" 须为 1-64 位字母/数字/下划线/点/连字符` });
    if (op === 'add' || op === 'update') {
      // 两种入参：command = claude mcp add / add-json 原生命令文本（后端解析）；或 config = 配置对象
      let cfg: Record<string, unknown> | undefined;
      if (typeof body.command === 'string' && body.command.trim()) {
        const parsed = parseClaudeMcpAdd(String(body.command));
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        if (parsed.name !== name) return json(res, 400, { error: `命令中的名字 "${parsed.name}" 与表单名字 "${name}" 不一致` });
        cfg = parsed.config;
      } else if (body.config && typeof body.config === 'object') {
        cfg = body.config as Record<string, unknown>;
      }
      if (!cfg) return json(res, 400, { error: '缺少 config（配置对象）或 command（claude mcp add 命令）' });
      // 宽松校验：stdio 走 command，http/sse 走 url
      if (!(typeof cfg.type === 'string' || typeof cfg.command === 'string' || typeof cfg.url === 'string')) {
        return json(res, 400, { error: 'config 至少需要 type / command / url 之一' });
      }
      const { servers } = readMcpServersFromJsonFile(BRIDGE_MCP_JSON);
      if (op === 'add' && servers[name]) return json(res, 409, { error: `mcp server "${name}" 已存在（bridge 目录），请改名或用更新` });
      servers[name] = cfg;
      try { writeAtomic(BRIDGE_MCP_JSON, JSON.stringify({ mcpServers: servers }, null, 2)); }
      catch (e) { return json(res, 500, { error: `写入 ${BRIDGE_MCP_JSON} 失败：${e instanceof Error ? e.message : String(e)}` }); }
      return json(res, 200, { ok: true, name, config: cfg });
    }
    if (op === 'remove') {
      const source = String(body.source ?? 'bridge') as 'bridge' | 'machine-user' | 'project';
      if (source === 'project') return json(res, 400, { error: '项目级 .mcp.json 只读（请在对应工作区目录手动修改）' });
      if (source === 'machine-user') {
        // 删 ~/.claude.json 条目：保留 mcpServers 之外的其它键（numStartups 等用户级 CLI 运行时状态）
        let doc: Record<string, unknown> = {};
        if (existsSync(USER_CLAUDE_JSON)) {
          try { doc = JSON.parse(readFileSync(USER_CLAUDE_JSON, 'utf8')) as Record<string, unknown>; }
          catch { return json(res, 500, { error: '~/.claude.json 解析失败，请先修复后再操作' }); }
        }
        const mcp = (doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}) as Record<string, Record<string, unknown>>;
        if (!mcp[name]) return json(res, 400, { error: `mcp server "${name}" 不存在（~/.claude.json）` });
        delete mcp[name];
        doc.mcpServers = mcp;
        try { writeAtomic(USER_CLAUDE_JSON, JSON.stringify(doc, null, 2)); }
        catch (e) { return json(res, 500, { error: `写入 ~/.claude.json 失败：${e instanceof Error ? e.message : String(e)}` }); }
        return json(res, 200, { ok: true });
      }
      const { servers } = readMcpServersFromJsonFile(BRIDGE_MCP_JSON);
      if (!servers[name]) return json(res, 400, { error: `mcp server "${name}" 不存在（${BRIDGE_MCP_JSON}）` });
      delete servers[name];
      try { writeAtomic(BRIDGE_MCP_JSON, JSON.stringify({ mcpServers: servers }, null, 2)); }
      catch (e) { return json(res, 500, { error: `写入 ${BRIDGE_MCP_JSON} 失败：${e instanceof Error ? e.message : String(e)}` }); }
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: `未知 op "${op}"（支持 add / update / remove）` });
  }
  if (path === '/api/mcp/check' && req.method === 'POST') {
    // 按需探测（不自动批量探测：stdio spawn 最长 3s，逐行自动探测会拖垮列表加载）
    const body = await readJsonBody(req);
    const name = String(body.name ?? '');
    const source = String(body.source ?? '');
    const entry = listMcpServers(currentWorkspaces(), currentPlugins())
      .find((s) => s.name === name && s.source === source && (s.workspaceName ?? '') === String(body.workspaceName ?? ''));
    if (!entry) return json(res, 400, { error: `mcp server "${name}"（${source}）不存在，请刷新列表` });
    const cfg = entry.config;
    const isRemote = cfg.type === 'http' || cfg.type === 'sse' || (!cfg.type && typeof cfg.url === 'string');
    if (isRemote) {
      // url / headers 值中的 ${VAR} 按同一合并源展开（与 env 展开一致），否则带引用的配置必被误判不可达
      const headerSrc: Record<string, string> = {};
      if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
        for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
          if (typeof v === 'string') headerSrc[k] = v;
        }
      }
      const { resolved: rr } = resolveEnvRefs(
        { url: typeof cfg.url === 'string' ? cfg.url : '', ...headerSrc },
        currentMergedEnv(),
      );
      const url = rr.url ?? '';
      if (!/^https?:\/\//.test(url)) return json(res, 200, { status: 'failed', detail: 'url 不是合法的 http(s) 地址' });
      const headers = Object.fromEntries(Object.entries(rr).filter(([k]) => k !== 'url'));
      try {
        const r = await fetch(url, {
          signal: AbortSignal.timeout(5000),
          ...(Object.keys(headers).length ? { headers } : {}),
        });
        // 任何 HTTP 响应都说明网络可达；4xx 多为鉴权/路径问题（MCP 端点通常要求特定握手）
        return json(res, 200, { status: r.status < 500 ? 'ok' : 'failed', detail: `HTTP ${r.status}${r.status >= 400 ? '（可达；鉴权或路径问题）' : ''}` });
      } catch (e) {
        return json(res, 200, { status: 'unreachable', detail: e instanceof Error ? e.message : String(e) });
      }
    }
    // stdio：spawn 后短时观察——MCP server 正常行为是启动后等 stdin，存活即「可启动」
    const command = typeof cfg.command === 'string' ? cfg.command : '';
    if (!command) return json(res, 200, { status: 'failed', detail: '缺少 command' });
    const mergedEnv = currentMergedEnv();
    const { resolved } = resolveEnvRefs(cfg.env as Record<string, unknown> | undefined, mergedEnv);
    // win32：裸命令（npx 等 .cmd shim）须包 cmd.exe /c，否则 spawn ENOENT 一律误判「异常」
    const run = resolveSpawnCommand(command, Array.isArray(cfg.args) ? cfg.args.map(String) : []);
    const child = spawn(run.command, run.args, {
      // stdin 留管道不写入：server 阻塞等输入；'ignore' 会立即 EOF 触发优雅退出被误判 failed
      stdio: ['pipe', 'pipe', 'pipe'],
      // 探测环境与任务运行时对齐：合并源（含飞书应用 env / claude.env / settings env）垫底，
      // server 自身 env 解析值覆盖（${VAR} 已按同一合并源展开）
      env: { ...process.env, ...mergedEnv, ...resolved },
      windowsHide: true,
      // win32 cmd 包装时命令行已手工引号构造，禁止 Node 再做 MSVCRT 引号（会破坏 /s 语义）
      ...(run.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => { if (stderr.length < 500) stderr += c.toString('utf8'); });
    /** 清理：关 stdin + 树杀。win32 下 child.kill() 只杀 cmd/npx 壳，孙进程 node 会残留成僵尸 → taskkill /T /F */
    const killTree = (): void => {
      child.stdin?.destroy();
      if (process.platform === 'win32' && child.pid) {
        try {
          const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          tk.on('error', () => { try { child.kill(); } catch { /* 已退出 */ } });
        } catch { try { child.kill(); } catch { /* 已退出 */ } }
      } else {
        try { child.kill(); } catch { /* 已退出 */ }
      }
    };
    const result = await new Promise<{ status: string; detail: string }>((resolve) => {
      const done = (status: string, detail: string): void => { clearTimeout(killTimer); resolve({ status, detail }); };
      const killTimer = setTimeout(() => {
        killTree();
        done('ok', '进程存活（正常：MCP server 启动后等待 stdio 输入）');
      }, 800);
      child.on('error', (e) => done('failed', `无法启动：${e.message}`));
      child.on('exit', (code) => done('failed', `进程退出（code ${code}）：${stderr.split('\n')[0] || '无 stderr 输出'}`));
    });
    killTree();
    return json(res, 200, result);
  }
  // ---- 桥接器进程启停（页面托管）。embedded 与 lcb ui 独立模式语义不同：embedded 停止/重启
  // 会连带本页所在进程，先回响应再走 selfStop 优雅关闭；独立模式经 PID 文件跨进程操作 ----
  if (path === '/api/bridge/action' && req.method === 'POST') {
    if (firstRun) return json(res, 400, { error: '尚无配置文件（首次安装），请先完成 bootstrap 向导' });
    const body = await readJsonBody(req);
    const op = String(body.op ?? '');
    const st = bridgeStatus();
    if (op === 'start') {
      if (ctx.embedded) return json(res, 409, { error: '桥接器已随本页运行，无需启动' });
      if (st.running) return json(res, 409, { error: `桥接器已在运行（PID ${st.pid}）` });
      const r = spawnBridgeDetached();
      if (!r.ok) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, pid: r.pid, message: '桥接器已在后台启动（运行日志见 ~/.lark-claudecode-bridge/logs/bridge-YYYY-MM-DD.log）' });
    }
    if (op === 'stop' || op === 'restart') {
      if (ctx.embedded && !ctx.selfStop) return json(res, 500, { error: '内部错误：embedded 模式未注入 selfStop' });
      if (ctx.embedded && ctx.selfStop) {
        if (op === 'restart') {
          // 旧进程退出后由 detached helper 拉起新进程（含等待端口释放），页面轮询 /api/status 自动恢复
          const r = restartBridgeWithHelper(process.pid);
          if (!r.ok) return json(res, 400, { error: r.error });
          json(res, 200, { ok: true, message: '正在重启，页面将短暂失联后自动恢复' });
        } else {
          json(res, 200, { ok: true, message: '正在停止，本配置页将随桥接器进程一同关闭' });
        }
        setTimeout(ctx.selfStop, 300); // 先让响应 flush 出去再退出进程
        return;
      }
      if (op === 'stop') {
        if (!st.running) return json(res, 409, { error: '桥接器未在运行' });
        return json(res, 200, { ok: stopBridgeByPid(st.pid!), message: '已发送停止信号' });
      }
      if (st.running) {
        const r = restartBridgeWithHelper(st.pid!);
        if (!r.ok) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, message: '正在重启桥接器（本页不受影响，稍后状态自动更新）' });
      }
      const r = spawnBridgeDetached();
      if (!r.ok) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, pid: r.pid, message: '桥接器未在运行，已在后台启动' });
    }
    return json(res, 400, { error: `未知 op "${op}"（支持 start / stop / restart）` });
  }
  // ---- 版本检查与一键更新（npm view / npm install -g，registry 镜像跟随用户 .npmrc） ----
  if (path === '/api/update/check' && req.method === 'GET') {
    try {
      return json(res, 200, { ...await checkUpdate(), mode: installMode() });
    } catch (e) {
      return json(res, 502, { error: `检查更新失败：${e instanceof Error ? e.message : String(e)}（网络离线或 registry 不可达？可稍后重试）` });
    }
  }
  if (path === '/api/update/run' && req.method === 'POST') {
    if (installMode() !== 'global') {
      return json(res, 400, { error: '检测到当前非 npm 安装目录运行（如源码运行），一键更新会装出另一份全局副本而非更新当前实例，请手动更新' });
    }
    try {
      const output = await runUpdate();
      return json(res, 200, { ok: true, output });
    } catch (e) {
      return json(res, 502, { error: `更新失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return json(res, 404, { error: `未知端点 ${req.method} ${path}` });
}
