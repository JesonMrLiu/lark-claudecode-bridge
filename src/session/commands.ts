import type { BridgeConfig, SessionInventory } from '../types.js';
import type { SessionStore } from './session-store.js';
import { formatBeijingTime } from '../util/beijing-time.js';

/**
 * bridge 本地命令首 token 清单（去 / 后比对）。单一来源：commands.ts 的 switch、
 * triggers.ts 的 RESERVED、index.ts 的透传说明均以此为准——本地命令永远优先，
 * 不被触发词劫持、不透传给 Claude Code。新增本地命令务必同步此清单
 */
export const BRIDGE_LOCAL_COMMANDS = ['help', 'new', 'resume', 'stop', 'status', 'ws', 'model', 'skills', 'plugins', 'mcp'] as const;

/**
 * 内置命令的飞书 Slash Command 注册元信息（icon 为飞书 icon_key，见开放平台文档可选列表）。
 * 斜杠命令同步（feishu/slash-commands）的默认期望集 = 本表的全部键 + config.slash_commands.extra。
 * 新增本地命令须同步：BRIDGE_LOCAL_COMMANDS、handleCommand case、HELP 文案、本表（测试断言清单⊆本表）。
 */
export const SLASH_COMMAND_META: Record<string, { description: string; icon: string }> = {
  help: { description: '查看全部命令', icon: 'slash-ai_outlined' },
  new: { description: '开启新会话', icon: 'add-chat-ai_outlined' },
  resume: { description: '列出/恢复历史会话', icon: 'update-ai_outlined' },
  stop: { description: '停止当前任务', icon: 'clear_outlined' },
  status: { description: '查看当前状态', icon: 'diagnosis-ai_outlined' },
  ws: { description: '切换工作区（/ws list 列出）', icon: 'folder_outlined' },
  model: { description: '查看/切换模型', icon: 'ai-style_outlined' },
  skills: { description: '查看已加载技能', icon: 'skill_outlined' },
  plugins: { description: '查看已加载插件', icon: 'plugin_outlined' },
  mcp: { description: '查看已加载 MCP 服务', icon: 'ai-functions_outlined' },
};

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
  /** 本 app 当前工作区最近一次会话的加载清单（SDK init 消息缓存）；尚无会话时 undefined */
  getInventory(): SessionInventory | undefined;
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
/model — 查看/切换模型（/model <名字> 切换，/model reset 恢复默认）
/skills — 查看已加载技能
/plugins — 查看已加载插件
/mcp — 查看已加载 MCP 服务
/help — 帮助

