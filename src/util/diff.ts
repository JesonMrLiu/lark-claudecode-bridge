// 文件差异工具：为写工具（Write/Edit）的确认卡片生成 unified diff 文本。
// 基于 jsdiff（零依赖），上下文行数 3（与 git diff 默认一致）。
import { readFileSync } from 'node:fs';
import { createTwoFilesPatch } from 'diff';

/** 生成写工具的 unified diff；无内容差异或无法生成时返回 ''（调用方回退显示 summary） */
export function generateFileDiff(toolName: string, input: Record<string, unknown>): string {
  try {
    if (toolName === 'Write') return writeDiff(input);
    if (toolName === 'Edit') return editDiff(input);
    // NotebookEdit 的 input 是单元格级结构（new_cell 等），单元格 diff 可读性差，不生成
    return '';
  } catch {
    // 读文件失败（权限/编码等）不应阻断确认流程：无 diff 就显示原 summary
    return '';
  }
}

/** Write：新文件（原不存在）= 全 + 行；覆盖写 = 与原内容全文对比 */
function writeDiff(input: Record<string, unknown>): string {
  const filePath = input.file_path;
  if (typeof filePath !== 'string' || !filePath) return '';
  const newContent = typeof input.content === 'string' ? input.content : '';
  const oldExists = exists(filePath);
  const oldContent = oldExists ? readFile(filePath) : undefined;
  return toPatch(filePath, oldContent, newContent, oldExists);
}

/** Edit：读原文件应用 old_string→new_string 替换后整体对比（比仅对比 old/new 片段多上下文，可读性更好） */
function editDiff(input: Record<string, unknown>): string {
  const filePath = input.file_path;
  if (typeof filePath !== 'string' || !filePath) return '';
  const { oldString, newString } = { oldString: input.old_string, newString: input.new_string };
  if (typeof oldString !== 'string' || typeof newString !== 'string') return '';
  const raw = readFile(filePath);
  const content = normalizeEol(raw);
  // old_string 不在文件中（模型定位失误）：不生成误导性的空 diff，回退 summary
  if (!content.includes(oldString)) return '';
  const replaced = input.replace_all === true
    ? content.split(oldString).join(newString)
    : content.replace(oldString, () => newString); // 函数形式替换：避免 newString 含 $& 等替换模式被二次解释
  return toPatch(filePath, content, replaced, true);
}

/** 统一输出：jsdiff 补丁文本，去掉 Index/=== 头部行；CRLF 归一为 LF 防整文件误报全改 */
function toPatch(filePath: string, oldContent: string | undefined, newContent: string, oldExists: boolean): string {
  const patch = createTwoFilesPatch(
    oldExists ? filePath : '/dev/null',
    filePath,
    oldExists ? normalizeEol(oldContent ?? '') : '', // jsdiff v9 不接受 undefined：空串生成 -0,0 全新增
    normalizeEol(newContent),
    undefined,
    undefined,
    { context: 3 },
  );
  // 去掉 jsdiff 加的头部噪音（'Index: ...' 与 '====' 分隔行），保留 ---/+++ 起始的正文
  return patch.replace(/^(Index: [^\n]*\n)?(===+[^\n]*\n)?/, '');
}

function exists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

function readFile(p: string): string {
  return readFileSync(p, 'utf8');
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}
