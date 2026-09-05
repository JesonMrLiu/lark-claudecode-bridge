import type { BridgeConfig, SessionInventory } from '../types.js';
import type { SessionStore } from './session-store.js';
import { formatBeijingTime } from '../util/beijing-time.js';
import { handlePluginCommand } from './plugin-command.js';
import { invalidatePluginCache } from '../executor/plugin-discovery.js';

/**
 * bridge 本地命令首 token 清单（去 / 后比对）。单一来源：commands.ts 的 switch、
 * triggers.ts 的 RESERVED、index.ts 的透传说明均以此为准——本地命令永远优先，
 * 不被触发词劫持、不透传给 Claude Code。新增本地命令务必同步此清单
 */
export const BRIDGE_LOCAL_COMMANDS = ['help', 'new', 'resume', 'stop', 'status', 'ws', 'model', 'skills', 'plugins', 'mcp', 'plugin', 'reload-plugins'] as const;

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
  plugin: { description: '插件管理：安装/启停/市场（管理员）', icon: 'plugin_outlined' },
  'reload-plugins': { description: '重载插件（清缓存，下条消息生效）', icon: 'restart_outlined' },
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
  /** Claude 配置目录（/plugin 安装目标）。wiring 注入；未注入时 /plugin 回复不可用 */
  claudeConfigDir?: string;
  /** 本机 ~/.claude（managed 模式下作为插件第二来源与默认安装目标） */
  userClaudeDir?: string;
  /** 异步消息通道：/plugin 长操作 ack 后异步推送结果。wiring 注入 gateway.sendTextTo */
  send?: (markdown: string) => Promise<void>;
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
/plugin — 插件管理（安装/启停/市场，管理员）
/reload-plugins — 重载插件（清缓存，下一条消息重新加载）
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
      // 仅清除「当前续接指针」，历史会话列表保留（/resume 仍可切回）——
      // 旧版清空整个 sessions 导致开新会话后历史「消失」，列表永远积累不起来
      store.setCurrentSession(key, null, st?.workspaceName ?? ws);
      return { handled: true, reply: `✅ 已开启新会话（工作区：${ws}）。历史会话未清空，/resume 可随时切回` };
    }
    case 'resume': {
      const sessions = store.listSessions(key);
      if (args.length === 0) {
        if (sessions.length === 0) return { handled: true, reply: '暂无历史会话' };
        // 按时间正序展示：最早的排最前；当前续接的会话打标（一眼看出下条消息会接到哪）
        const current = store.getChannelState(key)?.currentSessionId;
        const chrono = [...sessions].reverse();
        const list = chrono
          .map((s, i) => `${i + 1}. ${s.summary || '(无摘要)'} <font color='grey'>${formatBeijingTime(s.updatedAt)}</font>${s.sessionId === current ? ' ← 当前' : ''}`)
          .join('\n');
        return { handled: true, reply: `**历史会话**（回复 /resume 编号 恢复；/new 另起一支，历史保留）\n${list}` };
      }
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < 1 || n > sessions.length) {
        return { handled: true, reply: `编号无效，范围 1-${sessions.length}` };
      }
      const target = sessions[sessions.length - n]; // 编号 n → 时间正序第 n 个
      // 恢复 = 当前续接指针指向选中会话（列表顺序不动，历史保持时间序）
      store.setCurrentSession(key, target.sessionId);
      // 标注当前指针，方便 /resume 列表辨认正在续接哪条
      return { handled: true, reply: `↩️ 已恢复会话：${target.summary || target.sessionId}\n下一条任务将从该会话继续` };
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
        // 切换工作区保留历史会话记录与通道级模型偏好，但清除续接指针——
        // 旧会话的上下文绑定原工作区目录，跨工作区自动续接容易答非所问
        store.setChannelState(key, {
          workspaceName: target.name,
          sessions: st?.sessions ?? [],
          ...(st?.model ? { model: st.model } : {}),
        });
        store.setCurrentSession(key, null, target.name);
        return { handled: true, reply: `✅ 已切换工作区：**${target.name}**（${target.path}）。已自动开启新会话（/resume 可切回历史）` };
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
    case 'plugin': {
      // 飞书端插件管理（安装/启停/市场）：本地接管，不再透传给 Claude Code 会话
      if (!ctx.claudeConfigDir || !ctx.send) {
        return { handled: true, reply: '⛔ 插件管理在当前部署下不可用（缺少运行环境注入）' };
      }
      return { handled: true, reply: await handlePluginCommand(args, {
        isAdmin: ctx.isAdmin,
        claudeConfigDir: ctx.claudeConfigDir,
        userClaudeDir: ctx.userClaudeDir,
        send: ctx.send,
      }) };
    }
    case 'reload-plugins': {
      // 终端 /reload-plugins 的 bridge 等价物：插件由每任务启动时现扫描加载（mtime 缓存），
      // 清缓存即「重载」——下一条消息重新发现并传入 SDK（managed 模式双目录都清）
      const dirs = ctx.claudeConfigDir ? [ctx.claudeConfigDir, ...(ctx.userClaudeDir && ctx.userClaudeDir !== ctx.claudeConfigDir ? [ctx.userClaudeDir] : [])] : [];
      if (dirs.length === 0) return { handled: true, reply: '⛔ 当前部署未注入 Claude 配置目录，无法重载' };
      for (const d of dirs) invalidatePluginCache(d);
      return { handled: true, reply: '🔄 插件缓存已清，下一条消息起重新加载插件清单（等效终端 /reload-plugins；可用 /plugins 查看结果）' };
    }
    default: {
      // Claude Code 终端 REPL 专属命令：headless 会话里透传只会得到 CLI 的
      // "isn't available in this environment" 报错，不如本地直接给可操作的指引。
      // （/reload-plugins 已实现为本地命令：清插件缓存，见上方 case）
      const TERMINAL_ONLY: Record<string, string> = {
        'plugin-dev': '插件开发向导是 Claude Code 终端交互命令，机器人侧不可用。请在本地终端运行。',
        'vim': 'vim 模式是 Claude Code 终端按键绑定，机器人侧无意义。',
        'terminal-setup': '终端按键绑定安装是 Claude Code 终端命令，机器人侧无意义。',
        'bashes': '查看后台 shell 是 Claude Code 终端命令，机器人侧不可用。任务中的命令执行状态会实时显示在进度卡上。',
        'usage': '用量统计是 Claude Code 终端命令，机器人侧不可用。',
        'bug': '问题反馈是 Claude Code 终端命令，机器人侧不可用。',
      };
      if (name in TERMINAL_ONLY) return { handled: true, reply: `⛔ /${name}：${TERMINAL_ONLY[name]}` };
      // 非本地命令的斜杠消息原文透传给 Claude Code（SDK 直接派发斜杠命令）
      return { handled: false, taskText: text };
    }
  }
}