💡 其它 / 开头的消息将原文透传给 Claude Code（可触发其技能与插件命令，如 /superpowers:brainstorming）`;

/** 清单类命令的空态提示（会话未初始化 → init 消息未到 → 无缓存） */
const NO_INVENTORY_REPLY = '暂无加载清单——Claude Code 会话尚未初始化。\n先发一条任务消息（任意内容，如「你好」），完成后再查看。';

/** 清单超过 30 项时截断展示 */
function tail(items: string[]): string {
  return items.length > 30 ? `${items.slice(0, 30).join('、')} …等 ${items.length} 个` : items.join('、');
}

/** 清单类回复共用的头部（工作区 + 加载时间） */
function inventoryHeader(inv: SessionInventory): string {
  return `<font color='grey'>工作区 ${inv.workspace} · ${formatBeijingTime(inv.loadedAt)} 加载</font>`;
}

/**
 * 斜杠命令处理。非 / 开头的文本返回 { handled: false, taskText } 交给任务链路；
 * 本地命令之外的 / 开头消息也返回 { handled: false, taskText } 原文透传——
 * SDK 会话可直接派发 prompt 里的斜杠命令（user skills / 插件命令等），
 * Claude Code 侧不存在的命令会在任务结果里回报错误，比 bridge 拦截信息量更大。
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
      // 显式清空历史（保留工作区归属与通道级模型偏好），会话指针重置为空
      store.setChannelState(key, { workspaceName: st?.workspaceName ?? ws, sessions: [], ...(st?.model ? { model: st.model } : {}) });
      return { handled: true, reply: `✅ 已开启新会话（工作区：${ws}）` };
    }
    case 'resume': {
      const sessions = store.listSessions(key);
      if (args.length === 0) {
        if (sessions.length === 0) return { handled: true, reply: '暂无历史会话' };
        // 按时间正序展示：最早的排最前
        const chrono = [...sessions].reverse();
        const list = chrono
          .map((s, i) => `${i + 1}. ${s.summary || '(无摘要)'} <font color='grey'>${formatBeijingTime(s.updatedAt)}</font>`)
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
        reply: `机器人：**${ctx.appName}**\n工作区：**${st?.workspaceName ?? ctx.currentWorkspace()}**\n模型：**${st?.model ?? '跟随全局'}**\n历史会话：${store.listSessions(key).length} 个`,
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
        // 切换工作区保留历史会话记录与通道级模型偏好
        store.setChannelState(key, {
          workspaceName: target.name,
          sessions: st?.sessions ?? [],
          ...(st?.model ? { model: st.model } : {}),
        });
        return { handled: true, reply: `✅ 已切换工作区：**${target.name}**（${target.path}）` };
      }
      return { handled: true, reply: '用法：/ws list | /ws use <名字>' };
    }
    case 'model': {
      const st = store.getChannelState(key);
      const arg = args.join(' ').trim();
      if (!arg) {
        // 查看当前生效：通道覆盖 > 会话实测 > 跟随全局
        const inv = ctx.getInventory();
        const current = st?.model ?? inv?.model ?? '跟随全局';
        const source = st?.model ? '通道覆盖' : inv ? '会话实测' : '未初始化';
        return {
          handled: true,
          reply: `**模型设置**\n当前生效：**${current}**（来源：${source}）`
            + `\n${st?.model ? '本通道已设置覆盖；' : '未设置通道覆盖时跟随 ~/.claude/settings.json；'}`
            + `\n切换：/model <名字>（如 /model opus）；恢复默认：/model reset。下一条消息起生效，仅影响本通道`,
        };
      }
      if (arg === 'reset' || arg === 'default') {
        if (st) {
          const { model: _drop, ...rest } = st;
          store.setChannelState(key, rest);
        }
        return { handled: true, reply: '✅ 已恢复默认模型（跟随 ~/.claude/settings.json 全局配置）' };
      }
      if (st) {
        store.setChannelState(key, { ...st, model: arg });
      } else {
        store.setChannelState(key, { workspaceName: ctx.currentWorkspace(), sessions: [], model: arg });
      }
      return { handled: true, reply: `✅ 已切换模型：**${arg}**（下一条消息起生效；/model reset 恢复默认）` };
    }
    case 'skills': {
      const inv = ctx.getInventory();
      if (!inv) return { handled: true, reply: NO_INVENTORY_REPLY };
      return {
        handled: true,
        reply: `**已加载技能** ${inv.skills.length} 个 · ${inventoryHeader(inv)}\n${tail(inv.skills)}`
          + `\n\n💡 技能若带斜杠命令可直接发 \`/命令名\` 触发（透传给 Claude Code）`,
      };
    }
    case 'plugins': {
      const inv = ctx.getInventory();
      if (!inv) return { handled: true, reply: NO_INVENTORY_REPLY };
      const list = inv.plugins.map((p) => `- **${p.name}**${p.version ? `（${p.version}）` : ''}`).join('\n');
      return { handled: true, reply: `**已加载插件** ${inv.plugins.length} 个 · ${inventoryHeader(inv)}\n${list}` };
    }
    case 'mcp': {
      const inv = ctx.getInventory();
      if (!inv) return { handled: true, reply: NO_INVENTORY_REPLY };
      const list = inv.mcpServers.map((s) => {
        const ok = s.status === 'connected';
        return `- ${ok ? '✅' : '⚠️'} **${s.name}**（${s.status}）`;
      }).join('\n');
      return { handled: true, reply: `**MCP 服务** ${inv.mcpServers.length} 个 · ${inventoryHeader(inv)}\n${list}` };
    }
    default:
      // 非本地命令的斜杠消息原文透传给 Claude Code（SDK 直接派发斜杠命令）
      return { handled: false, taskText: text };
  }
}
