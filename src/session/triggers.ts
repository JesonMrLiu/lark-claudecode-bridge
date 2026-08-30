// 触发词映射：把用户消息改写为显式调用技能/插件的指令。
// 优先级链：本地命令（BRIDGE_LOCAL_COMMANDS）→ 触发词改写 → 斜杠原文透传 SDK → 普通文本任务。
// 通常无须配置触发词：未命中时 /xxx 消息会原文透传给 Claude Code 自动展开斜杠命令，
// 触发词用于需要改写参数/附加指令的场景。
import type { TriggerRule } from '../types.js';
import { BRIDGE_LOCAL_COMMANDS } from './commands.js';

// bridge 本地命令首 token（去 / 后比对）：触发词不得劫持本地命令——/stop 永远是停止任务
const RESERVED_COMMANDS = new Set<string>(BRIDGE_LOCAL_COMMANDS);

function applyRewrite(template: string, text: string, args: string): string {
  return template.replaceAll('{text}', text).replaceAll('{args}', args);
}

/**
 * 命中触发词则返回改写后的 prompt，未命中返回 null（走原链路）。
 *
 * 匹配语义：
 * - 斜杠形态（match 以 / 开头）：消息首 token 精确相等才命中（/produce 命中，/produced 不命中）；
 *   本地命令（RESERVED）最高优先级直接放行；斜杠消息未命中任何规则也返回 null——
 *   由 handleCommand 的 default 分支原文透传给 Claude Code 派发斜杠命令。
 * - 关键词形态（match 不带 /）：整条消息包含该关键词即命中，按数组顺序首个生效。
 * 占位符：{text}=原始全文，{args}=去掉首 token 的剩余参数（斜杠形态）/ 全文（关键词形态）。
 */
export function rewriteByTrigger(text: string, rules: TriggerRule[] | undefined): string | null {
  const t = text.trim();
  if (!t || !rules?.length) return null;
  const firstToken = t.split(/\s+/)[0] ?? '';
  if (firstToken.startsWith('/')) {
    if (RESERVED_COMMANDS.has(firstToken.slice(1).toLowerCase())) return null;
    const rule = rules.find((r) => r.match.startsWith('/') && r.match === firstToken);
    if (!rule) return null;
    return applyRewrite(rule.rewrite, t, t.slice(firstToken.length).trim());
  }
  const rule = rules.find((r) => !r.match.startsWith('/') && t.includes(r.match));
  if (!rule) return null;
  return applyRewrite(rule.rewrite, t, t);
}
