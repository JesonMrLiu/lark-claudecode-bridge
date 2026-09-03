// /plugin 飞书端插件管理命令：spawn SDK bundled CLI（plugin-manager）执行安装/启停/市场操作。
// 权限分级：list 对所有成员开放；变更类（install/uninstall/enable/disable/marketplace）仅 admin。
// 长操作（安装含 git clone）立即 ack、完成后经 deps.send 异步推送结果——不阻塞 gateway 事件链
import { runPluginCli } from '../executor/plugin-manager.js';
import { invalidatePluginCache } from '../executor/plugin-discovery.js';

export interface PluginCommandDeps {
  isAdmin: boolean;
  /** 插件安装目标目录（= bridge 解析的 CLAUDE_CONFIG_DIR，managed 模式与 ~/.claude 隔离） */
  claudeConfigDir: string;
  /** 异步结果推送通道（wiring 注入 gateway.sendTextTo） */
  send: (markdown: string) => Promise<void>;
}

const USAGE = [
  '**插件管理**（仅管理员可变更）',
  '/plugin list — 已安装插件清单',
  '/plugin install <name[@marketplace]> — 安装插件',
  '/plugin uninstall <name> — 卸载插件',
  '/plugin enable|disable <name> — 启用/停用插件',
  '/plugin marketplace add <git地址|路径> — 添加插件市场',
  '/plugin marketplace list — 查看插件市场',
  '/plugin marketplace update [name] — 更新插件市场',
  '/plugin marketplace remove <name> — 移除插件市场',
  '',
  '💡 插件装好后下一条消息自动加载（无须重启）；/plugins 查看当前会话实际加载的插件',
].join('\n');

/** 变更类子命令（admin only）；list 与用法提示对全部成员开放 */
const ADMIN_SUBS = new Set(['install', 'uninstall', 'enable', 'disable', 'marketplace']);

/**
 * 处理 /plugin 子命令，返回立即回复文本。install/uninstall/marketplace 为长操作：
 * 先回 ack，后台执行完毕（成功/失败/超时）经 deps.send 推送结果。
 */
export async function handlePluginCommand(args: string[], deps: PluginCommandDeps): Promise<string> {
  const [sub, ...rest] = args;
  if (!sub) return USAGE;
  if (sub === 'help') return USAGE;
  if (ADMIN_SUBS.has(sub) && !deps.isAdmin) {
    return '⛔ 插件变更操作仅管理员可用（查看清单可用 /plugin list）';
  }
  const run = (cliArgs: string[]) => runPluginCli(cliArgs, { claudeConfigDir: deps.claudeConfigDir });
  // 执行成功后清插件发现缓存：下次任务重新读 installed_plugins.json / enabledPlugins
  const runAndInvalidate = async (cliArgs: string[]) => {
    const r = await run(cliArgs);
    invalidatePluginCache(deps.claudeConfigDir);
    return r;
  };
  if (sub === 'list') {
    const r = await run(['list']);
    return r.ok ? `**已安装插件**\n\`\`\`\n${r.text}\n\`\`\`` : `查询失败：${r.text}`;
  }
  if (sub === 'marketplace' && rest[0] === 'list') {
    // 查询类同步返回（同 list）；marketplace 其余子命令为长操作
    const r = await run(['marketplace', 'list']);
    return r.ok ? `**插件市场**\n\`\`\`\n${r.text}\n\`\`\`` : `查询失败：${r.text}`;
  }
  const target = rest.filter((s) => s && !s.startsWith('-')).join(' ');
  const requiresTarget = sub !== 'marketplace' || rest[0] !== 'list';
  if (requiresTarget && !target) return `参数缺失：/plugin ${args.join(' ')} <…>。\n\n${USAGE}`;
  // 长操作 fire-and-forget：立即 ack，结果异步推送（不阻塞 gateway 事件分发链）
  const label = args.join(' ');
  void runAndInvalidate(args).then((r) => {
    return deps.send(r.ok
      ? `✅ 插件操作完成（\`/plugin ${label}\`）\n\`\`\`\n${r.text}\n\`\`\`\n下一条消息起自动加载；/plugins 可查看实际加载清单`
      : `❌ 插件操作失败（\`/plugin ${label}\`）：${r.text}`);
  }).catch((e) => deps.send(`❌ 插件操作异常（\`/plugin ${label}\`）：${e instanceof Error ? e.message : String(e)}`));
  return `⏳ 正在执行 \`/plugin ${label}\`（可能需要拉取仓库，稍候推送结果）`;
}
