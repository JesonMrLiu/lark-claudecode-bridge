// lcb setup 引导式配置向导
// 交互层（readline 问答）与序列化层（answersToConfig / toYamlDocument）分离：
// 序列化层是纯函数，tests/cli.test.ts 直接单测；交互层留给手动冒烟
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'yaml';
import type { BridgeConfig } from '../types.js';

/** 向导收集到的原始答案 */
export interface SetupAnswers {
  appId: string;
  appSecret: string;
  workspaces: Array<{ name: string; path: string }>;
  defaultWorkspace: string;
}

/** App ID 形状（Task 6 遗留建议：不符仅警告，不阻止） */
export const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/;

/**
 * 答案 → 运行时配置对象。
 * 默认工作区名不在列表时回退到第一个工作区（防手滑回车写出非法默认值）。
 */
export function answersToConfig(a: SetupAnswers): BridgeConfig {
  const first = a.workspaces[0]?.name ?? '';
  const ws = a.defaultWorkspace || first;
  return {
    feishu: { appId: a.appId, appSecret: a.appSecret },
    workspaces: a.workspaces,
    defaults: { workspace: a.workspaces.some((w) => w.name === ws) ? ws : first },
    concurrency: 3,
  };
}

/**
 * 配置 → 可写盘的 YAML 文档。
 * ⚠️ 键名必须用 snake_case（feishu.app_id / app_secret）——loadConfig 按此形状解析，
 * 直接 stringify(camelCase 的 BridgeConfig) 会写出 loadConfig 读不回的配置。
 */
export function toYamlDocument(cfg: BridgeConfig): Record<string, unknown> {
  return {
    feishu: {
      app_id: cfg.feishu.appId,
      app_secret: cfg.feishu.appSecret,
      ...(cfg.feishu.domain === 'lark' ? { domain: 'lark' } : {}),
    },
    workspaces: cfg.workspaces,
    defaults: { workspace: cfg.defaults.workspace },
    concurrency: cfg.concurrency,
  };
}

/**
 * 逐行问答器。
 * 不用 readline/promises 的 rl.question 链：管道输入下所有行可能同 tick 送达，
 * 连续 await question() 会丢行挂起；改为持久 line 监听 + 行队列，TTY 与管道两用。
 * EOF（管道读完 / Ctrl+D）时未决问题以空串放行——语义等同「直接回车取默认值」，
 * 向导流程保证能走完，不会挂出 unsettled promise。
 */
function asker(input: NodeJS.ReadableStream & { isTTY?: boolean }, output: NodeJS.WritableStream) {
  const rl = createInterface({ input, output });
  const lines: string[] = [];
  const waiters: Array<(v: string) => void> = [];
  let eof = false;
  rl.on('line', (l: string) => {
    const w = waiters.shift();
    if (w) w(l);
    else lines.push(l);
  });
  rl.on('close', () => {
    eof = true;
    while (waiters.length) waiters.shift()!('');
  });
  return {
    async ask(q: string, def?: string): Promise<string> {
      output.write(def ? `${q}（回车默认 ${def}）：` : `${q}：`);
      const a = await new Promise<string>((resolve) => {
        const first = lines.shift();
        if (first !== undefined || eof) resolve(first ?? '');
        else waiters.push(resolve);
      });
      if (!input.isTTY) output.write(`${a}\n`); // 管道模式回显答案（TTY 下终端已自行回显）
      return a.trim() || def || '';
    },
    close: () => { rl.close(); },
  };
}

export async function runSetup(configPath: string): Promise<void> {
  const { ask, close } = asker(process.stdin, process.stdout);
  console.log('🛠 lcb setup — 引导式配置\n');
  if (existsSync(configPath)) {
    const overwrite = await ask(`配置已存在 ${configPath}，覆盖？(y/N)`, 'n');
    if (overwrite.toLowerCase() !== 'y') {
      close();
      console.log('已取消');
      return;
    }
  }
  console.log('\n请先在飞书开放平台完成（详见 README）：\n'
    + '  1. 创建企业自建应用并添加机器人能力\n'
    + '  2. 开通权限 im:message / im:message:send_as_bot / im:resource / contact:user.base:readonly\n'
    + '  3. 事件订阅选「长连接」，添加 im.message.receive_v1\n'
    + '  4. 卡片交互配置选「长连接」\n');
  const appId = await ask('App ID (cli_ 开头，形如 cli_aabbccddeeff0011)');
  const appSecret = await ask('App Secret');
  // 空值（EOF 截断/直接回车）不警告——后续 workspaces 校验会让流程退出，此处无需噪声
  if (appId && !APP_ID_RE.test(appId)) console.warn(`⚠️ App ID ${appId} 不符合常见形状 cli_ + 16 位十六进制，请确认（不阻止继续）`);
  const workspaces: Array<{ name: string; path: string }> = [];
  let defaultWorkspace = '';
  for (let i = 0; ; i++) {
    const name = await ask(i === 0 ? '第一个工作区名字（如 demo）' : '再添一个工作区名字（直接回车结束）');
    if (!name) break;
    const path = await ask(`工作区 ${name} 的本机路径`);
    workspaces.push({ name, path });
    if (!defaultWorkspace) defaultWorkspace = name;
  }
  if (workspaces.length === 0) {
    console.log('至少需要一个工作区，已退出');
    close();
    return;
  }
  const pick = await ask('默认工作区', defaultWorkspace);
  defaultWorkspace = workspaces.some((w) => w.name === pick) ? pick : defaultWorkspace;
  const cfg = answersToConfig({ appId, appSecret, workspaces, defaultWorkspace });
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringify(toYamlDocument(cfg)), 'utf8');
  close();
  console.log(`\n✅ 配置已写入 ${configPath}\n下一步：lcb start 启动`);
}
