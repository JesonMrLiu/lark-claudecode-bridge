// 「运行终端输入配对码」的行处理逻辑（lcb start 的 stdin 监听用）
import { join } from 'node:path';
import { AccessControl } from '../access/access-control.js';
import { CONFIG_DIR } from '../config.js';

/**
 * 处理 stdin 的一行输入：6 位数字按配对码现读现批，其余静默忽略。
 * ⚠️ 必须每次现 `AccessControl.load()`：桥运行中用户触发 beginPairing 写入的新 pending
 * 不在启动快照里——复用启动实例必然「配对码无效」，且其 save() 整盘覆写会抹掉桥内
 * 新增的 pending。与独立进程的 `lcb pair` 走同一条现读路径（已验证安全）。
 */
export function approvePairingLine(line: string, storePath: string = join(CONFIG_DIR, 'access.json')): void {
  const code = line.trim();
  if (!/^\d{6}$/.test(code)) return;
  const access = AccessControl.load(storePath);
  const r = access.approvePairing(code);
  console.log(r.ok ? `✅ 已批准用户 ${r.userId}${r.isFirstAdmin ? '（admin）' : ''}` : `❌ ${r.error}`);
}
