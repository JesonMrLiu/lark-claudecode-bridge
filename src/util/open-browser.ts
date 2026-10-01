// 跨平台开浏览器（best-effort：失败静默，用户可手动复制 URL）
import { spawn, type ChildProcess } from 'node:child_process';

// 命令不存在（无桌面 Linux 常见：无 xdg-open）时 Node 异步 emit 'error'；
// EventEmitter 无 listener 的 'error' 会 throw 崩掉整个进程——best-effort 语义必须在此吞掉
function bestEffort(child: ChildProcess): void {
  child.on('error', () => {});
  child.unref();
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // cmd /c start：Windows 默认浏览器；空标题占位防 URL 被当成标题
      bestEffort(spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }));
    } else if (process.platform === 'darwin') {
      bestEffort(spawn('open', [url], { detached: true, stdio: 'ignore' }));
    } else {
      bestEffort(spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }));
    }
  } catch {
    // 开不了浏览器不影响功能：URL 已打印在终端
  }
}
