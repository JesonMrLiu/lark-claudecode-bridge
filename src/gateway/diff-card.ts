// 单文件 diff 卡片：用户对收尾文件清单回复数字时，该文件的本次改动按卡展示——
// 超长按块拆多张卡（复用 chunkText 贪心分块），全量卡片化不落盘
import { chunkText } from '../util/chunk-text.js';

/** 从 unified diff 文本统计改动规模：+/− 行数（排除 +++/--- 文件头） */
export function diffStats(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/** 单张卡片正文上限：留出标题/```diff 围栏/卡片包壳的 JSON 余量 */
const DIFF_CHUNK_MAX_CHARS = 2800;

/**
 * 生成单文件 diff 卡片组（widthMode 跟随 config.card.width）：
 * - 首卡标题含文件名与 +X/-Y 统计
 * - diff 正文按 ~2800 字分块，每块包在 ```diff 围栏里（飞书 markdown 渲染红绿着色）
 * - 不设总量上限：极长 diff 也全量多卡展示（用户决策，不再落盘发文件附件）
 * - diff 为空（无改动）返回 []，调用方跳过发送
 */
export function buildFileDiffCards(diffText: string, meta: { fileName: string }, widthMode: 'default' | 'fill' = 'default'): unknown[] {
  const src = diffText.trim();
  if (!src) return [];
  const { additions, deletions } = diffStats(src);
  const title = `**📊 改动详情**　\`${meta.fileName}\`　**+${additions} / -${deletions}** 行\n`;
  const chunks = chunkText(src, DIFF_CHUNK_MAX_CHARS);
  return chunks.map((chunk, i) => {
    const counter = chunks.length > 1 ? `（${i + 1}/${chunks.length}）` : '';
    const content = i === 0 ? `${title}\`\`\`diff\n${chunk}\n\`\`\`` : `**📊 改动详情${counter} · ${meta.fileName}**\n\n\`\`\`diff\n${chunk}\n\`\`\``;
    return {
      schema: '2.0',
      config: { update_multi: true, ...(widthMode === 'fill' ? { width_mode: 'fill' } : {}) },
      body: { elements: [{ tag: 'markdown', content }] },
    };
  });
}
