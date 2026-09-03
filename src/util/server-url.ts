// Web 配置页地址计算：auth-precheck 提示、CLI 启动打印、错误 hint 共用
import type { BridgeConfig } from '../types.js';

/** 配置页 URL（host/port 回退默认值）；server.enabled=false 时返回 null（无页面可指） */
export function serverUrl(config: BridgeConfig): string | null {
  const s = config.server;
  if (s?.enabled === false) return null;
  const host = s?.host ?? '127.0.0.1';
  const port = s?.port ?? 17317;
  return `http://${host}:${port}`;
}
