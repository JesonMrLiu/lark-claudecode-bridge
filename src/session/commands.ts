import type { BridgeConfig } from '../types.js';
import type { SessionStore } from './session-store.js';

export interface CommandContext {
  channelKey: string;
  store: SessionStore;
  config: BridgeConfig;
  /** 本机器人显示名：多机器人同群/多会话时 /status 需要辨认对谁说话 */
  appName: string;
  /** member 不能 /ws use 切换工作区（spec 权限分级） */
  isAdmin: boolean;
  currentWorkspace(): string;
  stopCurrentTask(): boolean;
}

export interface CommandResult {
  handled: boolean;
  reply?: string;
  taskText?: string;
}

const HELP = `**可用命令**
/new — 开启新会话
/resume — 列出历史会话
/resume <编号> — 恢复指定会话
/stop — 停止当前任务
/status — 查看当前状态
/ws list — 列出工作区
/ws use <名字> — 切换工作区
/help — 帮助`;

/**
 * 斜杠命令处理。非 / 开头的文本返回 { handled: false, taskText } 交给任务链路。
 * 会话编号约定：列表按时间正序展示（1 = 最早归档）；
 * 内部存储为新→旧（sessions[0] 为当前），故编号 n 对应内部下标 length - n。
 */
export async function handleCommand(text: string, ctx: CommandContext): Promise<CommandResult> {
  if (!text.startsWith('/')) return { handled: false, taskText: text };
  const [name, ...args] = text.slice(1).trim().split(/\s+/);
  const { store, channelKey: key } = ctx;
  switch (name) {
    case 'help':
      return { handled: true, reply: HELP };
    case 'new': {
      const ws = ctx.currentWorkspace();
      const st = store.getChannelState(key);
      // 显式清空历史（保留工作区归属），会话指针重置为空
      store.setChannelState(key, { workspaceName: st?.workspaceName ?? ws, sessions: [] });
      return { handled: true, reply: `✅ 已开启新会话（工作区：${ws}）` };
    }
    case 'resume': {
      const sessions = store.listSessions(key);
      if (args.length === 0) {
        if (sessions.length === 0) return { handled: true, reply: '暂无历史会话' };
        // 按时间正序展示：最早的排最前
        const chrono = [...sessions].reverse();
        const list = chrono
          .map((s, i) => `${i + 1}. ${s.summary || '(无摘要)'} <font color='grey'>${s.updatedAt.slice(0, 16)}</font>`)
          .join('\n');
        return { handled: true, reply: `**历史会话**（回复 /resume 编号 恢复）\n${list}` };
      }
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < 1 || n > sessions.length) {
        return { handled: true, reply: `编号无效，范围 1-${sessions.length}` };
      }
      const target = sessions[sessions.length - n]; // 编号 n → 时间正序第 n 个
      const st = store.getChannelState(key);
      if (st) {
        // 恢复 = 将选中会话移到头部（当前）
        st.sessions = [target, ...st.sessions.filter((s) => s.sessionId !== target.sessionId)];
        store.setChannelState(key, st);
      }
      return { handled: true, reply: `↩️ 已恢复会话：${target.summary || target.sessionId}` };
    }
    case 'stop':
      return { handled: true, reply: ctx.stopCurrentTask() ? '🛑 已发送停止信号' : '当前没有运行中的任务' };
    case 'status': {
      const st = store.getChannelState(key);
      return {
        handled: true,
        reply: `机器人：**${ctx.appName}**\n工作区：**${st?.workspaceName ?? ctx.currentWorkspace()}**\n历史会话：${store.listSessions(key).length} 个`,
      };
    }
    case 'ws': {
      const sub = args[0];
      if (sub === 'list') {
        const list = ctx.config.workspaces.map((w) => `- **${w.name}** \`${w.path}\``).join('\n');
        return { handled: true, reply: `**工作区列表**\n${list}` };
      }
      if (sub === 'use') {
        if (!ctx.isAdmin) return { handled: true, reply: '⛔ 切换工作区仅管理员可用' };
        const target = ctx.config.workspaces.find((w) => w.name === args[1]);
        if (!target) return { handled: true, reply: `工作区 "${args[1] ?? ''}" 不存在，/ws list 查看` };
        const st = store.getChannelState(key);
        // 切换工作区保留历史会话记录
        store.setChannelState(key, { workspaceName: target.name, sessions: st?.sessions ?? [] });
        return { handled: true, reply: `✅ 已切换工作区：**${target.name}**（${target.path}）` };
      }
      return { handled: true, reply: '用法：/ws list | /ws use <名字>' };
    }
    default:
      return { handled: true, reply: `未知命令 /${name}，/help 查看帮助` };
  }
}
