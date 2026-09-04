// Web 配置页 server：node:http 零新依赖，随 lcb start 常驻 / lcb ui 独立启动。
// 安全基线：默认只绑 127.0.0.1；Host/Origin 校验防 DNS rebinding；body ≤1MB；
// secret 永不出进程（GET 脱敏回显，PUT 空值=不修改）。改动写盘后由现有热重载器/重启消费
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { CONFIG_PATH, SLASH_COMMAND_RE, loadConfig, parseConfigText } from '../config.js';
import { DEFAULT_CLAUDE_DIR, initManagedClaudeDir, resolveClaudeDir } from '../claude-config.js';
import { hasClaudeAuth } from '../auth-precheck.js';
import { defaultPermissionsDoc, defaultServerDoc } from '../config-defaults.js';
import { VERSION } from '../version.js';
import type { BridgeConfig, ServerConfig } from '../types.js';
import { appStatusSummary, applyPermissionDisplayDefaults, applySecrets, claudeSettingsSummary, computeRestartRequired, docForClient, isAllowedHost, isAllowedOrigin, type ClaudeCurrentSummary } from './config-api.js';
import { fetchModelList, resolveModelFetchParams } from './model-list.js';
import { SLASH_COMMAND_META } from '../session/commands.js';
import { DEFAULT_ALLOW_TOOLS_LIST, DEFAULT_DANGEROUS_COMMAND_SOURCES } from '../executor/permission-gate.js';
import { openBrowser } from '../util/open-browser.js';
import { builtinCommands, createSlashApiClient, ensureBuiltins, expectedCommands, syncSlashCommands } from '../feishu/slash-commands.js';
import { runPluginCli } from '../executor/plugin-manager.js';
import { invalidatePluginCache, listInstalledPlugins } from '../executor/plugin-discovery.js';
import { bridgeStatus, resolveLcbEntry, restartBridgeWithHelper, spawnBridgeDetached, stopBridgeByPid } from './lifecycle.js';
import { checkUpdate, installMode, runUpdate } from './update.js';

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
  /** embedded 模式下页面停止/重启自身进程的优雅关闭回调（lcb start 注入 shutdown） */
  selfStop?: () => void;
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
  const serverCfg = opts.server ?? (defaultServerDoc() as unknown as ServerConfig);
  if (serverCfg.enabled === false) return null;
  const configPath = opts.configPath ?? CONFIG_PATH;
  const host = serverCfg.host ?? '127.0.0.1';
  const port = serverCfg.port ?? 17317;

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
  // ---- 切换当前生效厂商档案：前端拿不到档案凭证明文（脱敏模型），切换必须由后端完成并即时落盘 ----
  if (path === '/api/claude/use-profile' && req.method === 'POST') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件，请先完成 bootstrap' });
    const body = await readJsonBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) return json(res, 400, { error: '缺少档案名 name' });
    let config: BridgeConfig;
    try {
      config = loadConfig(ctx.configPath);
    } catch (e) {
      return json(res, 500, { error: `配置加载失败：${e instanceof Error ? e.message : String(e)}` });
    }
    const prof = config.claude?.profiles?.find((p) => p.name === name);
    if (!prof) return json(res, 404, { error: `档案 "${name}" 不存在（新增/修改档案后须先保存再切换）` });
    // 可选 model 覆盖（档案候选模型点选切换）：须属于该档案 models 候选集或其默认模型，防手滑串档案
    const modelOverride = String(body.model ?? '').trim();
    if (modelOverride) {
      const candidates = new Set([...(prof.models ?? []), ...(prof.model ? [prof.model] : [])]);
      if (!candidates.has(modelOverride)) {
        return json(res, 400, { error: `模型 "${modelOverride}" 不在档案 "${name}" 的候选模型中（${[...candidates].join('、') || '空'}）` });
      }
    }
    // 顶层四字段整体替换为档案值（档案未配置的字段清除，保证切换干净；mode 与 profiles 原样保留）
    const rawText = readFileSync(ctx.configPath, 'utf8');
    const doc = parseDocument(rawText);
    const oldJs = doc.toJS() as Record<string, unknown>;
    const oldClaude = (oldJs.claude && typeof oldJs.claude === 'object' && !Array.isArray(oldJs.claude) ? oldJs.claude : {}) as Record<string, unknown>;
    const newClaude: Record<string, unknown> = { ...oldClaude };
    if (prof.authToken) { newClaude.auth_token = prof.authToken; delete newClaude.api_key; }
    else if (prof.apiKey) { newClaude.api_key = prof.apiKey; delete newClaude.auth_token; }
    else { delete newClaude.auth_token; delete newClaude.api_key; }
    if (prof.baseUrl) newClaude.base_url = prof.baseUrl; else delete newClaude.base_url;
    const effModel = modelOverride || prof.model;
    if (effModel) newClaude.model = effModel; else delete newClaude.model;
    doc.set('claude', newClaude);
    const text = doc.toString();
    let after: BridgeConfig;
    try {
      after = parseConfigText(text, ctx.configPath);
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    writeAtomic(ctx.configPath, text);
    syncManagedClaude(after);
    return json(res, 200, { ok: true, message: `已切换到档案「${name}」${effModel ? `（模型 ${effModel}）` : ''}${after.claude?.mode === 'managed' ? '，managed 模式下对后续任务即生效' : '，当前 inherit 模式：顶层值已更新，切到 managed 后生效'}` });
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
      const from = (dir: string, source: 'bridge' | 'user') => listInstalledPlugins(dir).map((p) => ({ ...p, source }));
      return json(res, 200, {
        configDir: bridgeDir,
        userDir,
        // inherit 模式两目录相同 → 单份（source=user）；managed 合并两处各自可启停
        plugins: sameDir ? from(bridgeDir, 'user') : [...from(bridgeDir, 'bridge'), ...from(userDir, 'user')],
      });
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
        'marketplace-add': arg ? ['marketplace', 'add', arg] : [],
        'marketplace-remove': arg ? ['marketplace', 'remove', arg] : [],
        'marketplace-update': ['marketplace', 'update', ...(arg ? [arg] : [])],
      };
      const args = argsTable[op];
      if (!args || args.length === 0) return json(res, 400, { error: `操作 ${op || '(空)'} 需要参数或未知` });
      const r = await runPluginCli(args, { claudeConfigDir: dir });
      invalidatePluginCache(bridgeDir);
      if (!sameDir) invalidatePluginCache(userDir);
      return json(res, 200, r);
    }
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
      return json(res, 200, { ok: true, pid: r.pid, message: '桥接器已在后台启动（运行日志见 ~/.lark-claudecode-bridge/bridge.log）' });
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
