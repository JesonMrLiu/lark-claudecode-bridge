// lcb ws add/remove 的核心逻辑：对已有 config.yaml 做增量改写。
// ⚠️ 用 parseDocument 而非 stringify 全量重写——目标文件可能是用户手写的（带注释），
//    全量重写会抹掉注释；setup 向导可以 stringify 是因为它写的是全新文件。
// 纯逻辑 + statSync 存在性检查，写盘由调用方（bin）负责，tests/ws-manager.test.ts 直接单测。
import { statSync } from 'node:fs';
import { parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';

export type WsResult = { ok: true; yaml: string } | { ok: false; error: string };

function workspacesSeq(raw: string): YAMLSeq<YAMLMap> | undefined {
  const doc = parseDocument(raw);
  return doc.get('workspaces') as YAMLSeq<YAMLMap> | undefined;
}

/** 现有工作区名列表（保持文档顺序） */
function existingNames(seq: YAMLSeq<YAMLMap> | undefined): string[] {
  return (seq?.items ?? []).map((m) => String(m.get('name')));
}

/** 添加工作区：校验名字形状 / 重名 / 路径存在性，通过后追加到 workspaces 序列 */
export function addWorkspace(raw: string, name: string, path: string): WsResult {
  const trimmed = name.trim();
  // /ws use 按空格分词，含空白的名字无法被切换到
  if (!trimmed || /\s/.test(trimmed)) return { ok: false, error: '工作区名字不能为空、且不能包含空白字符' };
  const seq = workspacesSeq(raw);
  if (!seq) return { ok: false, error: '配置缺少 workspaces 列表，请先运行 lcb setup' };
  if (existingNames(seq).includes(trimmed)) return { ok: false, error: `工作区 "${trimmed}" 已存在` };
  try {
    // 白名单路径必须是真实目录：注册不存在的路径没有意义，且会把拼写错误留到任务执行时才暴露
    if (!statSync(path).isDirectory()) return { ok: false, error: `路径 ${path} 不是目录` };
  } catch {
    return { ok: false, error: `路径 ${path} 不存在，请先创建目录` };
  }
  const doc = parseDocument(raw);
  doc.addIn(['workspaces'], { name: trimmed, path });
  return { ok: true, yaml: doc.toString() };
}

/** 删除工作区：最后一个不可删（loadConfig 要求 ≥1）；删的是默认工作区时回退到剩余第一个 */
export function removeWorkspace(raw: string, name: string): WsResult {
  const seq = workspacesSeq(raw);
  if (!seq) return { ok: false, error: '配置缺少 workspaces 列表，请先运行 lcb setup' };
  const names = existingNames(seq);
  if (!names.includes(name)) return { ok: false, error: `工作区 "${name}" 不存在，lcb ws list 查看` };
  if (names.length === 1) return { ok: false, error: '不能删除最后一个工作区（配置至少需要一个）' };
  const doc = parseDocument(raw);
  const idx = (doc.get('workspaces') as YAMLSeq<YAMLMap>).items.findIndex((m) => String(m.get('name')) === name);
  (doc.get('workspaces') as YAMLSeq<YAMLMap>).delete(idx);
  // 删默认工作区：defaults 必须指向仍存在的名字，否则下次 loadConfig 直接抛错拒启
  if (doc.getIn(['defaults', 'workspace']) === name) {
    const fallback = existingNames(doc.get('workspaces') as YAMLSeq<YAMLMap>).find((n) => n !== name);
    doc.setIn(['defaults', 'workspace'], fallback);
  }
  return { ok: true, yaml: doc.toString() };
}
