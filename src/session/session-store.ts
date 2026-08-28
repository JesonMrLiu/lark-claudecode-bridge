import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionMeta {
  sessionId: string;
  summary: string;
  updatedAt: string;
}

/** 通道状态：sessions[0] 为当前会话，其余按新→旧排列 */
export interface ChannelState {
  workspaceName: string;
  sessions: SessionMeta[];
}

/**
 * 通道会话存储：JSON 文件持久化，每个 channelKey 一份 ChannelState。
 * 约定：sessions 数组按新→旧排列，sessions[0] 即当前会话；
 * /resume 列表展示时按时间正序编号（1 = 最早归档），恢复后移回数组头部。
 */
export class SessionStore {
  private data: Record<string, ChannelState> = {};

  private constructor(private path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ChannelState>;
      } catch {
        this.data = {};
      }
    }
  }

  static load(path: string): SessionStore {
    return new SessionStore(path);
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8');
  }

  getChannelState(key: string): ChannelState | undefined {
    return this.data[key];
  }

  setChannelState(key: string, state: ChannelState): void {
    this.data[key] = state;
    this.save();
  }

  /** 归档会话并置为当前（头插，去重；summary 截断到 60 字） */
  archiveSession(key: string, sessionId: string, summary: string): void {
    const st = this.data[key] ?? { workspaceName: '', sessions: [] };
    const rest = st.sessions.filter((s) => s.sessionId !== sessionId);
    st.sessions = [{ sessionId, summary: summary.slice(0, 60), updatedAt: new Date().toISOString() }, ...rest];
    this.data[key] = st;
    this.save();
  }

  /**
   * 开启新会话：channel 不存在时以 defaultWorkspace 初始化；
   * 已存在时保持工作区与历史不变（历史由 /new 命令显式清空）。
   */
  newSession(key: string, defaultWorkspace: string): void {
    if (!this.data[key]) {
      this.setChannelState(key, { workspaceName: defaultWorkspace, sessions: [] });
    }
  }

  listSessions(key: string): SessionMeta[] {
    return this.data[key]?.sessions ?? [];
  }
}
