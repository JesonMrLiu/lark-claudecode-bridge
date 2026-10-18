// 飞书用户名/群名持久化缓存：open_id / chat_id → 真名，全场景共用一份磁盘库。
// 背景（主人拍板 2026-10-18）：名称翻译此前散落 chats-api 与 gateway 各建内存缓存——重启即空、
// 同一用户反复打飞书 API、多处逻辑漂移。这里统一为磁盘缓存（CONFIG_DIR/feishu-names.json）：
// 重启不丢、跨场景命中（会话页 / 接入申请 / 配对通知 / access 回填）、TTL 长（用户名 30 天、
// 群名 3 天——群改名数日内可见）。解析失败态不落盘（只留各调用方内存短缓存，10 分钟自愈）。
// open_id 是应用维度标识：key 一律带 appId（同一人在不同应用下 open_id 不同，不能串库）。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config.js';

const STORE_PATH = join(CONFIG_DIR, 'feishu-names.json');
const USER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 用户名 30 天（飞书改名低频）
const CHAT_TTL_MS = 3 * 24 * 60 * 60 * 1000;  // 群名 3 天（群改名数日内可见）
const PERSIST_MIN_MS = 30_000;                // 落盘节流：30s 内的写入合并成一次（重启最多丢 30s 增量）

interface UserEntry { name: string; at: number }
interface ChatEntry { name?: string; chatType?: string; at: number }
interface NameStore {
  v: 1;
  users: Record<string, UserEntry>;
  chats: Record<string, ChatEntry>;
  /** openId → unionId 索引（消息事件自带时落盘）。union_id 同开发商恒定，无 TTL；
   *  兄弟应用桥（sibling-names）靠它解析本应用通讯录范围外用户的真名 */
  unions?: Record<string, string>;
}

let store: NameStore = { v: 1, users: {}, chats: {} };
let loaded = false;
let lastPersistAt = 0;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(STORE_PATH)) {
      const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as Partial<NameStore>;
      if (raw && typeof raw === 'object') {
        store = { v: 1, users: raw.users ?? {}, chats: raw.chats ?? {}, unions: raw.unions ?? {} };
      }
    }
  } catch { /* 损坏：空库起步，下次写盘自愈 */ }
}

function persist(): void {
  const now = Date.now();
  if (now - lastPersistAt < PERSIST_MIN_MS) return; // 节流：高频写入合并
  lastPersistAt = now;
  try {
    const tmp = `${STORE_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(store), 'utf8');
    renameSync(tmp, STORE_PATH);
  } catch { /* 落盘失败降级内存态，下轮写入再试 */ }
}

/** 磁盘命中返回真名；未命中/过期返回 undefined（调用方走飞书 API） */
export function getCachedUserName(appId: string, openId: string): string | undefined {
  load();
  const e = store.users[`${appId}/${openId}`];
  return e && Date.now() - e.at < USER_TTL_MS ? e.name : undefined;
}

export function putCachedUserName(appId: string, openId: string, name: string): void {
  load();
  store.users[`${appId}/${openId}`] = { name, at: Date.now() };
  persist();
}

export function getCachedChatMeta(appId: string, chatId: string): { name?: string; chatType?: string } | undefined {
  load();
  const e = store.chats[`${appId}/${chatId}`];
  if (!e || Date.now() - e.at >= CHAT_TTL_MS) return undefined;
  return { name: e.name, chatType: e.chatType };
}

export function putCachedChatMeta(appId: string, chatId: string, meta: { name?: string; chatType?: string }): void {
  load();
  store.chats[`${appId}/${chatId}`] = { ...meta, at: Date.now() };
  persist();
}

/** openId 的 union_id（消息事件落盘）；没有索引返回 undefined */
export function getCachedUserUnion(appId: string, openId: string): string | undefined {
  load();
  return store.unions?.[`${appId}/${openId}`];
}

/** 记录 openId → unionId（已存同值时零写入，不触落盘节流） */
export function putCachedUserUnion(appId: string, openId: string, unionId: string): void {
  load();
  if (!store.unions) store.unions = {};
  const key = `${appId}/${openId}`;
  if (store.unions[key] === unionId) return;
  store.unions[key] = unionId;
  persist();
}
