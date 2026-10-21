// 安全审计面（方案 v3 §八）：deny / 脱敏 / 金丝雀事件全量落 JSONL。
// 铁律：审计只记「发生了什么类别的安全事件 + 规则/模式标识 + 路径」，绝不记录命中内容本身
// （脱敏命中的原文就是秘密，落盘即二次泄露）。写失败只节流告警，绝不阻断主流程（与 transcripts 同款）。
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nowBeijingISO } from '../util/beijing-time.js';

/** 安全事件（discriminated union；detail 内字段均已脱敏） */
export type SecurityEvent =
  | { kind: 'redact'; ruleIds: string[]; source: 'card' | 'caption' | 'final' | 'stream' | 'transcript' }
  | { kind: 'canary'; source: 'card' | 'caption' | 'final' | 'stream' | 'gate' }
  | { kind: 'path-deny'; tool: string; path: string; ruleId?: string }
  | { kind: 'write-deny'; tool: string; path: string }
  | { kind: 'bash-deny'; command: string; ruleId?: string }
  | { kind: 'file-deny'; path: string };

/** 审计写入接口（DI：生产实现落盘，测试可注入内存 mock） */
export interface SecurityAuditWriter { write(appId: string, ev: SecurityEvent): void }

// 单文件上限：超过即轮转为 .old（保留一代，足够回溯近期事件且不无界增长）
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export class SecurityAudit implements SecurityAuditWriter {
  private madeDir = false;
  private lastWarnMin = 0;

  constructor(private baseDir: string) {}

  write(appId: string, ev: SecurityEvent): void {
    try {
      if (!this.madeDir) {
        mkdirSync(this.baseDir, { recursive: true });
        this.madeDir = true;
      }
      const file = join(this.baseDir, `audit-${appId}.jsonl`);
      // 尺寸轮转：写入前检查，超限即改名（存在 .old 直接覆盖，只保留一代）
      if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) {
        renameSync(file, `${file}.old`);
      }
      const line = JSON.stringify({ v: 1, ts: nowBeijingISO(), app: appId, ...ev }) + '\n';
      appendFileSync(file, line, 'utf8');
    } catch (e) {
      const min = Math.floor(Date.now() / 60_000);
      if (min !== this.lastWarnMin) {
        this.lastWarnMin = min;
        console.warn('[security] 审计落盘失败（不影响任务执行）：', e instanceof Error ? e.message : e);
      }
    }
  }
}

/** 安全拦截统一话术（R1/R2/R4 拒绝模板）：不解释保护对象、不确认目标是否存在——
 *  模型回复「没有权限」时这是真话（能力缺失，非服从），杜绝侧信道试探 */
export const DENY_REDLINE_MESSAGE = '没有权限访问该路径（安全红线，不可越界）。请改用已分配工作区内的文件继续任务';
export const DENY_WRITE_MESSAGE = '没有权限写入该位置（写入仅限已分配的工作区）';
export const DENY_BASH_MESSAGE = '没有权限使用命令行工具';

/** 金丝雀命中告警模板（gateway 与 gate 侧共用；文本不含任何敏感内容，自身出站无递归风险） */
export const CANARY_ALERT_TEXT =
  '🚨 安全告警：检测到敏感标记出现在对外消息中（疑似防线被穿透）。相关内容已脱敏，请立即检查本机是否存在泄密。本消息由安全模块自动发送';
