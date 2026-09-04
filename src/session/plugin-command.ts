// /plugin 飞书端插件管理命令：spawn SDK bundled CLI（plugin-manager）执行安装/启停/市场操作。
// 权限分级：list 对所有成员开放；变更类（install/uninstall/enable/disable/marketplace）仅 admin。
// 长操作（安装含 git clone）立即 ack、完成后经 deps.send 异步推送结果——不阻塞 gateway 事件链。
// managed 模式双目录：list 合并自管目录 + 本机 ~/.claude；变更操作按插件所在目录定向执行，
// install 默认装 ~/.claude（与本机 claude CLI 共用一份），--dir=managed 装 bridge 自管目录
import { runPluginCli } from '../executor/plugin-manager.js';
import { invalidatePluginCache, listInstalledPlugins } from '../executor/plugin-discovery.js';

export interface PluginCommandDeps {
  isAdmin: boolean;
  /** bridge 解析的当前生效配置目录（managed=自管目录；inherit=~/.claude） */
  claudeConfigDir: string;
  /** 本机 ~/.claude（managed 模式下作为第二来源与默认安装目标；缺省 = 与 claudeConfigDir 相同） */
  userClaudeDir?: string;
  /** 异步结果推送通道（wiring 注入 gateway.sendTextTo） */
  send: (markdown: string) => Promise<void>;
}

const USAGE = [
  '**插件管理**（仅管理员可变更）',
  '/plugin list — 已安装插件清单（managed 模式含本机 ~/.claude）',
  '/plugin install <name[@marketplace]> [--dir=managed] — 安装插件（默认装本机 ~/.claude）',
  '/plugin uninstall <name> — 卸载插件',
  '/plugin enable|disable <name> — 启用/停用插件',
  '/plugin marketplace add <git地址|路径> — 添加插件市场',
  '/plugin marketplace list — 查看插件市场',
  '/plugin marketplace update [name] — 更新插件市场',
  '/plugin marketplace remove <name> — 移除插件市场',
  '',
  '💡 插件装好后下一条消息自动加载（无须重启，两处目录的插件都会加载）；/plugins 查看当前会话实际加载的插件',
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
  const bridgeDir = deps.claudeConfigDir;
  const userDir = deps.userClaudeDir && deps.userClaudeDir !== deps.claudeConfigDir
    ? deps.userClaudeDir
    : deps.claudeConfigDir;
  const dual = bridgeDir !== userDir; // managed 模式：变更类需按插件所在目录定向
  const invalidateAll = () => { invalidatePluginCache(bridgeDir); if (dual) invalidatePluginCache(userDir); };
  // --dir=managed：install/marketplace 的目标目录选择（装自管目录；缺省装 ~/.claude）
  const wantManagedDir = rest.some((s) => s === '--dir=managed' || s === '--dir=bridge');
  const target = rest.filter((s) => s && !s.startsWith('-') && !s.startsWith('--dir='));
  const installDir = wantManagedDir ? bridgeDir : userDir;

  if (sub === 'list') {
    const rows = pluginListRows(bridgeDir, dual ? userDir : null);
    return rows
      ? `**已安装插件**${dual ? '（[bridge]=托管目录 [user]=本机 ~/.claude）' : ''}\n\`\`\`\n${rows}\n\`\`\``
      : '尚无已安装插件（/plugin install <name[@marketplace]> 安装）';
  }
  if (sub === 'marketplace' && target[0] === 'list') {
    // 市场清单仍走 CLI（repo 缓存目录结构复杂，本地解析收益低）；dual 时提示两处各自的市场
    const r = await runPluginCli(['marketplace', 'list'], { claudeConfigDir: installDir });
    if (!r.ok) return `查询失败：${r.text}`;
    const head = dual ? `（目标目录：${installDir === bridgeDir ? 'bridge 托管' : '本机 ~/.claude'}，--dir=managed 可切换）\n` : '';
    return `**插件市场**${head ? `\n${head}` : ''}\n\`\`\`\n${r.text}\n\`\`\``;
  }
  const requiresTarget = sub !== 'marketplace' || target[0] !== 'list';
  const name = target.join(' ');
  if (requiresTarget && !name) return `参数缺失：/plugin ${args.join(' ')} <…>。\n\n${USAGE}`;

  // 目标目录解析：enable/disable/uninstall 按插件实际所在目录执行（两处都有则都执行）；
  // install/marketplace 用 installDir（--dir=managed 或缺省 ~/.claude）
  const cliArgs = [sub, ...target]; // target 已剔除 --dir* 标志；runPluginCli 自行补 plugin 前缀与 -y
  const dirs = (sub === 'install' || sub === 'marketplace')
    ? [installDir]
    : locatePluginDirs(name, bridgeDir, dual ? userDir : null);
  const label = args.join(' ');
  void (async () => {
    const results: string[] = [];
    for (const dir of dirs) {
      const r = await runPluginCli(cliArgs, { claudeConfigDir: dir });
      results.push(r.ok
        ? `✅ ${dual ? `[${dir === bridgeDir ? 'bridge' : 'user'}] ` : ''}完成：\`\`\`\n${r.text}\n\`\`\``
        : `❌ ${dual ? `[${dir === bridgeDir ? 'bridge' : 'user'}] ` : ''}失败：${r.text}`);
    }
    invalidateAll();
    await deps.send((results.length ? results.join('\n') : '❌ 未找到该插件（两处目录均无安装记录）')
      + '\n下一条消息起自动加载；/plugins 可查看实际加载清单');
  })().catch((e) => deps.send(`❌ 插件操作异常（\`/plugin ${label}\`）：${e instanceof Error ? e.message : String(e)}`));
  return `⏳ 正在执行 \`/plugin ${label}\`（可能需要拉取仓库，稍候推送结果）`;
}

/** 合并渲染两处目录的已装插件清单；无任何插件返回 null。sourceTag 仅 dual 模式使用 */
function pluginListRows(bridgeDir: string, userDir: string | null): string | null {
  const fmt = (list: ReturnType<typeof listInstalledPlugins>) => list.map((p) =>
    `${p.enabled ? '✅' : '⬜'} ${p.key}${p.version ? `  v${p.version}` : ''}${p.enabled ? '' : '  （未启用）'}`);
  const bridgeList = listInstalledPlugins(bridgeDir);
  if (!userDir) {
    const rows = fmt(bridgeList);
    return rows.length ? rows.join('\n') : null;
  }
  const rows = [
    ...bridgeList.map((p) => `[bridge] ${fmt([p])[0]}`),
    ...listInstalledPlugins(userDir).map((p) => `[user]   ${fmt([p])[0]}`),
  ];
  return rows.length ? rows.join('\n') : null;
}

/** 按插件名（name 或 name@marketplace）定位所在目录；两处都装了则返回两处（都执行） */
function locatePluginDirs(name: string, bridgeDir: string, userDir: string | null): string[] {
  const inDir = (dir: string): boolean => listInstalledPlugins(dir).some(
    (p) => p.key === name || p.name === name,
  );
  const dirs: string[] = [];
  if (inDir(bridgeDir)) dirs.push(bridgeDir);
  if (userDir && inDir(userDir)) dirs.push(userDir);
  return dirs;
}
