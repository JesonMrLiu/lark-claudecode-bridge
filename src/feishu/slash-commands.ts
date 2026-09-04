// 飞书 Slash Command 同步：把 bridge 命令一键注册为飞书输入框斜杠指令
// （用户输入 / 弹面板 → 选中后命令留在输入框可继续输入描述 → 发送后走 bridge 命令/透传链路）。
// API：application/v7/app_slash_commands CRUD，scope application:app_slash_command:write/read，
// tenant_access_token 认证；上限 100 条；客户端生效约 5 分钟（PC 端 7.70+）。
// 纯函数（expectedCommands / diffSlashCommands）与执行（syncSlashCommands）分离，测试免网络
import * as lark from '@larksuiteoapi/node-sdk';
import type { BridgeConfig, FeishuAppConfig, SlashCommandDef } from '../types.js';
import { SLASH_COMMAND_META } from '../session/commands.js';

/** 远端（飞书侧）已注册的斜杠命令（GET 列表条目） */
export interface RemoteSlashCommand {
  command_id: string;
  command: string;
  description: { default_value?: string; i18n?: Record<string, string>; icon?: { icon_key?: string } };
}

/** 最小 API 客户端（执行器依赖此接口，测试注入 mock） */
export interface SlashApiClient {
  list(): Promise<RemoteSlashCommand[]>;
  create(def: SlashCommandDef): Promise<string>;
  update(commandId: string, def: SlashCommandDef): Promise<void>;
  remove(commandId: string): Promise<void>;
}

/** 内置命令集（SLASH_COMMAND_META 全量映射为注册定义）——expectedCommands 与 ensureBuiltins 共用 */
export function builtinCommands(): SlashCommandDef[] {
  return Object.entries(SLASH_COMMAND_META).map(([command, meta]) => ({
    command, description: meta.description, icon: meta.icon,
  }));
}

/** 期望集 = 内置命令（SLASH_COMMAND_META 全量）+ config extras；与内置重名的 extra 跳过（内置优先） */
export function expectedCommands(config: BridgeConfig): SlashCommandDef[] {
  const out = builtinCommands();
  const seen = new Set(out.map((d) => d.command));
  for (const extra of config.slashCommands?.extra ?? []) {
    if (seen.has(extra.command)) {
      console.warn(`[斜杠命令] extra "${extra.command}" 与内置命令重名，已跳过（内置优先）`);
      continue;
    }
    seen.add(extra.command);
    out.push(extra);
  }
  return out;
}

function sameCommand(remote: RemoteSlashCommand, def: SlashCommandDef): boolean {
  const desc = remote.description ?? {};
  return desc.default_value === def.description
    && desc.i18n?.zh_cn === def.description
    && desc.i18n?.en_us === def.description
    && (desc.icon?.icon_key ?? 'skill_outlined') === (def.icon ?? 'skill_outlined');
}

/** 全量对齐 diff：远端按 command 名匹配期望集；描述/icon 变化进 toUpdate，远端多余进 toDelete */
export function diffSlashCommands(remote: RemoteSlashCommand[], expected: SlashCommandDef[]): {
  toCreate: SlashCommandDef[];
  toUpdate: Array<{ commandId: string; def: SlashCommandDef }>;
  toDelete: Array<{ commandId: string; command: string }>;
  unchanged: string[];
} {
  const byName = new Map(remote.map((r) => [r.command, r]));
  const toCreate: SlashCommandDef[] = [];
  const toUpdate: Array<{ commandId: string; def: SlashCommandDef }> = [];
  const unchanged: string[] = [];
  for (const def of expected) {
    const r = byName.get(def.command);
    if (!r) { toCreate.push(def); continue; }
    if (sameCommand(r, def)) unchanged.push(def.command);
    else toUpdate.push({ commandId: r.command_id, def });
  }
  const expectedNames = new Set(expected.map((d) => d.command));
  const toDelete = remote.filter((r) => !expectedNames.has(r.command))
    .map((r) => ({ commandId: r.command_id, command: r.command }));
  return { toCreate, toUpdate, toDelete, unchanged };
}

export interface SyncReport {
  created: string[];
  updated: string[];
  deleted: string[];
  unchanged: string[];
  errors: Array<{ command: string; error: string }>;
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number; msg?: string; message?: string };
  return e?.code === 40000000 || /already exists/i.test(String(e?.msg ?? e?.message ?? ''));
}

