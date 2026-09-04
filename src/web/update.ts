// 版本检查与自更新：统一走 npm CLI（npm view / npm install -g），天然尊重用户
// .npmrc 的 registry 镜像与代理配置（国内 npmmirror 场景），不做直连 registry.npmjs.org
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { VERSION } from '../version.js';

export const PKG_NAME = '@jesonliu/lark-claudecode-bridge';

/** win32 下 npm 是 npm.cmd（execFile 无 PATHEXT 处理），走 cmd /c——open-browser.ts 同款先例 */
export function npmCommand(): { file: string; prefixArgs: string[] } {
  return process.platform === 'win32'
    ? { file: 'cmd', prefixArgs: ['/c', 'npm'] }
    : { file: 'npm', prefixArgs: [] };
}

export interface UpdateCheck { current: string; latest: string; hasUpdate: boolean }

/** 纯函数（可测）：从 `npm view <pkg> version` 输出解析版本号——取最后一行非空并去 json 引号（旧 npm 习惯） */
export function parseLatestVersion(out: string): string {
  return (out.split(/\r?\n/).filter(Boolean).pop() ?? '').trim().replace(/^"|"$/g, '');
}

/** 纯函数（可测）：三段语义化版本比较，latest 严格大于 current 才算有更新（镜像落后于本地时不算） */
export function hasNewerVersion(latest: string, current: string): boolean {
  const pa = latest.split('.').map(Number);
  const pb = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

export async function checkUpdate(): Promise<UpdateCheck> {
  const out = await runNpm(['view', PKG_NAME, 'version'], 15_000);
  const latest = parseLatestVersion(out);
  if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error(`无法解析 npm 返回的版本号："${latest.slice(0, 50)}"`);
  return { current: VERSION, latest, hasUpdate: hasNewerVersion(latest, VERSION) };
}

/** 执行全局更新（npm install -g pkg@latest）；返回 npm 输出供页面展示。耗时 1-2 分钟属正常 */
export async function runUpdate(): Promise<string> {
  return runNpm(['install', '-g', `${PKG_NAME}@latest`], 5 * 60_000);
}

export type InstallMode = 'global' | 'other';

/** 纯函数（可测）：模块目录是否位于 npm 安装的包目录内 */
export function detectInstallMode(moduleDir: string): InstallMode {
  const marker = `node_modules${sep}@jesonliu${sep}lark-claudecode-bridge`;
  return moduleDir.includes(marker) ? 'global' : 'other';
}

/**
 * 安装方式探测：非 npm 安装（源码运行等）时 npm i -g 会装出另一份全局副本，
 * 并非更新当前运行实例——页面据此提示手动更新而非一键更新
 */
export function installMode(): InstallMode {
  return detectInstallMode(fileURLToPath(new URL('./', import.meta.url)));
}

function runNpm(args: string[], timeoutMs: number): Promise<string> {
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
