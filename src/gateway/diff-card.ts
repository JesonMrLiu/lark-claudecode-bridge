// 汇总 diff 收尾卡片：code-dev 工作区任务完成后替代整文件上传——只发「改了什么」，
// 多文件 diff 合并展示，超长按块拆多张卡（复用 chunkText 贪心分块）
import { chunkText } from '../util/chunk-text.js';

export interface DiffSummaryMeta { workspaceName: string; files: number }

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
 * 生成汇总 diff 卡片组：
 * - 首卡标题含文件数与 +X/-Y 统计
 * - diff 正文按 ~2800 字分块，每块包在 ```diff 围栏里（飞书 markdown 渲染红绿着色）
 * - diff 为空（无改动）返回 []，调用方跳过发送
 */
export function buildDiffSummaryCards(diffText: string, meta: DiffSummaryMeta): unknown[] {
  const src = diffText.trim();
  if (!src) return [];
  const { additions, deletions } = diffStats(src);
  const title = `**📊 改动汇总**　工作区: \`${meta.workspaceName}\`\n\n${meta.files} 个文件　**+${additions} / -${deletions}** 行\n`;
  const chunks = chunkText(src, DIFF_CHUNK_MAX_CHARS);
  return chunks.map((chunk, i) => {
    const counter = chunks.length > 1 ? `（${i + 1}/${chunks.length}）` : '';
    const content = i === 0 ? `${title}\`\`\`diff\n${chunk}\n\`\`\`` : `**📊 改动汇总${counter}**\n\n\`\`\`diff\n${chunk}\n\`\`\``;
    return { schema: '2.0', config: { update_multi: true }, body: { elements: [{ tag: 'markdown', content }] } };
  });
}
