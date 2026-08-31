// 飞书展示 / transcript 落盘共用的北京时间工具。
// 全部固定 Asia/Shanghai，不依赖机器时区——bridge 可能被部署到 UTC 服务器上，
// 但用户视角永远是北京时间。
//
// 已有相关代码：
//   - src/transcript/transcript-writer.ts:22 localDate()：仅取本地日期用于 JSONL 文件名，
//     不带时分、也不接受任意 ISO 输入，故不复用。
//   - src/index.ts:298、src/session/commands.ts:57/89 历史 toISOString() 用法：
//     一律换成下面两个函数，存储层仍以 ISO 保留以兼容历史数据。

const TZ = 'Asia/Shanghai';

/** 把 ISO 串或 Date 渲染为北京时间 'YYYY-MM-DD HH:mm'。非法输入原样返回（不抛错）。 */
export function formatBeijingTime(input: string | Date | null | undefined): string {
  if (input == null) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return typeof input === 'string' ? input : '';
  // en-CA locale 正好输出 YYYY-MM-DD；hourCycle h23 保证 24 小时制（zh-CN 不加 h23 偶尔出现 24:00）
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 当前时刻输出带 +08:00 偏移的标准 ISO 8601，如 '2026-08-31T22:10:00.000+08:00'。
 *  用机器 + 8h 偏移再把 'Z' 换成 '+08:00'——最简、仍是合法 ISO，Notion / Excel 都能识别 */
export function nowBeijingISO(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}