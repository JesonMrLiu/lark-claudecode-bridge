// Web 配置页 server：node:http 零新依赖，随 lcb start 常驻 / lcb ui 独立启动。
// 安全基线：默认只绑 127.0.0.1；Host/Origin 校验防 DNS rebinding；body ≤1MB；
// secret 永不出进程（GET 脱敏回显，PUT 空值=不修改）。改动写盘后由现有热重载器/重启消费
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { CONFIG_PATH, loadConfig, parseConfigText } from '../config.js';
import { initManagedClaudeDir, resolveClaudeDir } from '../claude-config.js';
import { hasClaudeAuth } from '../auth-precheck.js';
import { defaultPermissionsDoc, defaultServerDoc } from '../config-defaults.js';
import { VERSION } from '../version.js';
import type { BridgeConfig, ServerConfig } from '../types.js';
import { appStatusSummary, applySecrets, computeRestartRequired, docForClient, isAllowedHost, isAllowedOrigin } from './config-api.js';
import { openBrowser } from '../util/open-browser.js';
import { createSlashApiClient, expectedCommands, syncSlashCommands } from '../feishu/slash-commands.js';
import { runPluginCli } from '../executor/plugin-manager.js';
import { invalidatePluginCache, listInstalledPlugins } from '../executor/plugin-discovery.js';

/** PUT /api/config 参与整段替换的顶级键；body 未携带的键保持磁盘原文（含注释） */
const PUT_SECTIONS = ['apps', 'workspaces', 'defaults', 'concurrency', 'permissions', 'server', 'claude', 'slash_commands', 'transcripts'] as const;

export interface WebServerOptions {
  /** server 段配置；缺省用默认（firstRun 无配置文件场景） */
  server?: ServerConfig;
  configPath?: string;
  /** true = lcb start 内嵌（页面顶栏标识 + status.apps 显示启动态） */
  embedded?: boolean;
  /** 启动后自动开浏览器 */
  autoOpen?: boolean;
  appsStarted?: Array<{ name: string; started: boolean }>;
}

export interface WebServerHandle { url: string; port: number; close(): void }

const INDEX_HTML_PATH = fileURLToPath(new URL('../../assets/web/index.html', import.meta.url));
const BODY_LIMIT = 1024 * 1024;
const startedAt = Date.now();

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return readBody(req).then((text) => {
    if (!text.trim()) return {};
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('请求体必须为 JSON 对象');
    return v as Record<string, unknown>;
  });
}

