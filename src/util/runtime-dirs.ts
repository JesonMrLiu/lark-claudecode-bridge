// 运行时目录初始化：lcb 任意入口（start/ui/setup/pair/ws/app）与 Web 配置页启动前
// 先把 ~/.lark-claudecode-bridge 及标准子目录建好（幂等），保证「首次安装先配置」的
// 一切写盘（config.yaml.tmp / access.json / 日志 / 落盘等）不因目录缺失 ENOENT。
// 注意：config.yaml 不在此创建——首装 bootstrap 向导依赖「文件不存在」判定 firstRun
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config.js';

/** 标准子目录：
 *   logs 按天日志 / transcripts 对话落盘 / claude 自管目录 / claude/plans 计划文件 /
 *   mcp 配置页管理的 MCP servers.json / notify SOP 硬兜底强制转 send_file 的中间产物（changes-YYYYMMDD-HHMMSS.md）*/
export function ensureRuntimeDirs(): void {
  for (const dir of [
    CONFIG_DIR,
    join(CONFIG_DIR, 'logs'),
    join(CONFIG_DIR, 'transcripts'),
    join(CONFIG_DIR, 'claude'),
    join(CONFIG_DIR, 'claude', 'plans'),
    join(CONFIG_DIR, 'mcp'),
    join(CONFIG_DIR, 'notify'),
  ]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch { /* 已存在 / 极端权限异常：不阻断启动，具体写盘点各自兜底 */ }
  }
}
