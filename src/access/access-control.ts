import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt } from 'node:crypto';

const TTL_MS = 15 * 60 * 1000;

export interface AccessStoreData {
  users: Record<string, { name: string; role: 'admin' | 'member'; pairedAt: string }>;
  pending: Record<string, { userId: string; name: string; code: string; expiresAt: number }>;
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
  listPending(): Array<{ userId: string; name: string; code: string }> {
    this.evict();
    return Object.values(this.data.pending).map(({ userId, name, code }) => ({ userId, name, code }));
  }
  beginPairing(userId: string, name: string): string {
    this.evict();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.data.pending[userId] = { userId, name, code, expiresAt: Date.now() + TTL_MS };
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