/** 原子写盘（tmp + rename），与 claude-config 同款防半截文件 */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
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
  const serverCfg = opts.server ?? (defaultServerDoc() as unknown as ServerConfig);
  if (serverCfg.enabled === false) return null;
  const configPath = opts.configPath ?? CONFIG_PATH;
  const host = serverCfg.host ?? '127.0.0.1';
  const port = serverCfg.port ?? 17317;

  const server: Server = createServer((req, res) => {
    void handle(req, res, { configPath, host, port, embedded: opts.embedded ?? false, appsStarted: opts.appsStarted }).catch((e) => {
      console.error('[配置页] 请求处理异常：', e);
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = (server.address() as { port: number }).port;
  const url = `http://${host === '::1' ? '[::1]' : host}:${actualPort}`;
  console.log(`🧭 配置页已就绪：${url}${opts.embedded ? '' : '（lcb ui 独立模式，桥接器未启动）'}`);
  if (opts.autoOpen) openBrowser(url);
  return {
    url,
    port: actualPort,
    close: () => server.close(),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    configPath: string; host: string; port: number;
    embedded: boolean; appsStarted?: Array<{ name: string; started: boolean }>;
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
  // 静态页（单文件，无目录遍历面）
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
  if (path === '/api/status' && req.method === 'GET') {
    let claude: { mode: string; hasAuth: boolean | null } = { mode: 'inherit', hasAuth: null };
    let apps: ReturnType<typeof appStatusSummary> = [];
    if (!firstRun) {
      try {
        const config = loadConfig(ctx.configPath);
        const dir = resolveClaudeDir(config);
        claude = { mode: config.claude?.mode ?? 'inherit', hasAuth: hasClaudeAuth(process.env as Record<string, string | undefined>, dir) };
        apps = appStatusSummary(config.apps, ctx.appsStarted);
      } catch { /* 磁盘配置损坏：status 仍可用（页面提示重配） */ }
    }
    return json(res, 200, {
      version: VERSION, uptimeMs: Date.now() - startedAt, configPath: ctx.configPath,
      firstRun, embedded: ctx.embedded,
      server: { host: ctx.host, port: ctx.port },
      claude, apps,
    });
  }
  if (path === '/api/config' && req.method === 'GET') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请提交 bootstrap 向导' });
    const rawDoc = readRawDoc(ctx.configPath);
    if (rawDoc === null) return json(res, 500, { error: 'config.yaml 读取失败（语法错误？），lcb setup 或手工修复后重试' });
    return json(res, 200, docForClient(rawDoc));
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
    const appName = path === '/api/slash-commands/remote'
      ? url.searchParams.get('app')
      : String((await readJsonBody(req).catch(() => ({} as Record<string, unknown>))).app ?? '');
    const app = config.apps.find((a) => a.name === appName || a.appId === appName);
    if (!app) return json(res, 400, { error: `应用 "${String(appName)}" 不存在，可用：${config.apps.map((a) => a.name).join('、')}` });
    const client = createSlashApiClient(app);
    try {
      if (path === '/api/slash-commands/remote' && req.method === 'GET') {
        return json(res, 200, { remote: await client.list() });
      }
      if (path === '/api/slash-commands/sync' && req.method === 'POST') {
        const report = await syncSlashCommands(client, expectedCommands(config));
        return json(res, 200, report);
      }
    } catch (e) {
      // API 原文透传（缺 scope 等场景页面直接展示开放平台错误）
      return json(res, 502, { error: `飞书 API 调用失败：${e instanceof Error ? e.message : String(e)}（请确认已开通 application:app_slash_command 读写权限并发布版本）` });
    }
  }
  // ---- 插件管理（本机页面即可操作；与飞书端 /plugin 命令同一执行器） ----
  if (path.startsWith('/api/plugins')) {
    if (firstRun) return json(res, 404, { error: '尚无配置文件，请先完成 bootstrap' });
    let config: BridgeConfig;
    try {
      config = loadConfig(ctx.configPath);
    } catch (e) {
      return json(res, 500, { error: `配置加载失败：${e instanceof Error ? e.message : String(e)}` });
    }
    const dir = resolveClaudeDir(config);
    if (path === '/api/plugins' && req.method === 'GET') {
      return json(res, 200, { configDir: dir, plugins: listInstalledPlugins(dir) });
    }
    if (path === '/api/plugins/action' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const arg = String(body.arg ?? '').trim();
      const op = String(body.op ?? '');
      const argsTable: Record<string, string[]> = {
        install: arg ? ['install', arg] : [],
        uninstall: arg ? ['uninstall', arg] : [],
        enable: arg ? ['enable', arg] : [],
        disable: arg ? ['disable', arg] : [],
        'marketplace-add': arg ? ['marketplace', 'add', arg] : [],
        'marketplace-remove': arg ? ['marketplace', 'remove', arg] : [],
        'marketplace-update': ['marketplace', 'update', ...(arg ? [arg] : [])],
      };
      const args = argsTable[op];
      if (!args || args.length === 0) return json(res, 400, { error: `操作 ${op || '(空)'} 需要参数或未知` });
      const r = await runPluginCli(args, { claudeConfigDir: dir });
      invalidatePluginCache(dir);
      return json(res, 200, r);
    }
  }
  return json(res, 404, { error: `未知端点 ${req.method} ${path}` });
}
