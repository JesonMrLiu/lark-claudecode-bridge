// 运行日志查看器 API（概览页「查看日志」抽屉数据源）：
// - 列表：logs/ 目录下全部 *.log（现命名 bridge-YYYY-MM-DD.log，按天滚动），按修改时间倒序
// - 单文件尾读：按文件名取尾部 N 行
// - 日期范围（会话页主路径）：from~to 每天的日志依时间序合并尾读，前端不再列文件只选日期
// 安全：文件名白名单 + 解析后必须仍落在 logs 目录内（防路径穿越读到配置/凭证）
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const LOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/;
const RANGE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 尾读切块上限：超过就只读文件末尾这一段（首行可能被截断，标记 truncated 丢弃） */
const TAIL_WINDOW_BYTES = 1_500_000;
/** 日期范围查询的防呆上限（主人拍板：最多搜 7 天，跨天全量检索代价高且很少需要） */
const RANGE_MAX_DAYS = 7;
/** 单文件在范围查询里的行数配额（避免单日巨日志吃光总量配额） */
const RANGE_PER_FILE_LINES = 1000;

const logsDirOf = (configPath: string): string => join(resolve(configPath, '..'), 'logs');

export interface LogFileEntry { name: string; size: number; mtime: string }

export function listLogFiles(configPath: string): { dir: string; files: LogFileEntry[] } {
  const dir = logsDirOf(configPath);
  let files: LogFileEntry[] = [];
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith('.log'))
      .map((name) => {
        try {
          const st = statSync(join(dir, name));
          return { name, size: st.size, mtime: st.mtime.toISOString() };
        } catch {
          return { name, size: 0, mtime: '' };
        }
      })
      .filter((f) => f.mtime)
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch { /* logs 目录不存在（从未启动过桥）：空列表 */ }
  return { dir, files };
}

export interface LogTail {
  name: string;
  size: number;
  /** true = 文件过大只读了末尾窗口，首行可能不完整（前端丢弃首行残缺即可） */
  truncated: boolean;
  lines: string[];
}

/** 读取文件文本：>TAIL_WINDOW_BYTES 时只读末尾窗口（首行可能残缺） */
function readTailText(fp: string, size: number): { text: string; truncated: boolean } {
  if (size > TAIL_WINDOW_BYTES) {
    // 只读末尾窗口：开 fd 定位到 size-window 再读（避免整文件载入内存）
    const fd = openSync(fp, 'r');
    try {
      const buf = Buffer.alloc(TAIL_WINDOW_BYTES);
      const read = readSync(fd, buf, 0, TAIL_WINDOW_BYTES, size - TAIL_WINDOW_BYTES);
      return { text: buf.subarray(0, read).toString('utf8'), truncated: true };
    } finally {
      closeSync(fd);
    }
  }
  return { text: readFileSync(fp, 'utf8'), truncated: false };
}

/** 取尾部 maxLines 行（默认 500，上限 5000） */
export function tailLogFile(configPath: string, name: string, maxLines: number): LogTail | { error: string } {
  if (!LOG_NAME_RE.test(name)) return { error: '文件名不合法' };
  const dir = resolve(logsDirOf(configPath));
  const fp = resolve(dir, name);
  if (!fp.startsWith(dir + sep)) return { error: '路径不在日志目录内' };
  const limit = Number.isFinite(maxLines) ? Math.min(Math.max(Math.floor(maxLines), 1), 5000) : 500;
  let st;
  try {
    st = statSync(fp);
  } catch {
    return { error: '日志文件不存在（可能已被 14 天滚动清理）' };
  }
  if (!st.isFile()) return { error: '不是文件' };
  const { text, truncated } = readTailText(fp, st.size);
  let lines = text.split(/\r?\n/);
  if (truncated && lines.length > 0) lines.shift(); // 末尾窗口首行大概率被切断
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { name, size: st.size, truncated, lines: lines.slice(-limit) };
}

export interface LogRangeTail {
  from: string;
  to: string;
  /** 实际并入的日志文件（升序 = 时间序），前端可提示覆盖了哪些天 */
  files: string[];
  /** true = 达到总量上限或某文件只读了末尾窗口 */
  truncated: boolean;
  lines: string[];
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** 本地时区的 YYYY-MM-DD（日志文件名按本地日滚动，与 log-tee 命名同口径） */
const localDate = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * 日期范围聚合尾读：from~to（含两端）每天的 bridge-YYYY-MM-DD.log 依时间序合并。
 * 每文件最多 RANGE_PER_FILE_LINES 行（防止单日巨日志吃光配额），总量再按 maxLines 截尾。
 * 单日文件过大只读末尾窗口时同样标记 truncated。
 */
export function tailLogRange(configPath: string, from: string, to: string, maxLines: number): LogRangeTail | { error: string } {
  if (!RANGE_DATE_RE.test(from) || !RANGE_DATE_RE.test(to)) return { error: '日期格式须为 YYYY-MM-DD' };
  const startMs = new Date(`${from}T00:00:00`).getTime();
  const endMs = new Date(`${to}T00:00:00`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { error: '日期不合法' };
  if (endMs < startMs) return { error: '结束日期不能早于开始日期' };
  if ((endMs - startMs) / 86_400_000 > RANGE_MAX_DAYS - 1) {
    return { error: `抱歉，最多只能搜索 ${RANGE_MAX_DAYS} 天范围内日志，请重新选择时间` };
  }
  const limit = Number.isFinite(maxLines) ? Math.min(Math.max(Math.floor(maxLines), 1), 5000) : 2000;

  const dir = resolve(logsDirOf(configPath));
  const files: string[] = [];
  let truncated = false;
  const lines: string[] = [];
  for (let t = startMs; t <= endMs; t += 86_400_000) {
    // 按 1 天步进在 DST/大小时由 localDate 归一（国内无 DST；跨月由 Date 自动进位）
    const dateStr = localDate(t);
    if (localDate(t + 12 * 3600_000) !== dateStr) continue; // 极端时钟回拨防重复
    const name = `bridge-${dateStr}.log`;
    const fp = resolve(dir, name);
    let st;
    try {
      st = statSync(fp);
      if (!st.isFile()) continue;
    } catch {
      continue; // 当天无日志（未运行/已被清理）：静默跳过
    }
    files.push(name);
    const { text, truncated: tailCut } = readTailText(fp, st.size);
    if (tailCut) truncated = true;
    let dayLines = text.split(/\r?\n/);
    if (tailCut && dayLines.length > 0) dayLines.shift();
    while (dayLines.length && dayLines[dayLines.length - 1] === '') dayLines.pop();
    lines.push(...dayLines.slice(-RANGE_PER_FILE_LINES));
    if (lines.length > limit * 2) break; // 已远超总量：提前收尾（最后统一截尾）
  }
  if (files.length === 0) return { error: '所选日期范围内没有日志文件（未运行过或已被 14 天滚动清理）' };
  return { from, to, files, truncated: truncated || lines.length > limit, lines: lines.slice(-limit) };
}
