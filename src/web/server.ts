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
import { refreshMarketplaceIndex, removeMarketplaceIfUnused, resolvePluginMarketplace, runPluginCli, updateAllPlugins } from '../executor/plugin-manager.js';
import { invalidatePluginCache, listAvailablePlugins, listInstalledPlugins, loadEnabledPlugins } from '../executor/plugin-discovery.js';
import { bridgeStatus, probePortOccupier, resolveLcbEntry, restartBridgeWithHelper, spawnBridgeDetached, stopBridgeByPid } from './lifecycle.js';
import { getAutostartStatus, setAutostartEnabled } from './autostart.js';
import { checkUpdate, hasNewerVersion, installMode, runUpdate } from './update.js';
import { memoryStatus, testMemoryConnection } from './memory-api.js';
import { chatsTree, chatTopics, chatTimeline, fetchUserNames } from './chats-api.js';
import { AccessControl } from '../access/access-control.js';
import {
  authMeta, authThrottleState, changePassword, clearAuthFailures, clearSessionCookie, createSession,
  dropOtherSessions, dropSession, readSessionToken, registerAuthFailure, resetPasswordToDefault,
  sessionCookie, setLockMinutes, touchSession, verifyPassword,
} from './webauth.js';
import { listLogFiles, tailLogFile, tailLogRange } from './logs-api.js';
import {
  createMemoryUser, deleteMemoryUser, initMemoryUsers, listMemoryUsers, resetUserKey, revealRootKey, revealUserKey,
} from './memory-users-api.js';
import { MANAGED_OV_CONF, getInstallState, runInstall, runStartPipeline, stopManagedServer } from '../memory-installer.js';
import {
  checkLarkCliAuth,
  checkLarkCliLatest,
  detectLarkCli,
  detectLarkCliSkill,
  getLarkCliConfigStatus,
  getLarkCliDeviceStatus,
  runLarkCliActionFlow,
  startLarkCliConfigFlow,
  startLarkCliDeviceAuth,
  type LarkCliOp,
} from '../lark-cli-manager.js';

/** PUT /api/config 参与整段替换的顶级键；body 未携带的键保持磁盘原文（含注释）。
 *  memory（记忆增强 §6.8）：模型表单/开关经标准 config 管道提交，自动获得注释保留与写前校验 */
const PUT_SECTIONS = ['apps', 'workspaces', 'defaults', 'concurrency', 'permissions', 'security', 'server', 'claude', 'slash_commands', 'transcripts', 'session', 'card', 'autostart', 'memory'] as const;

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
      // 普通目录在前、点开头隐藏目录殿后（目录选择弹层网格的浏览主路径是普通目录）
      .sort((a, b) => (a.startsWith('.') ? 1 : 0) - (b.startsWith('.') ? 1 : 0) || a.localeCompare(b));
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

/** 远程/无桌面场景隧道指引触发条件（导出供单测）：
 * 回环监听 + SSH 会话，或 Linux 无图形会话——云厂商网页终端（腾讯云 OrcaTerminal 等）
 * 不设 SSH_*，后者是云服务器上最常见的操作方式 */
export function shouldShowTunnelHint(host: string): boolean {
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback) return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) return true;
  return process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/** EADDRINUSE 报错文案：探测占用者身份（是否旧 lcb 进程 + PID）+ 按平台给排查命令。
 * 裸 Node 错误（listen EADDRINUSE :::17317）对首装用户完全不可操作 */
