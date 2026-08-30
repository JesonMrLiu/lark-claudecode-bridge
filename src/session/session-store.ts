import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SessionMeta {
  sessionId: string;
  summary: string;
  updatedAt: string;
}

/** 通道状态：sessions[0] 为当前会话，其余按新→旧排列 */
export interface ChannelState {
  workspaceName: string;
  sessions: SessionMeta[];
  /** 通道级模型覆盖（/model 命令设置，跨重启持久；/new 不清除——它是通道偏好而非会话状态）。
   *  缺省/undefined = 跟随 ~/.claude/settings.json 的 model */
  model?: string;
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

/**
 * 一次性迁移：旧单应用的 sessions.json → sessions.<appId>.json。
 * 归一化保证旧 feishu 应用恒为 apps[0]，与「旧数据属于原单应用」语义吻合；
 * channelKey 格式未变，纯文件改名即完成迁移（历史会话立即可 /resume）。
 * - 旧文件不存在 → 'noop'
 * - 旧文件存在且目标分片不存在 → 改名 → 'migrated'
 * - 两者都存在 → 旧文件改名 .bak 保全（不覆盖新分片）；.bak 已存在则完全不动 → 'conflict-kept'
 * 只应在 startBridge 装配前调用一次（单进程无竞态）。
 */
export function migrateLegacySessions(configDir: string, firstAppId: string): 'noop' | 'migrated' | 'conflict-kept' {
  const legacyPath = join(configDir, 'sessions.json');
  if (!existsSync(legacyPath)) return 'noop';
  const shardedPath = join(configDir, `sessions.${firstAppId}.json`);
  if (!existsSync(shardedPath)) {
    renameSync(legacyPath, shardedPath);
    return 'migrated';
  }
  const bakPath = join(configDir, 'sessions.json.bak');
  if (!existsSync(bakPath)) {
    renameSync(legacyPath, bakPath);
    console.warn(`[迁移] sessions.json 与 sessions.${firstAppId}.json 并存，旧文件已保全为 sessions.json.bak（请人工确认归属）`);
  } else {
    console.warn('[迁移] sessions.json / 分片文件 / .bak 三者并存，保持原状不动（请人工处理）');
  }
  return 'conflict-kept';
}
