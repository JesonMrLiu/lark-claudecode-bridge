// 超长文本分块（notify-server 与 gateway 卡片层共用）：按段落（\n\n+）贪心聚合，
// 单段超长退化为按行聚合，行本身仍超长硬切兜底。块边界只可能落在段落/行/字符处，
// 不打断 markdown 结构的概率最高。

// 飞书 interactive 卡片 JSON 上限约 30KB，3000 个 CJK 字符 UTF-8 约 9KB，留足卡片包壳余量
export const CHUNK_MAX_CHARS = 3000;

export function chunkText(text: string, maxChars = CHUNK_MAX_CHARS): string[] {
  const src = text.trim();
  if (!src) return [];
  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = '';
  };
  for (const para of src.split(/\n\n+/)) {
    if (para.length > maxChars) {
      // 超长段落：按行继续聚合（代码块/长表行常见此形态）
      for (const line of para.split('\n')) {
        if (line.length > maxChars) {
          // 行本身超长（无换行的超长串）：收尾当前块后按 maxChars 硬切
          flush();
          for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
        } else if (cur.length + line.length + 1 > maxChars) {
          flush();
          cur = line;
        } else {
          cur = cur ? `${cur}\n${line}` : line;
        }
      }
    } else if (cur.length + para.length + 2 > maxChars) {
      flush();
      cur = para;
    } else {
      cur = cur ? `${cur}\n\n${para}` : para;
    }
  }
  flush();
  return chunks;
}
