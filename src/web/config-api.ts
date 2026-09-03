// Web 配置页 API 纯函数层：secret 脱敏/回填、Host 校验、重启段落计算。
// 无 IO（读写盘在 server.ts），tests/web/config-api.test.ts 直接单测
import type { BridgeConfig, FeishuAppConfig } from '../types.js';
import { sameApps } from '../config.js';

/** secret 字段的脱敏回显形状（真实值永不离开本机进程） */
export interface SecretHint { secretSet: boolean; secretHint?: string }

export function maskSecret(value: string | undefined): SecretHint {
  if (!value) return { secretSet: false };
  return { secretSet: true, secretHint: `••••${value.slice(-4)}` };
}

/** 客户端提交的 secret 字段是否应视为「未修改」（空串/缺省/仍是脱敏对象都算） */
export function isUnchangedSecret(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'object') return true; // 仍是 GET 回显的 {secretSet...} 对象
  if (typeof v === 'string') return v.trim() === '';
  return true;
}

/**
 * secret 回填：客户端 doc 中的 secret 字段（apps[].app_secret、claude.auth_token/api_key）
 * 未修改时回填磁盘现值。非 secret 字段不动；其余 secret 位置（未来新增）按同模式扩展。
 */
export function applySecrets(newDoc: Record<string, unknown>, oldDoc: Record<string, unknown>): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...newDoc };
  const newApps = Array.isArray(doc.apps) ? (doc.apps as Array<Record<string, unknown>>) : [];
  const oldApps = Array.isArray(oldDoc.apps) ? (oldDoc.apps as Array<Record<string, unknown>>) : [];
  // 按 app_id 对齐回填（而非索引）：页面可能增删/重排应用，索引对齐会把别的应用 secret 错配
  const oldSecretById = new Map(oldApps.map((a) => [String(a?.app_id ?? ''), a?.app_secret]));
  doc.apps = newApps.map((app) => (
    isUnchangedSecret(app?.app_secret)
      ? { ...app, app_secret: oldSecretById.get(String(app?.app_id ?? '')) } // 新应用查不到 → undefined，loadConfig 拦截
      : app
  ));
  if (doc.claude && typeof doc.claude === 'object' && !Array.isArray(doc.claude)) {
    const newClaude = { ...(doc.claude as Record<string, unknown>) };
    const oldClaude = oldDoc.claude && typeof oldDoc.claude === 'object' && !Array.isArray(oldDoc.claude)
      ? (oldDoc.claude as Record<string, unknown>)
      : {};
    for (const key of ['auth_token', 'api_key'] as const) {
      if (isUnchangedSecret(newClaude[key])) newClaude[key] = oldClaude[key];
    }
    doc.claude = newClaude;
  }
  return doc;
}

/** GET /api/config 响应构建：深拷贝 doc 并把 secret 字段替换为脱敏提示 */
export function docForClient(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(doc ?? {}));
  if (Array.isArray(out.apps)) {
    out.apps = (out.apps as Array<Record<string, unknown>>).map((app) => ({
      ...app,
      app_secret: maskSecret(typeof app?.app_secret === 'string' ? app.app_secret : undefined),
    }));
  }
  if (out.claude && typeof out.claude === 'object') {
    const c = { ...(out.claude as Record<string, unknown>) };
    for (const key of ['auth_token', 'api_key'] as const) {
      c[key] = maskSecret(typeof c[key] === 'string' ? c[key] as string : undefined);
    }
    out.claude = c;
  }
  return out;
}

/**
 * Host header 校验（防 DNS rebinding）：host 部分（去端口）必须是回环名或配置的 host。
 * 端口不校验（localhost:port 与 127.0.0.1:port 等价放行，用户从哪个名字进来无从假设）。
 */
export function isAllowedHost(hostHeader: string | undefined, cfgHost: string): boolean {
  if (!hostHeader) return false;
  let hostPart = hostHeader;
  const bracket = hostPart.match(/^\[([^\]]+)\]/); // 规范 IPv6 host：[::1]:8080
  if (bracket) {
    hostPart = bracket[1];
  } else {
    // 仅单一冒号视为 host:port（裸 IPv6 多冒号整体保留；多冒号场景只可能命中 '::1' 白名单）
    const last = hostPart.lastIndexOf(':');
    if (last !== -1 && hostPart.indexOf(':') === last) hostPart = hostPart.slice(0, last);
  }
  return hostPart === '127.0.0.1' || hostPart === 'localhost' || hostPart === '::1' || hostPart === cfgHost;
}

/** Origin header 校验（存在才查；同源 fetch 一定带且 host 合法，跨站请求携带外域 Origin） */
export function isAllowedOrigin(originHeader: string | undefined, cfgHost: string, cfgPort: number): boolean {
  if (!originHeader) return true; // 非 CORS 场景（curl / 同源部分实现）无 Origin，放行给 Host 校验兜底
  try {
    const u = new URL(originHeader);
    return u.origin === `http://${cfgHost}:${cfgPort}`
      || u.origin === `http://127.0.0.1:${cfgPort}`
      || u.origin === `http://localhost:${cfgPort}`;
  } catch {
    return false;
  }
}

/** PUT 前后比较，列出需重启的段落（其余段落经热重载器下一条消息生效） */
export function computeRestartRequired(before: BridgeConfig, after: BridgeConfig): string[] {
  const sections: string[] = [];
  if (!sameApps(before.apps, after.apps)) sections.push('apps');
  if (before.concurrency !== after.concurrency) sections.push('concurrency');
  if (JSON.stringify(before.claude ?? {}) !== JSON.stringify(after.claude ?? {})) sections.push('claude');
  if (JSON.stringify(before.server ?? {}) !== JSON.stringify(after.server ?? {})) sections.push('server');
  return sections;
}

/** apps 启动态摘要（GET /api/status 用；lcb ui 独立进程无法得知，标 unknown） */
export function appStatusSummary(apps: FeishuAppConfig[], started?: Array<{ name: string; started: boolean }>): Array<{ name: string; appId: string; started: boolean | 'unknown' }> {
  return apps.map((a) => ({
    name: a.name,
    appId: a.appId,
    started: started?.find((s) => s.name === a.name)?.started ?? 'unknown',
  }));
}
