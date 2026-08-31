// 工作区改动收集：code-dev 工作区任务收尾时用 git diff 生成全量 unified diff。
// 不做文件快照——git 是 code-dev 工作区的既有事实（非 git 仓库回退旧上传行为，由调用方处理）
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createTwoFilesPatch } from 'diff';

const execFileP = promisify(execFile);

// untracked 合成新增 diff 的文件数上限：防 node_modules 误入 status 时 diff 爆炸
const MAX_UNTRACKED_FILES = 20;

function isGitRepo(wsPath: string): Promise<boolean> {
  return execFileP('git', ['rev-parse', '--is-inside-work-tree'], { cwd: wsPath })
    .then((r) => r.stdout.trim() === 'true')
    .catch(() => false);
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/** untracked 文件合成为「全新增」diff（git diff 不覆盖未跟踪文件） */
async function untrackedDiff(wsPath: string): Promise<string> {
  const status = await execFileP('git', ['status', '--porcelain'], { cwd: wsPath }).catch(() => ({ stdout: '' }));
  const files = status.stdout
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter((f) => f && !f.endsWith('/')) // 目录条目（?? dir/）无法按文件读取，跳过
    .slice(0, MAX_UNTRACKED_FILES);
  const patches: string[] = [];
  for (const f of files) {
    const content = await readFile(join(wsPath, f), 'utf8').then(normalizeEol).catch(() => null);
    if (content === null) continue;
    patches.push(createTwoFilesPatch('/dev/null', f, '', content, undefined, undefined, { context: 3 })
      .replace(/^(Index: [^\n]*\n)?(===+[^\n]*\n)?/, ''));
  }
  return patches.join('\n');
}

export interface WorkspaceDiff { diff: string; files: number }

/**
 * 收集工作区全部未提交改动（staged + unstaged + untracked）为 unified diff 文本与文件数。
 * 返回 null = 非 git 仓库（调用方回退旧行为）；diff 空串 = git 仓库但无改动。
 */
export async function collectWorkspaceDiff(wsPath: string): Promise<WorkspaceDiff | null> {
  if (!(await isGitRepo(wsPath))) return null;
  const tracked = await execFileP('git', ['diff', 'HEAD', '--unified=3'], { cwd: wsPath, maxBuffer: 16 * 1024 * 1024 })
    .then((r) => r.stdout)
    .catch(() => '');
  const untracked = await untrackedDiff(wsPath);
  const trackedFiles = (tracked.match(/^diff --git /gm) ?? []).length;
  const untrackedFiles = (untracked.match(/^\+\+\+ /gm) ?? []).length;
  return {
    diff: [tracked.trimEnd(), untracked.trimEnd()].filter(Boolean).join('\n'),
    files: trackedFiles + untrackedFiles,
  };
}
