// 超长文本分块（notify-server 与 gateway 卡片层共用）：按段落（\n\n+）贪心聚合，
// 单段超长退化为按行聚合，行本身仍超长硬切兜底。块边界只可能落在段落/行/字符处，
// 不打断 markdown 结构的概率最高。

// 飞书 interactive 卡片 JSON 上限约 30KB，3000 个 CJK 字符 UTF-8 约 9KB，留足卡片包壳余量
export const CHUNK_MAX_CHARS = 3000;

// 围栏配平：切割只按段落/行/字符，不感知 ``` 代码围栏开合，切点落在代码块内部时
// 前块以未闭合围栏结尾（渲染器自动补齐、恰好看似正常），后块以裸代码内容开头被当
// 普通文本、块内孤立的闭合围栏反而打开新代码框——正文串进代码显示。此处跨块跟踪
// 围栏状态：块首处于代码内补打开围栏（带原语言标记）、块尾未闭合补闭合围栏，保证
// 每块自身闭合、渲染永不串块。简化约定：仅认行首 ``` 围栏（trimStart 后判定，4+
// 反引号长围栏同样命中），~~~ 波浪围栏与深度缩进围栏不处理（飞书场景罕见）
function balanceFences(chunks: string[]): string[] {
  let inside = false;
  let lang = '';
  return chunks.map((chunk) => {
    const prefix = inside ? `\`\`\`${lang}\n` : '';
    for (const line of chunk.split('\n')) {
      const t = line.trimStart();
      if (!t.startsWith('```')) continue;
      if (inside) {
        inside = false;
        lang = '';
      } else {
        inside = true;
        // 围栏打开行的 info string 取首个词作语言标记（`` ```js `` → js），续块开头复用
        lang = t.slice(3).trim().split(/\s+/)[0] ?? '';
      }
    }
    const suffix = inside ? '\n```' : '';
    return `${prefix}${chunk}${suffix}`;
  });
}

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
  return balanceFences(chunks);
}
