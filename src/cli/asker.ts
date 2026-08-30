// 行问答器：lcb setup 向导与 lcb app add 交互共用。
// 不用 readline/promises 的 rl.question 链：管道输入下所有行可能同 tick 送达，
// 连续 await question() 会丢行挂起；改为持久 line 监听 + 行队列，TTY 与管道两用。
// EOF（管道读完 / Ctrl+D）时未决问题以空串放行——语义等同「直接回车取默认值」，
// 向导流程保证能走完，不会挂出 unsettled promise。
import { createInterface } from 'node:readline';

export function asker(input: NodeJS.ReadableStream & { isTTY?: boolean }, output: NodeJS.WritableStream) {
  const rl = createInterface({ input, output });
  const lines: string[] = [];
  const waiters: Array<(v: string) => void> = [];
  let eof = false;
  rl.on('line', (l: string) => {
    const w = waiters.shift();
    if (w) w(l);
    else lines.push(l);
  });
  rl.on('close', () => {
    eof = true;
    while (waiters.length) waiters.shift()!('');
  });
  return {
    async ask(q: string, def?: string): Promise<string> {
      output.write(def ? `${q}（回车默认 ${def}）：` : `${q}：`);
      const a = await new Promise<string>((resolve) => {
        const first = lines.shift();
        if (first !== undefined || eof) resolve(first ?? '');
        else waiters.push(resolve);
      });
      if (!input.isTTY) output.write(`${a}\n`); // 管道模式回显答案（TTY 下终端已自行回显）
      return a.trim() || def || '';
    },
    close: () => { rl.close(); },
  };
}

export type Asker = ReturnType<typeof asker>;
