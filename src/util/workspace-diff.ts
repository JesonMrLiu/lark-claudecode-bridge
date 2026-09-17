// 工作区单文件改动收集：用户对收尾文件清单回复数字时，按需生成该文件的本次 unified diff。
// 不做文件快照——git 是代码工作区的既有事实（非 git 仓库返回 null，由调用方给出提示文案）
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createTwoFilesPatch } from 'diff';

const execFileP = promisify(execFile);

function isGitRepo(wsPath: string): Promise<boolean> {
  return execFileP('git', ['rev-parse', '--is-inside-work-tree'], { cwd: wsPath })
    .then((r) => r.stdout.trim() === 'true')
    .catch(() => false);
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/**
 * 收集单个文件的未提交改动（staged + unstaged + untracked）为 unified diff 文本。
 * - 返回 null = 非 git 仓库 / 路径在工作区外 / 文件不可读（二进制、untracked 已删等）
 * - 返回空串 = git 仓库内该文件无改动
 */
export async function collectFileDiff(wsPath: string, file: string): Promise<string | null> {
  const abs = resolve(wsPath, file);
  const rel = relative(wsPath, abs);
  // 工作区外（含绝对路径指向别处）不取 diff：清单来自 OutputCollector 的 cwd 内过滤，双保险
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (!(await isGitRepo(wsPath))) return null;
  const relPosix = rel.split(sep).join('/'); // win32 反斜杠归一（git 输出/参数统一正斜杠）
  // untracked 判定走 status 单文件查询（git diff 不覆盖未跟踪文件）
  const status = await execFileP('git', ['status', '--porcelain', '--', relPosix], { cwd: wsPath })
    .then((r) => r.stdout)
    .catch(() => '');
  const first = status.split('\n').find((l) => l.trim());
  if (first?.startsWith('??')) {
    const content = await readFile(abs, 'utf8').then(normalizeEol).catch(() => null);
    if (content === null) return null; // 二进制 / 已删除的 untracked 文件
    return createTwoFilesPatch('/dev/null', relPosix, '', content, undefined, undefined, { context: 3 })
      .replace(/^(Index: [^\n]*\n)?(===+[^\n]*\n)?/, '');
  }
  const r = await execFileP('git', ['diff', 'HEAD', '--unified=3', '--', relPosix], {
    cwd: wsPath,
    maxBuffer: 8 * 1024 * 1024,
  }).catch(() => null);
  if (r === null) return null;
  return r.stdout.trim();
}
