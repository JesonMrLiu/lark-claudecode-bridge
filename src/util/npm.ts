// npm CLI 执行器：统一走 npm CLI（而非直连 registry），天然尊重用户 .npmrc 的
// registry 镜像与代理配置（国内 npmmirror 场景）。自更新（web/update.ts）与
// 飞书官方 CLI 安装（lark-cli-manager.ts）共用
import { execFile } from 'node:child_process';

/** win32 下 npm 是 npm.cmd（execFile 无 PATHEXT 处理），走 cmd /c——open-browser.ts 同款先例 */
export function npmCommand(): { file: string; prefixArgs: string[] } {
  return process.platform === 'win32'
    ? { file: 'cmd', prefixArgs: ['/c', 'npm'] }
    : { file: 'npm', prefixArgs: [] };
}

/** npx 与 npm 同为 .cmd shim（npx.cmd），cmd /c 前缀同款 */
export function npxCommand(): { file: string; prefixArgs: string[] } {
  return process.platform === 'win32'
    ? { file: 'cmd', prefixArgs: ['/c', 'npx'] }
    : { file: 'npx', prefixArgs: [] };
}

export function runNpm(args: string[], timeoutMs: number): Promise<string> {
  const { file, prefixArgs } = npmCommand();
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...prefixArgs, ...args],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (e, stdout, stderr) => {
        if (e) {
          const detail = String(stderr || stdout || '').trim().slice(0, 500);
          reject(new Error(detail || `npm ${args[0]} 执行失败（${(e as NodeJS.ErrnoException).code ?? '超时或退出码非 0'}）`));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

/** npx 执行器（飞书 CLI 的 SKILL 安装用）；错误处理与 runNpm 同构 */
export function runNpx(args: string[], timeoutMs: number): Promise<string> {
  const { file, prefixArgs } = npxCommand();
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...prefixArgs, ...args],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (e, stdout, stderr) => {
        if (e) {
          const detail = String(stderr || stdout || '').trim().slice(0, 500);
          reject(new Error(detail || `npx ${args[0]} 执行失败（${(e as NodeJS.ErrnoException).code ?? '超时或退出码非 0'}）`));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}
