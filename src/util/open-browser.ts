// 跨平台开浏览器（best-effort：失败静默，用户可手动复制 URL）
import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // cmd /c start：Windows 默认浏览器；空标题占位防 URL 被当成标题
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // 开不了浏览器不影响功能：URL 已打印在终端
  }
}
