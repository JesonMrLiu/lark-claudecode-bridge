import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt } from 'node:crypto';

const TTL_MS = 15 * 60 * 1000;

export interface AccessStoreData {
  users: Record<string, { name: string; role: 'admin' | 'member'; pairedAt: string; appId?: string }>;
  pending: Record<string, { userId: string; name: string; code: string; expiresAt: number; appId?: string }>;
}

export class AccessControl {
  private data: AccessStoreData;
  constructor(private storePath: string, data?: AccessStoreData) {
    this.data = data ?? { users: {}, pending: {} };
  }
  static load(storePath: string): AccessControl {
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8')) as AccessStoreData;
      return new AccessControl(storePath, { users: raw.users ?? {}, pending: raw.pending ?? {} });
    } catch {
      return new AccessControl(storePath);
    }
  }
  /**
   * 重读 store 文件并整体替换内存态：`lcb pair` / 运行终端等独立路径批准写盘后，
   * 桥内长存实例经 reload 即可感知（否则 isAllowed 查旧内存 → 反复发配对码 →
   * beginPairing 的整盘覆写把刚批准的 users 抹掉，形成死循环）。
   * 读盘失败（文件不存在/损坏）保持内存不动——首次配对前 store 尚未落盘属正常。
   */
  reload(): void {
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as AccessStoreData;
      this.data = { users: raw.users ?? {}, pending: raw.pending ?? {} };
    } catch {
      // 忽略：以上一次内存态继续服务
    }
  }
  private save(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
  isAllowed(userId: string): boolean {
    return Boolean(this.data.users[userId]);
  }
  isAdmin(userId: string): boolean {
    return this.data.users[userId]?.role === 'admin';
  }
  /**
   * 是否已有用户。传 appId 时按应用统计——多应用部署下 open_id 按应用隔离，
   * 「首个使用者免配对自动 admin」也应按应用判定：新应用的第一个使用者同样直接成为
   * admin，而不是因为别的应用已有用户就被迫走配对码。无 appId 的历史记录不计入
   * 任何应用（它们会在下次发消息时被 ensureAppId 补登）。
   */
  hasUsers(appId?: string): boolean {
    if (appId === undefined) return Object.keys(this.data.users).length > 0;
    return Object.values(this.data.users).some((u) => u.appId === appId);
  }
  /**
   * 直接添加用户（首个使用者免配对自动成为 admin 用）。
   * 已存在时按传入 role/name 覆盖——与 approvePairing 的写语义一致（后写胜出）。
   */
  addUser(userId: string, name: string, role: 'admin' | 'member', appId?: string): void {
    this.data.users[userId] = { name, role, pairedAt: new Date().toISOString(), ...(appId ? { appId } : {}) };
    delete this.data.pending[userId]; // 残留的配对申请一并清掉
    this.save();
  }
  /** 历史用户记录缺 appId 时按当前来路补登（老版本 access.json 的平滑迁移） */
  ensureAppId(userId: string, appId: string): void {
    const u = this.data.users[userId];
    if (u && !u.appId) {
      u.appId = appId;
      this.save();
    }
  }
  listPending(): Array<{ userId: string; name: string; code: string }> {
    this.evict();
    return Object.values(this.data.pending).map(({ userId, name, code }) => ({ userId, name, code }));
  }
  beginPairing(userId: string, name: string, appId?: string): string {
    this.evict();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.data.pending[userId] = { userId, name, code, expiresAt: Date.now() + TTL_MS, ...(appId ? { appId } : {}) };
    this.save();
    return code;
  }
  approvePairing(code: string): { ok: boolean; userId?: string; isFirstAdmin?: boolean; error?: string } {
    this.evict();
    const entry = Object.values(this.data.pending).find((p) => p.code === code);
    if (!entry) return { ok: false, error: '配对码无效或已过期' };
    const isFirstAdmin = Object.keys(this.data.users).length === 0;
    this.data.users[entry.userId] = {
      name: entry.name,
      role: isFirstAdmin ? 'admin' : 'member',
      pairedAt: new Date().toISOString(),
      ...(entry.appId ? { appId: entry.appId } : {}),
    };
    delete this.data.pending[entry.userId];
    this.save();
    return { ok: true, userId: entry.userId, isFirstAdmin };
  }
  rejectPairing(code: string): boolean {
    const entry = Object.values(this.data.pending).find((p) => p.code === code);
    if (!entry) return false;
    delete this.data.pending[entry.userId];
    this.save();
    return true;
  }
  private evict(): void {
    const now = Date.now();
    for (const [uid, p] of Object.entries(this.data.pending)) {
      if (p.expiresAt < now) delete this.data.pending[uid];
    }
  }
}