async function friendlyAddrInUse(host: string, port: number): Promise<string> {
  void host; // 占用者探测固定走回环（probePortOccupier 内部 127.0.0.1），host 仅保留签名兼容
  let occupier = '';
  const occ = await probePortOccupier(port).catch(() => null);
  if (occ?.isLcb) {
    // 401 也带 version（鉴权网关对 /api/status 特批附版本）：加锁后的旧进程仍可被识别；
    // PID 直取占用者自报（顶层 pid），lcb start 的启动清场（freeLcbOccupiedPort）据此自动接管
    occupier = `（占用者疑似旧 lcb 进程 v${occ.version}${occ.pid ? `，PID ${occ.pid}` : ''}——npm 更新后旧进程未退出，需手动结束）`;
  }
  const probe = process.platform === 'win32'
    ? `netstat -ano | findstr :${port} 查 PID、taskkill /F /PID <pid> 停止`
    : process.platform === 'darwin'
      ? `lsof -i :${port} 查 PID、kill <pid> 停止`
      : `ss -ltnp | grep :${port} 查 PID、kill <pid> 停止`;
  return `配置页端口 ${port} 已被占用${occupier}。排查：${probe}；或修改 config.yaml 的 server.port 换端口`;
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

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
  } catch (e) {
    // EADDRINUSE 友好化：探测占用者并给平台排查命令，替代裸 Node 错误栈
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(await friendlyAddrInUse(host, port));
    }
    throw e;
  }
  port = (server.address() as { port: number }).port;
  const url = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  console.log(`🧭 配置页已就绪：${url}${opts.embedded ? '' : '（lcb ui 独立模式，桥接器未启动）'}`);
  if (shouldShowTunnelHint(host)) {
    console.log('🌐 检测到远程/无桌面环境：配置页仅监听本机回环地址，可在本地机器另开终端执行');
    console.log(`   ssh -L ${port}:127.0.0.1:${port} <用户名>@<此服务器>`);
    console.log(`   建立隧道后在本地浏览器打开 ${url}`);
    console.log('⚠️ 配置页为前台进程：关闭终端或断开连接会停止它（配置完成前请保持本终端运行）');
  }
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
  const configPath = ctx.configPath; // 短别名：鉴权段大量引用
  // 每请求现查（不能用启动快照）：bootstrap 写盘成功后，后续请求立即按「已有配置」处理
  const firstRun = !existsSync(ctx.configPath);
  // 安全闸：Host / Origin 校验（防 DNS rebinding 拿本机页面读写配置）
  if (!isAllowedHost(req.headers.host, ctx.host) || !isAllowedOrigin(req.headers.origin, ctx.host, ctx.port)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  // ---- 配置页密码闸：静态资源（html/js/css）公开（页面源码不含秘密）；锁屏本身在前端，
  // 但数据全部挡在 API 层——所有 /api/*（除登录）必须携带有效会话 cookie，否则 401。
  // 首装向导 /api/bootstrap 同样被拦：内网他人无法抢在主人之前 bootstrap 配置 ----
  const sessionToken = readSessionToken(req.headers.cookie);
  if (path.startsWith('/api/') && path !== '/api/auth/verify') {
    // 每请求滑动续期：TTL 取当前锁屏设置（改设置即刻约束既有会话；webauth 文件随读随取，
    // 顺带让 `lcb reset-password` 的改密对运行中的进程即时生效）
    const okSession = !!sessionToken && touchSession(sessionToken, authMeta(configPath).lockMinutes);
    if (!okSession) {
      // /api/status 在 401 里特批附 version+pid：EADDRINUSE 端口占用探测靠它们识别运行中的
      // lcb 并定位 PID（freeLcbOccupiedPort 自动清场、friendlyAddrInUse 报文案）
      if (path === '/api/status') return json(res, 401, { error: '配置页已锁定', version: VERSION, pid: process.pid });
      return json(res, 401, { error: '配置页已锁定，请先解锁' });
    }
  }
  // ---- 配置页密码：登录 / 登出 / 会话元信息 / 改密 / 恢复初始密码 / 锁屏设置 ----
  if (path === '/api/auth/verify' && req.method === 'POST') {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const th = authThrottleState(ip);
    if (th.blocked) return json(res, 429, { error: `密码尝试过于频繁，请 ${th.retryAfter} 秒后再试` });
    const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
    if (!verifyPassword(configPath, String(body.password ?? ''))) {
      registerAuthFailure(ip);
      return json(res, 401, { error: '密码错误，请重试' });
    }
    clearAuthFailures(ip);
    const meta = authMeta(configPath);
    const token = createSession(meta.lockMinutes);
    res.setHeader('Set-Cookie', sessionCookie(token, meta.lockMinutes));
    // isDefault：仍为默认密码 123456 时前端每次登录都弹「修改默认密码」引导
    return json(res, 200, { ok: true, isDefault: meta.isDefault, lockMinutes: meta.lockMinutes });
  }
  if (path === '/api/auth/meta' && req.method === 'GET') {
    // 能过鉴权闸才可能走到这里 ⇒ 会话有效；供设置弹窗取锁屏设置与默认密码状态
    return json(res, 200, { ok: true, ...authMeta(configPath) });
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    dropSession(sessionToken);
    res.setHeader('Set-Cookie', clearSessionCookie());
    return json(res, 200, { ok: true });
  }
  if (path === '/api/auth/change' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const r = changePassword(configPath, String(body.old ?? ''), String(body.next ?? ''));
    if (!r.ok) return json(res, 400, { error: r.error });
    dropOtherSessions(sessionToken); // 其他标签页/旧会话全部失效，当前页保持登录
    return json(res, 200, { ok: true, isDefault: false });
  }
  if (path === '/api/auth/reset-default' && req.method === 'POST') {
    // 恢复初始密码 123456：必须验当前密码（防锁屏状态下被内网他人一键重置）
    const body = await readJsonBody(req);
    if (!verifyPassword(configPath, String(body.old ?? ''))) return json(res, 401, { error: '当前密码不正确' });
    resetPasswordToDefault(configPath);
    dropOtherSessions(sessionToken);
    return json(res, 200, { ok: true, isDefault: true });
  }
  if (path === '/api/auth/settings' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const r = setLockMinutes(configPath, Number(body.lockMinutes));
    if (!r.ok) return json(res, 400, { error: r.error });
    const lockMinutes = Number(body.lockMinutes);
    if (sessionToken) touchSession(sessionToken, lockMinutes); // 立即按新 TTL 续期
    return json(res, 200, { ok: true, lockMinutes });
  }
  // ---- 运行日志（概览「查看日志」抽屉）：列表 + 尾部 N 行 + 日期范围聚合 ----
  if (path === '/api/logs' && req.method === 'GET') {
    return json(res, 200, listLogFiles(configPath));
  }
  if (path === '/api/logs/content' && req.method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (from || to) {
      // 日期范围模式（前端主路径）：from~to 每天日志依时间序合并
      const r = tailLogRange(configPath, from || to || '', to || from || '', Number(url.searchParams.get('lines')) || 2000);
      if ('error' in r) return json(res, 400, { error: r.error });
      return json(res, 200, r);
    }
    const file = url.searchParams.get('file');
    if (!file) return json(res, 400, { error: '缺少查询参数：请传 from/to（日期范围）或 file（单文件名）' });
    const r = tailLogFile(configPath, file, Number(url.searchParams.get('lines')) || 500);
    if ('error' in r) return json(res, 400, { error: r.error });
    return json(res, 200, r);
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
      // 顶层 pid=应答进程自身：前端重启判定/端口占用探测（freeLcbOccupiedPort）直接取用，
      // 不必回退 netstat 反查。与 bridge.pid（PID 文件内容）区分：独立模式下两者可能不同
      pid: process.pid,
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
  // ---- 记忆增强（生命周期方案 §6.8）：状态聚合 + 模型连接测试；配置读写走标准 /api/config ----
  if (path === '/api/memory/status' && req.method === 'GET') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请先提交 bootstrap 向导' });
    try {
      return json(res, 200, await memoryStatus(loadConfig(ctx.configPath)));
    } catch (e) {
      return json(res, 500, { error: `配置读取失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  if (path === '/api/memory/test-connection' && req.method === 'POST') {
    // 表单现值直测（不落盘）：把 Key/端点/模型名错误挡在开启之前（§6.8 双绿门禁）。
    // P2 双端点拆分：主 Key 与向量 Key 分别回退各自已保存值（表单留空 = 测已保存值）
    const body = await readJsonBody(req);
    let saved: { apiKey?: string; embeddingApiKey?: string } | undefined;
    if (!firstRun) {
      try {
        const model = loadConfig(ctx.configPath).memory?.model;
        saved = { apiKey: model?.apiKey, embeddingApiKey: model?.embeddingApiKey };
      } catch { /* 按无保存值直测 */ }
    }
    try {
      return json(res, 200, await testMemoryConnection(body as Parameters<typeof testMemoryConnection>[0], saved));
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // ---- 会话记录（只读查看器）：LCB 本地 transcripts 时间线 + 话题聚合 + 飞书真群名 ----
  if (path === '/api/chats/tree' && req.method === 'GET') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请先完成 bootstrap 向导' });
    try {
      return json(res, 200, await chatsTree(ctx.configPath));
    } catch (e) {
      return json(res, 500, { error: `会话树扫描失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  if (path === '/api/chats/topics' && req.method === 'GET') {
    return json(res, 200, chatTopics(url.searchParams.get('app') ?? '', url.searchParams.get('chat') ?? ''));
  }
  if (path === '/api/chats/timeline' && req.method === 'GET') {
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const limit = Number(q('limit'));
    return json(res, 200, chatTimeline(q('app') ?? '', q('chat') ?? '', {
      date: q('date'),
      session: q('session'),
      user: q('user'),
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    }));
  }
  // ---- B3 一键安装（§6.7 嵌入式流水线）：后台执行 + 进度轮询；失败步骤可整链重跑（幂等跳过） ----
  if (path === '/api/memory/install' && req.method === 'POST') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请先提交 bootstrap 向导' });
    try {
      const config = loadConfig(ctx.configPath);
      // 首装前置校验（同步 400，不让用户撞「生成服务配置」步骤失败才发现缺模型）：
      // 受管 conf 不存在 = 首装，必须有三件套；conf 已存在 = 重跑/修复，沿用现值放行
      const m = config.memory?.model;
      if (!existsSync(MANAGED_OV_CONF) && (!m || !m.apiBase || !m.vlmModel || !m.embeddingModel)) {
        return json(res, 400, { error: '首装需要记忆模型三件套（API 端点 / 提炼模型 / 向量模型）——请先在「模型配置」卡填写并保存，再执行安装' });
      }
      // 模型三件套取自 memory 段（页面通常已保存过表单）；缺省也允许（沿用现有受管 conf 重跑场景）
      void runInstall({
        configPath: ctx.configPath,
        model: config.memory?.model,
        pin: config.memory?.version,
      });
      return json(res, 200, { ok: true, started: true, note: '流水线后台执行中，轮询 /api/memory/install/status 查看进度' });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (path === '/api/memory/install/status' && req.method === 'GET') {
    return json(res, 200, getInstallState());
  }
  if (path === '/api/memory/stop' && req.method === 'POST') {
    stopManagedServer();
    return json(res, 200, { ok: true });
  }
  // 启动服务 = LCB 接管式启动流水线（检查 → 拉起探活 → 接入插件）：后台执行 + 同款进度轮询，
  // 结束即完整接管态（无须再点「检查修复」补插件）；与安装流水线共用状态机（kind='start'）
  if (path === '/api/memory/start' && req.method === 'POST') {
    if (getInstallState().running) return json(res, 409, { error: '流水线执行中，请等待当前流程完成' });
    void runStartPipeline({ configPath: ctx.configPath });
    return json(res, 200, { ok: true, started: true, note: '启动流水线后台执行中，轮询 /api/memory/install/status 查看进度' });
  }
  // P1 保存即生效（最终方案 §五-P1）：模型配置保存后前端弹「立即生效」确认 → 本端点重渲染
  // ov.conf + 强制重启受管服务（runInstall forceRestart——运行中的旧进程不会热加载新模型，
  // 只重渲染不重启的「检查修复」对模型变更无效）。消灭「保存后还需手动检查修复」两步坑
  if (path === '/api/memory/apply' && req.method === 'POST') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请先提交 bootstrap 向导' });
    if (getInstallState().running) return json(res, 409, { error: '流水线执行中，请等待当前流程完成' });
    try {
      const config = loadConfig(ctx.configPath);
      if (!config.memory?.model) return json(res, 400, { error: '记忆模型未配置——请先在「模型配置」卡填写并保存' });
      void runInstall({ configPath: ctx.configPath, model: config.memory.model, pin: config.memory.version, forceRestart: true });
      return json(res, 200, { ok: true, started: true, note: '应用流水线后台执行中（重渲染配置 → 重启服务 → 校验插件），轮询 /api/memory/install/status 查看进度' });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // ---- P3「用户与密钥」Tab（最终方案 §六 Tab2）：用户聚合 / 一键初始化 / 密钥 reveal·重置·删除 ----
  // 全部走 root key Admin API；密钥明文只在 reveal 响应单次放行（前端进剪贴板）并留痕审计
  if (path === '/api/memory/users' && req.method === 'GET') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请先提交 bootstrap 向导' });
    try {
      return json(res, 200, await listMemoryUsers(loadConfig(ctx.configPath)));
    } catch (e) {
      return json(res, 500, { error: `用户列表聚合失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  if (path === '/api/memory/users/init' && req.method === 'POST') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请先提交 bootstrap 向导' });
    try {
      return json(res, 200, await initMemoryUsers(loadConfig(ctx.configPath)));
    } catch (e) {
      return json(res, 500, { error: `一键初始化失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // 新建用户（「用户与密钥」弹窗）：Admin API 创建 + 密钥入保险库；显示名称走配置 doc 管道（前端 saveDoc）
  if (path === '/api/memory/users/create' && req.method === 'POST') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请先提交 bootstrap 向导' });
    const body = await readJsonBody(req);
    const uid = typeof body.user_id === 'string' ? body.user_id : '';
    try {
      return json(res, 200, await createMemoryUser(loadConfig(ctx.configPath), uid));
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (path === '/api/memory/users/reveal' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const uid = typeof body.user_id === 'string' ? body.user_id : '';
    try {
      return json(res, 200, await revealUserKey(loadConfig(ctx.configPath), uid));
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (path === '/api/memory/users/reveal-root' && req.method === 'POST') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请先提交 bootstrap 向导' });
    try {
      return json(res, 200, await revealRootKey(loadConfig(ctx.configPath)));
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (path === '/api/memory/users/reset' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const uid = typeof body.user_id === 'string' ? body.user_id : '';
    try {
      return json(res, 200, await resetUserKey(loadConfig(ctx.configPath), uid));
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (path === '/api/memory/users/delete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const uid = typeof body.user_id === 'string' ? body.user_id : '';
    try {
      return json(res, 200, await deleteMemoryUser(loadConfig(ctx.configPath), uid));
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
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
      // ?refresh=1：先刷新远程市场索引再读清单（只拉最新版本号，绝不升级已装插件——
      // 升级仍走单行「更新」/「全部更新」）。插件页开页即带此参；节流与失败降级在
      // refreshMarketplaceIndex 内部（无远程市场零 spawn；失败仅收集 warning，列表照常返回）
      const refreshWarnings: string[] = [];
      if (url.searchParams.get('refresh') === '1') {
        const force = url.searchParams.get('force') === '1';
        const dirs = sameDir ? [bridgeDir] : [bridgeDir, userDir];
        const rs = await Promise.all(dirs.map((d) =>
          refreshMarketplaceIndex(d, { force }).catch((e) => ({
            refreshed: false, warning: `市场索引刷新异常：${e instanceof Error ? e.message : String(e)}`,
          }))));
        for (const r of rs) if (r.warning) refreshWarnings.push(r.warning);
      }
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
        ...(refreshWarnings.length ? { refreshWarning: refreshWarnings.join('；') } : {}),
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
      // 卸载连带清市场：mp 必须在 uninstall 执行前解析（卸载后安装清单记录已消失）
      const mp = op === 'uninstall'
        ? resolvePluginMarketplace(arg, sameDir ? [dir] : [bridgeDir, userDir])
        : undefined;
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
      // 卸载成功且市场清空 → 自动移除市场（半完成分支提前返回不做：插件记录仍在，保留市场更安全）
      let result = r;
      if (op === 'uninstall' && mp && r.ok && !listInstalledPlugins(dir).some((p) => p.key === arg)) {
        const rm = await removeMarketplaceIfUnused(mp, sameDir ? [dir] : [bridgeDir, userDir]);
        invalidatePluginCache(bridgeDir);
        if (!sameDir) invalidatePluginCache(userDir);
        if (rm.removed) result = { ...r, text: `${r.text}\n🧹 已自动移除无剩余插件的市场 ${mp}` };
      }
      return json(res, 200, result);
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
  // ---- 接入申请（配对授权）：配置页「权限 → 接入申请」。数据层直读/直写 access.json——
  // 桥内 AccessControl 每条消息前 reload，此处批准/拒绝后用户下一条消息即放行；
  // 终端 lcb pair 双通道并存。申请人真名按 appId 借网关通讯录解析（失败降级原始 id） ----
  if (path === '/api/access/pending' && req.method === 'GET') {
    const items = AccessControl.load(join(CONFIG_DIR, 'access.json')).listPendingDetailed();
    const byApp = new Map<string, string[]>();
    for (const it of items) {
      if (!it.appId) continue;
      byApp.set(it.appId, [...(byApp.get(it.appId) ?? []), it.userId]);
    }
    const names = new Map<string, string>();
    for (const [appId, ids] of byApp) {
      try {
        for (const [uid, n] of await fetchUserNames(appId, ids)) names.set(uid, n);
      } catch { /* 解析失败降级原始 id 展示 */ }
    }
    let appNames = new Map<string, string>();
    try {
      appNames = new Map((loadConfig(ctx.configPath)?.apps ?? []).map((a) => [a.appId, a.name || a.appId]));
    } catch { /* 配置损坏降级 appId */ }
    return json(res, 200, {
      pending: items.map((it) => {
        const n = names.get(it.userId);
        return {
          userId: it.userId,
          name: it.name,
          code: it.code,
          appId: it.appId,
          appName: it.appId ? appNames.get(it.appId) : undefined,
          displayName: n && n !== it.userId ? n : undefined,
          expiresAt: it.expiresAt,
          expiresInSec: Math.max(0, Math.round((it.expiresAt - Date.now()) / 1000)),
        };
      }),
    });
  }
  if (path === '/api/access/pending/approve' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const code = String(body.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) return json(res, 400, { error: '配对码格式不正确（6 位数字）' });
    const r = AccessControl.load(join(CONFIG_DIR, 'access.json')).approvePairing(code);
    if (!r.ok) return json(res, 404, { error: r.error ?? '配对码无效或已过期' });
    console.log(`[配对] 配置页批准配对码 ${code}（用户 ${r.userId}${r.isFirstAdmin ? '，成为 admin' : '，member'}）`);
    return json(res, 200, { ok: true, userId: r.userId, isFirstAdmin: r.isFirstAdmin });
  }
  if (path === '/api/access/pending/reject' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const code = String(body.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) return json(res, 400, { error: '配对码格式不正确（6 位数字）' });
    const ok = AccessControl.load(join(CONFIG_DIR, 'access.json')).rejectPairing(code);
    if (!ok) return json(res, 404, { error: '配对码无效或已过期' });
    console.log(`[配对] 配置页拒绝配对码 ${code}`);
    return json(res, 200, { ok: true });
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
    // 只更新 bridge 自身。飞书 CLI（@larksuite/cli）的更新是概览页里一个独立的动作
    // （lark-cli 行内的「更新」按钮），两条更新各走各的按钮——不要一个操作把两件事
    // 一起做掉：用户看不见 CLI 那半程的进展，失败时还只能拿到一句附注。
    try {
      const output = await runUpdate();
      return json(res, 200, { ok: true, output });
    } catch (e) {
      return json(res, 502, { error: `更新失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // ---- 开机自启（概览页开关）：GET 查 OS 实际状态；POST 注册/注销并回写意图 ----
  if (path === '/api/autostart' && req.method === 'GET') {
    const entry = resolveLcbEntry();
    if (!entry.ok) {
      return json(res, 200, { supported: false, enabled: false, platform: process.platform, detail: entry.error });
    }
    return json(res, 200, await getAutostartStatus({ entryPath: entry.entry })); // 查询失败走外层 catch → 500
  }
  if (path === '/api/autostart' && req.method === 'POST') {
    if (firstRun) return json(res, 404, { error: '尚无配置文件（首次安装），请先完成 bootstrap 向导' });
    const entry = resolveLcbEntry();
    if (!entry.ok) return json(res, 400, { error: entry.error }); // tsx 源码模式：明确拒绝
    const body = await readJsonBody(req);
    const enabled = body.enabled === true;
    try {
      // 先 OS 注册（失败即中断、意图不落盘），再写 config 意图——写失败可容忍（下次开关自愈）。
      // autostart 值未变时跳过重写：整段 set 会丢掉段内手写注释（同 PUT /api/config 的折损规避）
      const status = await setAutostartEnabled(enabled, { entryPath: entry.entry });
      const rawText = readFileSync(ctx.configPath, 'utf8');
      const oldJs = parseDocument(rawText).toJS() as Record<string, unknown>;
      const intent = { enabled };
      if (JSON.stringify(oldJs.autostart ?? null) !== JSON.stringify(intent)) {
        const doc = parseDocument(rawText);
        doc.set('autostart', intent);
        const text = doc.toString();
        parseConfigText(text, ctx.configPath); // 写盘前内存校验：拒绝坏配置落盘
        writeAtomic(ctx.configPath, text);
      }
      return json(res, 200, status);
    } catch (e) {
      return json(res, 502, { error: `开机自启${enabled ? '开启' : '关闭'}失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // ---- 飞书官方 CLI（@larksuite/cli）状态 / 授权 / 安装 ----
  if (path === '/api/lark-cli' && req.method === 'GET') {
    const d = await detectLarkCli().catch((): { installed: boolean; version?: string } => ({ installed: false }));
    const withCheck = url.searchParams.get('check') === '1';
    const latest = withCheck ? await checkLarkCliLatest().catch(() => undefined) : undefined;
    // 授权状态与 check=1 解耦：auth status 是纯本地探测（约百毫秒），要撑住弹窗的 5s 轮询；
    // npm view 走网络，只在 check=1 时打。未安装时完全不探测（零开销）。
    const auth = d.installed
      ? await checkLarkCliAuth().catch((e: unknown) => ({
          state: 'unknown' as const,
          detail: `探测异常：${e instanceof Error ? e.message : String(e)}`,
        }))
      : undefined;
    // SKILL 状态：纯本地目录扫描；与安装动作同源查 ~/.claude/skills（managed 会话的
    // 可见性由启动时 bridgeUserSkills 桥接保证，前端在装完 skill 后提示重启桥接器）
    const skill = d.installed
      ? await detectLarkCliSkill().catch(() => ({ installed: false }))
      : { installed: false };
    return json(res, 200, {
      ...d,
      ...(auth ? { auth } : {}),
      ...{ skill },
      ...(latest ? { latest, hasUpdate: d.version ? hasNewerVersion(latest, d.version) : true } : {}),
    });
  }
  if (path === '/api/lark-cli/action' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
    const op = String(body.op ?? '');
    if (op !== 'install' && op !== 'update' && op !== 'auth' && op !== 'config' && op !== 'skill') {
      return json(res, 400, { error: 'op 仅支持 install / update / auth / config / skill' });
    }
    // 编排（拉起终端 / 降级静默 / 互斥 / 冷却）全部在 manager 里，这里只做薄路由
    const r = await runLarkCliActionFlow(op as LarkCliOp);
    if (r.busy) return json(res, 409, { error: r.error, busy: true });
    if (!r.ok) return json(res, 502, { error: r.error });
    return json(res, 200, r);
  }
  // ---- 飞书扫码授权（设备流）：长生命周期有状态会话，独立于上面的即发即忘 action ----
  // device_code 只存后端内存，**任何响应都不下发**（见 manager 的 deviceInfo）
  if (path === '/api/lark-cli/device/start' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
    const r = await startLarkCliDeviceAuth({ regenerate: body.regenerate === true });
    if (!r.ok) return json(res, 502, { error: r.error, ...(r.hint ? { hint: r.hint } : {}) });
    return json(res, 200, r);
  }
  // 永远 200：core.js 的 api() 对非 2xx 一律 throw，会被前端当成故障弹 toast；
  // 「从未发起 / 桥接器重启后内存已清」是可控业务态（state:'none'），不是错误。
  if (path === '/api/lark-cli/device/status' && req.method === 'GET') {
    return json(res, 200, getLarkCliDeviceStatus());
  }
  // ---- 配置应用（页面二维码）：同样是长生命周期有状态会话 ----
  // 与设备流分开一对端点而非加 phase 字段：两个会话的字段集不同（配置流没有
  // device_code / interval），共用一个端点会让 manager 侧「显式挑字段」的防泄漏结构变模糊。
  if (path === '/api/lark-cli/config/start' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
    const r = await startLarkCliConfigFlow({ regenerate: body.regenerate === true });
    if (!r.ok) return json(res, 502, { error: r.error, ...(r.hint ? { hint: r.hint } : {}) });
    return json(res, 200, r);
  }
  // 永远 200，理由同 device/status：core.js 的 api() 对非 2xx 一律 throw，
  // 「从未发起 / 桥接器重启后内存已清」是可控业务态（state:'none'），不是错误
  if (path === '/api/lark-cli/config/status' && req.method === 'GET') {
    return json(res, 200, getLarkCliConfigStatus());
  }
  return json(res, 404, { error: `未知端点 ${req.method} ${path}` });
}