/** 执行全量对齐同步：list → diff → 逐条 create/update/delete，每条独立容错汇总报告 */
export async function syncSlashCommands(client: SlashApiClient, expected: SlashCommandDef[]): Promise<SyncReport> {
  const report: SyncReport = { created: [], updated: [], deleted: [], unchanged: [], errors: [] };
  let remote: RemoteSlashCommand[];
  try {
    remote = await client.list();
  } catch (e) {
    report.errors.push({ command: '(list)', error: e instanceof Error ? e.message : String(e) });
    return report;
  }
  const { toCreate, toUpdate, toDelete, unchanged } = diffSlashCommands(remote, expected);
  report.unchanged = unchanged;
  for (const def of toCreate) {
    try {
      await client.create(def);
      report.created.push(def.command);
    } catch (e) {
      if (isAlreadyExists(e)) {
        // 并发/历史残留导致重名：转为对现有条目的更新，保证对齐
        try {
          const existing = (await client.list()).find((r) => r.command === def.command);
          if (existing) { await client.update(existing.command_id, def); report.updated.push(def.command); continue; }
        } catch { /* 落入 errors */ }
      }
      report.errors.push({ command: def.command, error: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const { commandId, def } of toUpdate) {
    try {
      await client.update(commandId, def);
      report.updated.push(def.command);
    } catch (e) {
      report.errors.push({ command: def.command, error: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const { commandId, command } of toDelete) {
    try {
      await client.remove(commandId);
      report.deleted.push(command);
    } catch (e) {
      report.errors.push({ command, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

/**
 * 只补齐远端缺失的内置命令（0.13 Web 页「补齐内置命令」按钮）：
 * list → 内置差集 → 逐条 create，**绝不 delete/update 远端已有命令**（用户手动注册的命令不受影响）。
 * deleted/updated 恒空；already-exists（并发残留）计 unchanged。
 */
export async function ensureBuiltins(client: SlashApiClient, builtins: SlashCommandDef[]): Promise<SyncReport> {
  const report: SyncReport = { created: [], updated: [], deleted: [], unchanged: [], errors: [] };
  let remote: RemoteSlashCommand[];
  try {
    remote = await client.list();
  } catch (e) {
    report.errors.push({ command: '(list)', error: e instanceof Error ? e.message : String(e) });
    return report;
  }
  const names = new Set(remote.map((r) => r.command));
  for (const def of builtins) {
    if (names.has(def.command)) { report.unchanged.push(def.command); continue; }
    try {
      await client.create(def);
      report.created.push(def.command);
    } catch (e) {
      if (isAlreadyExists(e)) { report.unchanged.push(def.command); continue; }
      report.errors.push({ command: def.command, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

/** node-sdk 通用 request 的最小类型（官方 Client.request 支持 data/params，SDK 类型面未导出） */
interface SdkClient {
  request(payload: { method: string; url: string; data?: unknown }): Promise<unknown>;
}
interface SdkModule {
  Client: new (opts: { appId: string; appSecret: string; domain?: unknown }) => SdkClient;
  Domain: { Feishu: unknown; Lark: unknown };
}

/** 独立 API 客户端：不依赖运行中的 gateway（lcb ui 独立进程同样可用）；token 由 SDK 自管 */
export function createSlashApiClient(app: FeishuAppConfig, sdk: SdkModule = lark as unknown as SdkModule): SlashApiClient {
  const client = new sdk.Client({
    appId: app.appId,
    appSecret: app.appSecret,
    domain: app.domain === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu,
  });
  // 业务失败 SDK 不抛错而是 code!=0：统一在此转 throw，调用方单一错误通道
  const call = async <T>(payload: { method: string; url: string; data?: unknown }): Promise<T> => {
    const res = (await client.request(payload)) as { code?: number; msg?: string; data?: T };
    if (res && typeof res.code === 'number' && res.code !== 0) {
      const err = new Error(`${res.msg ?? 'unknown'}（code ${res.code}）`);
      (err as { code?: number }).code = res.code;
      throw err;
    }
    return (res?.data ?? ({} as T));
  };
  const body = (def: SlashCommandDef) => ({
    description: {
      default_value: def.description,
      i18n: { zh_cn: def.description, en_us: def.description },
      ...(def.icon ? { icon: { icon_key: def.icon } } : {}),
    },
  });
  return {
    list: async () => (await call<{ items?: RemoteSlashCommand[] }>({ method: 'GET', url: '/open-apis/application/v7/app_slash_commands' })).items ?? [],
    create: async (def) => (await call<{ command_id: string }>({
      method: 'POST', url: '/open-apis/application/v7/app_slash_commands',
      data: { command: def.command, ...body(def) },
    })).command_id,
    update: async (commandId, def) => {
      await call({ method: 'PATCH', url: `/open-apis/application/v7/app_slash_commands/${commandId}`, data: body(def) });
    },
    remove: async (commandId) => {
      await call({ method: 'DELETE', url: `/open-apis/application/v7/app_slash_commands/${commandId}` });
    },
  };
}
