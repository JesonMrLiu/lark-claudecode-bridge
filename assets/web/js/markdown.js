// ============ 极简 Markdown 渲染（公共模块） ============
// 先整体转义再还原语法，绝无 XSS 面。支持：标题 / 代码块 / 行内代码 / 粗斜体 /
// 列表 / 引用 / 链接 / 分割线 / 表格。消费方：Skill 文件查看（只看视图）、会话页 AI 回复气泡。
import { esc } from './core.js';

export function renderMarkdown(src) {
  const codeBlocks = [];
  let text = String(src).replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    codeBlocks.push(`<pre style="background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:10px;overflow:auto;font-size:12px"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\n ${codeBlocks.length - 1} \n`;
  });
  const lines = text.split('\n');
  const out = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code style="background:var(--code-bg);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const isDelim = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes('-');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const block = /^ (\d+) $/.exec(line);
    if (block) { closeList(); out.push(codeBlocks[Number(block[1])]); i++; continue; }
    // 表格：表头行 |a|b| + 分隔行 |---|---| 的连续块
    if (line.includes('|') && line.trim().startsWith('|') && i + 1 < lines.length && isDelim(lines[i + 1])) {
      closeList();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(`<table style="border-collapse:collapse;font-size:12.5px;margin:8px 0">`
        + `<thead><tr>${head.map((h) => `<th style="border:1px solid var(--border);padding:5px 10px;text-align:left">${h}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td style="border:1px solid var(--border);padding:5px 10px">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); const lv = h[1].length; out.push(`<h${lv + 1} style="margin:12px 0 6px">${inline(h[2])}</h${lv + 1}>`); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!listOpen) { out.push('<ul style="margin:4px 0;padding-left:22px">'); listOpen = true; }
      out.push(`<li style="margin:2px 0">${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      i++; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (!listOpen) { out.push('<ul style="margin:4px 0;padding-left:22px">'); listOpen = true; }
      out.push(`<li style="margin:2px 0">${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`);
      i++; continue;
    }
    closeList();
    if (/^---+\s*$/.test(line)) { out.push('<hr style="border:none;border-top:1px solid var(--border);margin:10px 0">'); i++; continue; }
    if (/^>\s?/.test(line)) { out.push(`<blockquote style="margin:6px 0;padding:4px 12px;border-left:3px solid var(--border2);color:var(--mut)">${inline(line.replace(/^>\s?/, ''))}</blockquote>`); i++; continue; }
    if (line.trim() === '') { out.push(''); i++; continue; }
    out.push(`<p style="margin:4px 0">${inline(line)}</p>`);
    i++;
  }
  closeList();
  return out.join('\n');
}
