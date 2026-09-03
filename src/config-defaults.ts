// 新建配置的默认段构建：lcb setup / Web 配置页 bootstrap / config.example 三处共用，
// 保证「预置写盘的默认值」与「未配置时的运行期内置默认」逐字一致（单源：permission-gate 常量）
import { DEFAULT_ALLOW_TOOLS_LIST, DEFAULT_DANGEROUS_COMMAND_SOURCES } from './executor/permission-gate.js';

/** permissions 段完整默认值（snake_case，直接可 stringify 写盘；页面可增删条目） */
export function defaultPermissionsDoc(): Record<string, unknown> {
  return {
    allow_tools: [...DEFAULT_ALLOW_TOOLS_LIST],
    dangerous_commands: [...DEFAULT_DANGEROUS_COMMAND_SOURCES],
  };
}

/** server 段默认值（Web 配置页随 lcb start 常驻，仅绑回环） */
export function defaultServerDoc(): Record<string, unknown> {
  return { enabled: true, host: '127.0.0.1', port: 17317 };
}
