#!/usr/bin/env node
// lcb 命令行入口：setup / start / pair / app / ws / version
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { runSetup, APP_ID_RE } from '../cli/setup-wizard.js';
import { addWorkspace, removeWorkspace } from '../cli/ws-manager.js';
import { addApp, removeApp, listApps } from '../cli/app-manager.js';
import { asker } from '../cli/asker.js';
import { approvePairingLine } from '../cli/stdin-pairing.js';
import { startBridge } from '../index.js';
import { loadConfig, CONFIG_PATH, CONFIG_DIR } from '../config.js';
import { AccessControl } from '../access/access-control.js';
import { VERSION } from '../version.js';
import { join } from 'node:path';

function showPending(access: AccessControl): void {
  const pending = access.listPending();
  if (pending.length) console.log('待配对：', pending.map((p) => `${p.code}（${p.userId}）`).join('、'));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'setup':
      await runSetup(CONFIG_PATH);
      break;
    case 'start': {
      const config = loadConfig(CONFIG_PATH); // 启动前校验：文件缺失/字段非法立即报错退出
      // Task 6 遗留建议：App ID 形状不符仅打警告，不阻止启动（形状非强约束，避免误杀合法 ID）
      for (const app of config.apps) {
        if (!APP_ID_RE.test(app.appId)) {
          console.warn(`⚠️ 应用 ${app.name} 的 App ID "${app.appId}" 不符合常见形状 cli_ + 16 位十六进制，启动继续；若后续连接失败请先核对`);
        }
      }
      await startBridge(CONFIG_PATH);
      // 前台监听 stdin：管理员可直接在运行终端输入配对码批准。
      // 现读现批（每次 load 新实例再 approve）：桥运行中 beginPairing 写入的新 pending
      // 不在启动快照里——复用启动实例必然「配对码无效」，且其 save() 整盘覆写会
      // 抹掉桥内新 pending。与独立进程 lcb pair 走同一条现读路径
      const rl = createInterface({ input: process.stdin });
      rl.on('line', (line) => approvePairingLine(line, join(CONFIG_DIR, 'access.json')));
      break;
    }
    case 'pair': {
      const access = AccessControl.load(join(CONFIG_DIR, 'access.json'));
      const code = args[0];
      if (!/^\d{6}$/.test(code ?? '')) {
        console.log('用法：lcb pair <6位配对码>');
        showPending(access);
        process.exit(1);
      }
      const r = access.approvePairing(code);
      console.log(r.ok ? `✅ 已批准 ${r.userId}${r.isFirstAdmin ? '（admin）' : ''}` : `❌ ${r.error}`);
      if (!r.ok) process.exit(1);
      console.log('注：若桥接器正在运行，需重启或改在运行终端输入配对码');
      break;
    }
    case 'ws': {
      // 先整体校验再增量修改：带着非法配置做 add/remove 会把错误掩埋进写回结果
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig(CONFIG_PATH);
      } catch (e) {
        console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      const sub = args[0];
      if (sub === 'list') {
        console.log(config.workspaces
          .map((w) => `${w.name === config.defaults.workspace ? '*' : ' '} ${w.name}  ${w.path}`)
          .join('\n'));
        break;
      }
      const raw = readFileSync(CONFIG_PATH, 'utf8'); // 保留注释的增量改写基于原文，而非重序列化内存对象
      if (sub === 'add') {
        const [name, path] = args.slice(1);
        if (!name || !path) {
          console.log('用法：lcb ws add <名字> <路径>（路径需已存在，含空格需加引号）');
          process.exit(1);
        }
        const r = addWorkspace(raw, name, path);
        if (!r.ok) {
          console.error(`❌ ${r.error}`);
          process.exit(1);
        }
        writeFileSync(CONFIG_PATH, r.yaml, 'utf8');
        console.log(`✅ 已添加工作区 ${name}（${path}）`);
        console.log('桥接器若正在运行，下一条消息时自动生效，无需重启');
      } else if (sub === 'remove') {
        const name = args[1];
        if (!name) {
          console.log('用法：lcb ws remove <名字>');
          process.exit(1);
        }
        const r = removeWorkspace(raw, name);
        if (!r.ok) {
          console.error(`❌ ${r.error}`);
          process.exit(1);
        }
        writeFileSync(CONFIG_PATH, r.yaml, 'utf8');
        console.log(`✅ 已删除工作区 ${name}`);
      } else {
        console.log('用法：lcb ws add <名字> <路径> | lcb ws remove <名字> | lcb ws list');
      }
      break;
    }
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    case 'app': {
      const sub = args[0];
      const raw = readFileSync(CONFIG_PATH, 'utf8'); // 增量改写基于原文，保留注释
      if (sub === 'list') {
        const list = listApps(raw);
        if (!list.length) {
          console.log('暂无应用配置，请先运行 lcb setup');
          break;
        }
        console.log(list.map((a) => `- ${a.name}${a.name !== a.appId ? ` (${a.appId})` : ''}${a.domain === 'lark' ? ' [lark]' : ''}${a.defaultWorkspace ? ` 默认工作区:${a.defaultWorkspace}` : ''}`).join('\n'));
        break;
      }
      if (sub === 'add') {
        const { ask, close } = asker(process.stdin, process.stdout);
        const appId = await ask('App ID (cli_ 开头，形如 cli_aabbccddeeff0011)');
        if (!appId) {
          close();
          console.log('App ID 不能为空，已取消');
          break;
        }
        if (!APP_ID_RE.test(appId)) console.warn(`⚠️ App ID ${appId} 不符合常见形状 cli_ + 16 位十六进制，请确认（不阻止继续）`);
        const name = await ask('应用名字（显示用，如「素材收集」，回车默认取 App ID）');
        const appSecret = await ask('App Secret');
        close();
        if (!appSecret) {
          console.log('App Secret 不能为空，已取消');
          break;
        }
        const r = addApp(raw, { appId, appSecret, ...(name ? { name } : {}) });
        if (!r.ok) {
          console.error(`❌ ${r.error}`);
          process.exit(1);
        }
        writeFileSync(CONFIG_PATH, r.yaml, 'utf8');
        console.log(`✅ 已添加应用 ${name || appId}（重启桥接器后生效）`);
        break;
      }
      if (sub === 'remove') {
        const target = args[1];
        if (!target) {
          console.log('用法：lcb app remove <名字|app_id>');
          process.exit(1);
        }
        const r = removeApp(raw, target);
        if (!r.ok) {
          console.error(`❌ ${r.error}`);
          process.exit(1);
        }
        writeFileSync(CONFIG_PATH, r.yaml, 'utf8');
        console.log(`✅ 已删除应用 ${target}（重启桥接器后生效）`);
        console.log('注：该应用的会话分片（sessions.<appId>.json）与对话落盘（transcripts/<appId>/）保留未动，确认不再需要时可手工删除');
        break;
      }
      console.log('用法：lcb app list | lcb app add | lcb app remove <名字|app_id>');
      break;
    }
    default:
      console.log(`lcb — 飞书 ↔ Claude Code 桥接器 v${VERSION}

用法：
  lcb setup              引导式配置（支持多个机器人应用）
  lcb start              启动桥接器（前台，所有应用各建一条长连接）
  lcb pair <code>        批准配对码
  lcb app list           列出机器人应用
  lcb app add            添加机器人应用（重启后生效）
  lcb app remove <名>    删除机器人应用
  lcb ws add <名> <路径>  添加工作区（运行中热生效）
  lcb ws remove <名>     删除工作区
  lcb ws list            列出工作区（* 为默认）
  lcb version            版本`);
      break;
  }
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
