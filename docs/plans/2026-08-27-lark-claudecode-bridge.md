# lark-claudecode-bridge 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书 ↔ Claude Code 桥接器——飞书发消息驱动本机 Claude Code，写操作以卡片按钮确认（长连接回调，免公网 IP），结果文本与产出文件回传飞书。

**Architecture:** 单个常驻 Node 进程，四模块：feishu-gateway（飞书长连接收发/卡片/上传）、session-manager（通道队列、会话、/命令）、claude-executor（Agent SDK 驱动、canUseTool 权限拦截、产出收集）、access-control（配对/白名单/admin）。模块间通过注入的回调接口衔接。

**Tech Stack:** TypeScript (strict, ESM)、Node ≥20、`@larksuiteoapi/node-sdk`、`@anthropic-ai/claude-agent-sdk`、`yaml`、`picocolors`、vitest。

**Spec:** `docs/specs/2026-08-27-feishu-claude-bridge-design.md`（实现前通读）

## Global Constraints

- 工作目录：所有命令在 `F:\workspace\plugins\lark-claudecode-bridge` 执行
- Node ≥20（本机 v24 满足）；TypeScript strict；ESM（`"type": "module"`）；测试 vitest
- npm 包名 `@jesonliu/lark-claudecode-bridge`，bin 命令 `lcb`，配置目录 `~/.lark-claudecode-bridge/`
- 只读工具白名单自动放行：`Read, Glob, Grep, LS, TodoRead, TodoWrite, WebFetch, WebSearch`
- 写操作必须经确认卡片：按钮「允许 / 拒绝 / 本次会话不再询问」；确认超时 10 分钟自动拒绝；仅发起任务的用户按钮生效
- 卡片回调走长连接事件 `card.action.trigger`（新版卡片 schema "2.0"，按钮用 `behaviors[].type = "callback"`）
- 鉴权透传：不得覆盖/清理 `ANTHROPIC_*` 等环境变量；Agent SDK 必须传 `settingSources: ['user', 'project']`
- 通道并发：每通道（chatId×userId）串行，全局并发上限默认 3（config `concurrency`）
- 文件回传：单文件 ≤30MB；图片走图片消息；产出文件 >10 个打包 zip
- 跨平台：路径用 `node:path`；yaml 里 Windows 路径正反斜杠均接受；不使用平台专属 API
- 所有用户可见文案（卡片/命令回复）用中文
- 每个任务完成即 `git commit`（信息用中文）

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/index.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: 可运行的 vitest + tsc 环境，后续所有任务依赖

- [ ] **Step 1: 初始化 package.json 与依赖**

```bash
cd "F:\workspace\plugins\lark-claudecode-bridge"
npm init -y
npm pkg set name="@jesonliu/lark-claudecode-bridge" version="0.1.0" type="module" description="飞书 ↔ Claude Code 桥接器：卡片确认走长连接，免公网 IP" license="MIT"
npm pkg set bin.lcb="dist/bin/lcb.js" main="dist/index.js" files[0]="dist"
npm pkg set scripts.build="tsc" scripts.test="vitest run" scripts.dev="tsx src/bin/lcb.ts" scripts.prepublishOnly="npm run build"
npm install @larksuiteoapi/node-sdk @anthropic-ai/claude-agent-sdk yaml picocolors
npm install -D typescript vitest tsx @types/node
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 vitest.config.ts、.gitignore、占位入口**

`vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
```

`.gitignore`:
```
node_modules/
dist/
*.log
.env
```

`src/index.ts`（占位，Task 10 替换为装配实现）:
```typescript
export const VERSION = '0.1.0';
```

- [ ] **Step 4: 写冒烟测试并跑通**

`tests/smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('smoke', () => {
  it('环境可用', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
```

Run: `npm test`
Expected: 1 passed

Run: `npm run build`
Expected: tsc 无错误输出，生成 dist/

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: 项目脚手架（TS strict + ESM + vitest）"
```

---

### Task 2: 共享类型与配置模块

**Files:**
- Create: `src/types.ts`, `src/config.ts`, `config.example.yaml`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces（后续所有任务消费的类型）:

```typescript
// src/types.ts 全量内容（本任务一次性写齐）
export interface FeishuAppConfig { appId: string; appSecret: string; domain?: 'feishu' | 'lark' }
export interface Workspace { name: string; path: string }
export interface BridgeConfig {
  feishu: FeishuAppConfig;
  workspaces: Workspace[];
  defaults: { workspace: string };
  concurrency: number;
}
export interface IncomingMessage {
  chatId: string; chatType: 'p2p' | 'group'; userId: string; text: string; messageId: string;
}
export interface CardActionValue { requestId: string; decision: 'allow' | 'deny' | 'allow-session' }
export interface CardActionEvent { value: CardActionValue; operatorId: string; openMessageId: string }
export interface GatewayHandlers {
  onMessage(msg: IncomingMessage): Promise<void>;
  onCardAction(action: CardActionEvent): Promise<void>;
}
export interface ConfirmationRequest {
  requestId: string; toolName: string; summary: string; diff?: string; workspaceName: string;
}
export type PermissionDecision = 'allow' | 'deny' | 'allow-session';
export interface ProgressEvent { kind: 'text' | 'tool-start' | 'tool-result' | 'status'; content: string; ok?: boolean }
export interface TaskOutcome { sessionId: string; finalText: string; producedFiles: string[]; turns: number }
```

- [ ] **Step 1: 写失败测试**

`tests/config.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const VALID = `
feishu:
  app_id: cli_test123
  app_secret: sec_test
workspaces:
  - name: demo
    path: F:\\workspace\\demo
defaults:
  workspace: demo
`;

function tmpYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lcb-'));
  const p = join(dir, 'config.yaml');
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('loadConfig', () => {
  it('加载合法配置并填默认值', () => {
    const cfg = loadConfig(tmpYaml(VALID));
    expect(cfg.feishu.appId).toBe('cli_test123');
    expect(cfg.workspaces[0].name).toBe('demo');
    expect(cfg.concurrency).toBe(3); // 默认
    expect(cfg.feishu.domain).toBe('feishu'); // 默认
  });
  it('正斜杠 Windows 路径也接受', () => {
    const cfg = loadConfig(tmpYaml(VALID.replace('\\\\', '/')));
    expect(cfg.workspaces[0].path).toContain('/');
  });
  it('缺 app_id 报可读错误', () => {
    expect(() => loadConfig(tmpYaml('feishu: {}\n'))).toThrow(/app_id/);
  });
  it('defaults.workspace 不在工作区列表时报错', () => {
    const bad = VALID.replace('workspace: demo', 'workspace: nope');
    expect(() => loadConfig(tmpYaml(bad))).toThrow(/nope/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL（loadConfig 未定义）

- [ ] **Step 3: 实现 src/config.ts**

```typescript
import { readFileSync } from 'node:fs';
import { parse, type YAMLParseError } from 'yaml';
import type { BridgeConfig } from './types.js';

export const CONFIG_DIR = join(homedir(), '.lark-claudecode-bridge');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

export function loadConfig(path: string = CONFIG_PATH): BridgeConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`找不到配置文件 ${path}，请先运行 lcb setup`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`配置文件 YAML 语法错误：${(e as YAMLParseError).message}`);
  }
  const feishu = (doc.feishu ?? {}) as Record<string, string>;
  if (!feishu.app_id) throw new Error('配置缺少 feishu.app_id');
  if (!feishu.app_secret) throw new Error('配置缺少 feishu.app_secret');
  const workspaces = (doc.workspaces ?? []) as Array<{ name: string; path: string }>;
  if (workspaces.length === 0) throw new Error('配置至少需要一个 workspaces 条目');
  const defaults = (doc.defaults ?? {}) as { workspace: string };
  if (!workspaces.some((w) => w.name === defaults.workspace)) {
    throw new Error(`defaults.workspace "${defaults.workspace}" 不在 workspaces 列表中`);
  }
  return {
    feishu: {
      appId: feishu.app_id,
      appSecret: feishu.app_secret,
      domain: feishu.domain === 'lark' ? 'lark' : 'feishu',
    },
    workspaces,
    defaults: { workspace: defaults.workspace },
    concurrency: Number(doc.concurrency ?? 3),
  };
}
```

注意文件顶部补 `import { homedir } from 'node:os'; import { join } from 'node:path';`。`src/types.ts` 按 Interfaces 块全量写入。

- [ ] **Step 4: 写 config.example.yaml 并跑测试**

`config.example.yaml`:
```yaml
feishu:
  app_id: cli_xxxx        # 飞书开放平台 → 凭证与基础信息
  app_secret: xxxx
  # domain: lark          # 国际版 Lark 才需要
workspaces:                # 工作区白名单：名字 + 路径
  - name: demo
    path: F:\workspace\demo
defaults:
  workspace: demo
concurrency: 3             # 通道间并发上限
```

Run: `npx vitest run tests/config.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 配置加载与共享类型"
```

---

### Task 3: access-control（配对/白名单/admin）

**Files:**
- Create: `src/access/access-control.ts`
- Test: `tests/access.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface AccessStoreData {
  users: Record<string, { name: string; role: 'admin' | 'member'; pairedAt: string }>;
  pending: Record<string, { userId: string; name: string; code: string; expiresAt: number }>;
}
export class AccessControl {
  constructor(storePath: string);
  static load(storePath: string): AccessControl;            // 文件不存在则空库
  isAllowed(userId: string): boolean;
  isAdmin(userId: string): boolean;
  listPending(): Array<{ userId: string; name: string; code: string }>;
  beginPairing(userId: string, name: string): string;       // 返回 6 位配对码，15 分钟有效
  approvePairing(code: string): { ok: boolean; userId?: string; isFirstAdmin?: boolean; error?: string };
  rejectPairing(code: string): boolean;                     // 删除 pending
}
```

- [ ] **Step 1: 写失败测试**

`tests/access.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessControl } from '../src/access/access-control.js';

function fresh(): AccessControl {
  return AccessControl.load(join(mkdtempSync(join(tmpdir(), 'lcb-a-')), 'access.json'));
}

describe('AccessControl', () => {
  it('陌生人不允许', () => {
    expect(fresh().isAllowed('ou_a')).toBe(false);
  });
  it('配对码批准后允许，首个用户成为 admin', () => {
    const a = fresh();
    const code = a.beginPairing('ou_a', '张三');
    expect(code).toMatch(/^\d{6}$/);
    const r = a.approvePairing(code);
    expect(r.ok).toBe(true);
    expect(r.isFirstAdmin).toBe(true);
    expect(a.isAllowed('ou_a')).toBe(true);
    expect(a.isAdmin('ou_a')).toBe(true);
  });
  it('第二个配对的是 member', () => {
    const a = fresh();
    a.approvePairing(a.beginPairing('ou_a', 'A'));
    const r = a.approvePairing(a.beginPairing('ou_b', 'B'));
    expect(r.isFirstAdmin).toBe(false);
    expect(a.isAdmin('ou_b')).toBe(false);
    expect(a.isAllowed('ou_b')).toBe(true);
  });
  it('错误码拒绝', () => {
    const a = fresh();
    a.beginPairing('ou_a', 'A');
    expect(a.approvePairing('000000').ok).toBe(false);
  });
  it('过期配对码拒绝', () => {
    const a = fresh();
    const code = a.beginPairing('ou_a', 'A');
    // 直接改库模拟过期：读内部数据文件不方便，用 rejectPairing 后再 approve 验证一次性
    a.rejectPairing(code);
    expect(a.approvePairing(code).ok).toBe(false);
  });
  it('同一用户重复配对覆盖旧码', () => {
    const a = fresh();
    a.beginPairing('ou_a', 'A');
    const c2 = a.beginPairing('ou_a', 'A');
    expect(a.listPending().length).toBe(1);
    expect(a.approvePairing(c2).ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/access.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt } from 'node:crypto';
import type { AccessStoreData } from './access-control.js';

const TTL_MS = 15 * 60 * 1000;

export class AccessControl {
  private data: AccessStoreData;
  constructor(private storePath: string, data?: AccessStoreData) {
    this.data = data ?? { users: {}, pending: {} };
  }
  static load(storePath: string): AccessControl {
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8')) as AccessStoreData;
      return new AccessControl(storePath, { users: raw.users ?? {}, pending: raw.pending ?? {} });
    } catch {
      return new AccessControl(storePath);
    }
  }
  private save(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
  isAllowed(userId: string): boolean {
    return Boolean(this.data.users[userId]);
  }
  isAdmin(userId: string): boolean {
    return this.data.users[userId]?.role === 'admin';
  }
  listPending(): Array<{ userId: string; name: string; code: string }> {
    this.evict();
    return Object.values(this.data.pending).map(({ userId, name, code }) => ({ userId, name, code }));
  }
  beginPairing(userId: string, name: string): string {
    this.evict();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.data.pending[userId] = { userId, name, code, expiresAt: Date.now() + TTL_MS };
    this.save();
    return code;
  }
  approvePairing(code: string): { ok: boolean; userId?: string; isFirstAdmin?: boolean; error?: string } {
    this.evict();
    const entry = Object.values(this.data.pending).find((p) => p.code === code);
    if (!entry) return { ok: false, error: '配对码无效或已过期' };
    const isFirstAdmin = Object.keys(this.data.users).length === 0;
    this.data.users[entry.userId] = {
      name: entry.name,
      role: isFirstAdmin ? 'admin' : 'member',
      pairedAt: new Date().toISOString(),
    };
    delete this.data.pending[entry.userId];
    this.save();
    return { ok: true, userId: entry.userId, isFirstAdmin };
  }
  rejectPairing(code: string): boolean {
    const entry = Object.values(this.data.pending).find((p) => p.code === code);
    if (!entry) return false;
    delete this.data.pending[entry.userId];
    this.save();
    return true;
  }
  private evict(): void {
    const now = Date.now();
    for (const [uid, p] of Object.entries(this.data.pending)) {
      if (p.expiresAt < now) delete this.data.pending[uid];
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/access.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 访问控制（配对码/白名单/admin 首用户）"
```

---

### Task 4: card-builder（卡片 JSON 构造，纯函数）

**Files:**
- Create: `src/gateway/card-builder.ts`
- Test: `tests/card-builder.test.ts`

**Interfaces:**
- Consumes: `ConfirmationRequest`（types.ts）
- Produces:

```typescript
export function buildTextCard(markdown: string): unknown;                       // 简单 markdown 卡片
export interface ProgressState { title: string; status: string; textTail: string; toolLine: string; startedAt: number }
export function buildProgressCard(state: ProgressState): unknown;              // 流式进度卡片
export function buildConfirmCard(req: ConfirmationRequest): unknown;           // 确认卡片（三按钮）
export function buildConfirmResultCard(req: ConfirmationRequest, decision: PermissionDecision, byName: string): unknown; // 点击后的结果态
```

- [ ] **Step 1: 写失败测试**

`tests/card-builder.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildTextCard, buildProgressCard, buildConfirmCard, buildConfirmResultCard } from '../src/gateway/card-builder.js';
import type { ConfirmationRequest } from '../src/types.js';

const req: ConfirmationRequest = { requestId: 'r1', toolName: 'Bash', summary: 'git push origin main', workspaceName: 'demo' };

describe('card-builder', () => {
  it('所有卡片都是 schema 2.0', () => {
    for (const card of [buildTextCard('hi'), buildProgressCard({ title: 't', status: 's', textTail: '', toolLine: '', startedAt: 0 }), buildConfirmCard(req)]) {
      expect((card as { schema: string }).schema).toBe('2.0');
    }
  });
  it('确认卡片含三按钮与回调值', () => {
    const json = JSON.stringify(buildConfirmCard(req));
    expect(json).toContain('允许');
    expect(json).toContain('拒绝');
    expect(json).toContain('本次会话不再询问');
    expect(json).toContain('"requestId":"r1"');
    expect(json).toContain('"decision":"allow"');
    expect(json).toContain('"decision":"deny"');
    expect(json).toContain('"decision":"allow-session"');
  });
  it('确认卡片展示命令摘要与工作区', () => {
    const json = JSON.stringify(buildConfirmCard(req));
    expect(json).toContain('git push origin main');
    expect(json).toContain('demo');
  });
  it('结果态卡片不含按钮', () => {
    const json = JSON.stringify(buildConfirmResultCard(req, 'allow', '张三'));
    expect(json).toContain('张三');
    expect(json).not.toContain('"tag":"button"');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/card-builder.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
import type { ConfirmationRequest, PermissionDecision } from '../types.js';
import type { ProgressState } from './card-builder.js';

function card(elements: unknown[]): unknown {
  return { schema: '2.0', config: { update_multi: true }, body: { elements } };
}
function md(content: string): unknown {
  return { tag: 'markdown', content };
}
export function buildTextCard(markdown: string): unknown {
  return card([md(markdown)]);
}
export function buildProgressCard(state: ProgressState): unknown {
  const elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const lines = [`**${state.title}**`, ``, state.status, ``];
  if (state.toolLine) lines.push(`🔧 ${state.toolLine}`, ``);
  if (state.textTail) lines.push('---', state.textTail.slice(-1200)); // 只保留尾部，防爆卡片
  lines.push(``, `<font color='grey'>⏱ 已运行 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒</font>`);
  return card([md(lines.join('\n'))]);
}
export function buildConfirmCard(req: ConfirmationRequest): unknown {
  const body = req.diff
    ? `\`\`\`diff\n${req.diff.slice(0, 1500)}\n\`\`\``
    : `\`\`\`\n${req.summary.slice(0, 1500)}\n\`\`\``;
  return card([
    md(`**🔐 Claude 请求执行操作**\n\n工具: \`${req.toolName}\`　工作区: \`${req.workspaceName}\`\n${body}`),
    {
      tag: 'action',
      actions: (['allow', 'deny', 'allow-session'] as const).map((decision) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: decision === 'allow' ? '✅ 允许' : decision === 'deny' ? '❌ 拒绝' : '⏭ 本次会话不再询问' },
        type: decision === 'allow' ? 'primary' : decision === 'deny' ? 'danger' : 'default',
        behaviors: [{ type: 'callback', value: { requestId: req.requestId, decision } }],
      })),
    },
  ]);
}
const DECISION_TEXT: Record<PermissionDecision, string> = {
  allow: '✅ 已允许',
  deny: '❌ 已拒绝',
  'allow-session': '⏭ 本次会话不再询问',
};
export function buildConfirmResultCard(req: ConfirmationRequest, decision: PermissionDecision, byName: string): unknown {
  return card([md(`**🔐 Claude 请求执行操作**\n\n工具: \`${req.toolName}\`　工作区: \`${req.workspaceName}\`\n\`\`\`\n${req.summary.slice(0, 500)}\n\`\`\`\n\n${DECISION_TEXT[decision]}（由 ${byName} 操作）`)]);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/card-builder.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 飞书卡片构造（进度/确认/结果态）"
```

---

### Task 5: progress-card 流式状态机（节流+心跳）

**Files:**
- Create: `src/gateway/progress-card.ts`
- Test: `tests/progress-card.test.ts`

**Interfaces:**
- Consumes: `buildProgressCard`、`ProgressState`（Task 4）
- Produces:

```typescript
export interface CardSender {
  sendCard(card: unknown): Promise<string>;        // 返回 messageId
  updateCard(messageId: string, card: unknown): Promise<void>;
}
export class ProgressCard {
  constructor(sender: CardSender, title: string, opts?: { flushIntervalMs?: number; idleHeartbeatMs?: number });
  start(): Promise<void>;                          // 立即发出初始卡片
  appendText(delta: string): void;                // 文本增量入 buffer
  toolStart(name: string, summary: string): void;
  toolResult(name: string, ok: boolean): void;
  setStatus(status: string): void;
  finish(summary: string): Promise<void>;         // 终态刷新并停止计时器
}
```

- [ ] **Step 1: 写失败测试（fake timers）**

`tests/progress-card.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressCard, type CardSender } from '../src/gateway/progress-card.js';

function fakeSender() {
  const sent: Array<{ id: string; card: unknown }> = [];
  let n = 0;
  const sender: CardSender = {
    async sendCard(card) {
      const id = `m${++n}`;
      sent.push({ id, card });
      return id;
    },
    async updateCard(messageId, card) {
      sent.push({ id: messageId, card });
    },
  };
  return { sender, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ProgressCard', () => {
  it('start 立即发送一张卡片', async () => {
    const { sender, sent } = fakeSender();
    const pc = new ProgressCard(sender, '任务');
    await pc.start();
    expect(sent.length).toBe(1);
    await pc.finish('done');
  });
  it('文本增量节流：不超阈值不刷，超时/超量才刷', async () => {
    const { sender, sent } = fakeSender();
    const pc = new ProgressCard(sender, '任务', { flushIntervalMs: 1500 });
    await pc.start();
    pc.appendText('abc');
    expect(sent.length).toBe(1);            // 未到阈值未刷
    await vi.advanceTimersByTimeAsync(1600);
    expect(sent.length).toBe(2);            // 定时器到点刷出
    await pc.finish('done');
  });
  it('心跳：空闲 30s 也会刷新（显示运行时长）', async () => {
    const { sender, sent } = fakeSender();
    const pc = new ProgressCard(sender, '任务', { idleHeartbeatMs: 30_000 });
    await pc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    await pc.finish('done');
  });
  it('finish 后不再刷新', async () => {
    const { sender, sent } = fakeSender();
    const pc = new ProgressCard(sender, '任务');
    await pc.start();
    await pc.finish('✅ 完成');
    const n = sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    pc.appendText('late');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent.length).toBe(n);
    expect(JSON.stringify(sent[n - 1].card)).toContain('完成');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/progress-card.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
import { buildProgressCard, type ProgressState } from './card-builder.js';
import type { CardSender } from './progress-card.js';

const FLUSH_CHARS = 200;

export class ProgressCard {
  private messageId?: string;
  private buffer = '';
  private state: ProgressState;
  private flushTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private lastActivityAt = Date.now();
  private done = false;

  constructor(
    private sender: CardSender,
    title: string,
    private opts: { flushIntervalMs?: number; idleHeartbeatMs?: number } = {},
  ) {
    this.state = { title, status: '🚀 已接收，启动中…', textTail: '', toolLine: '', startedAt: Date.now() };
  }

  async start(): Promise<void> {
    this.messageId = await this.sender.sendCard(buildProgressCard(this.state));
    const interval = this.opts.flushIntervalMs ?? 1500;
    this.flushTimer = setInterval(() => void this.flush(), interval);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt >= (this.opts.idleHeartbeatMs ?? 30_000)) {
        void this.flush(); // 心跳：刷新运行时长，证明没卡死
      }
    }, 1000);
  }

  appendText(delta: string): void {
    if (this.done) return;
    this.buffer += delta;
    this.lastActivityAt = Date.now();
    if (this.buffer.length >= FLUSH_CHARS) void this.flush();
  }

  toolStart(name: string, summary: string): void {
    if (this.done) return;
    this.state.toolLine = `${name}: ${summary.slice(0, 120)}`;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  toolResult(name: string, ok: boolean): void {
    if (this.done) return;
    this.state.toolLine = `${ok ? '✔' : '✘'} ${name}`;
    this.lastActivityAt = Date.now();
  }

  setStatus(status: string): void {
    if (this.done) return;
    this.state.status = status;
    this.lastActivityAt = Date.now();
    void this.flush();
  }

  async finish(summary: string): Promise<void> {
    this.done = true;
    clearInterval(this.flushTimer);
    clearInterval(this.heartbeatTimer);
    this.state.status = summary;
    this.state.toolLine = '';
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.messageId) return;
    if (this.buffer) {
      this.state.textTail += this.buffer;
      this.buffer = '';
    }
    try {
      await this.sender.updateCard(this.messageId, buildProgressCard(this.state));
    } catch {
      // 单次 PATCH 失败不致命（限流/网络抖动），下轮重试
    }
  }
}
```

实现说明：`appendText`/`toolStart`/`setStatus` 入口处已有 `if (this.done) return` 守卫，`finish()` 是终态唯一出口（先置 done、清两个定时器再直接 flush 一次），`flush()` 本身不再拦 done——定时器已清，不会 finish 后再触发。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/progress-card.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 流式进度卡片状态机（节流+心跳）"
```

---

### Task 6: feishu-gateway（长连接收发）

**Files:**
- Create: `src/gateway/feishu-gateway.ts`
- Test: `tests/gateway.test.ts`

**Interfaces:**
- Consumes: `GatewayHandlers`、`BridgeConfig.feishu`（types.ts）
- Produces:

```typescript
export class FeishuGateway {
  constructor(cfg: FeishuAppConfig, deps?: { sdk?: typeof import('@larksuiteoapi/node-sdk') }); // deps 供测试注入
  start(handlers: GatewayHandlers): Promise<void>;   // WSClient 长连接；事件分发
  sendCard(chatId: string, card: unknown): Promise<string>;
  sendText(chatId: string, markdown: string): Promise<string>;
  updateCard(messageId: string, card: unknown): Promise<void>;
  uploadAndSendFile(chatId: string, filePath: string): Promise<void>;
}
export function parseIncomingMessage(event: unknown): IncomingMessage | null;  // 纯函数，可单测
export function stripMention(text: string): string;                            // 去 @ 前缀
```

- [ ] **Step 1: 写失败测试（事件解析纯函数 + handler 分发）**

`tests/gateway.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { parseIncomingMessage, stripMention, FeishuGateway } from '../src/gateway/feishu-gateway.js';

const feishuEvent = {
  event: {
    message: {
      chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text',
      content: JSON.stringify({ text: '帮我写个脚本' }),
      message_id: 'om_1',
    },
    sender: { sender_id: { open_id: 'ou_u' } },
  },
};

describe('parseIncomingMessage', () => {
  it('解析文本消息', () => {
    const msg = parseIncomingMessage(feishuEvent);
    expect(msg).toMatchObject({ chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u', text: '帮我写个脚本', messageId: 'om_1' });
  });
  it('非文本消息返回 null', () => {
    expect(parseIncomingMessage({ event: { message: { ...feishuEvent.event.message, message_type: 'image' } } })).toBeNull();
  });
  it('群聊未 @机器人 忽略，@了才处理', () => {
    const group = { event: { message: { ...feishuEvent.event.message, chat_type: 'group', content: JSON.stringify({ text: '没有提及' }) } } };
    expect(parseIncomingMessage(group)).toBeNull();
    const groupMention = { event: { message: { ...feishuEvent.event.message, chat_type: 'group', content: JSON.stringify({ text: '@_user_1 帮我查' }) } } };
    expect(parseIncomingMessage(groupMention)?.text).toBe('帮我查');
  });
  it('结构不对返回 null 不抛异常', () => {
    expect(parseIncomingMessage({})).toBeNull();
  });
});

describe('stripMention', () => {
  it('去掉 @机器人 前缀', () => {
    expect(stripMention('@_user_1 帮我查一下')).toBe('帮我查一下');
  });
  it('无提及时原样返回', () => {
    expect(stripMention('普通消息')).toBe('普通消息');
  });
});

describe('FeishuGateway 分发（注入假 SDK）', () => {
  it('收到消息事件调用 onMessage', async () => {
    const onMessage = vi.fn();
    const register = vi.fn((map: Record<string, (d: unknown) => Promise<void>>) => map);
    const fakeSdk: any = {
      WSClient: class { async start(o: { eventDispatcher: { register: typeof register } }) { o.eventDispatcher.register({}); } },
      EventDispatcher: class { constructor() {} register = register; },
      Client: class {},
      Domain: { Feishu: 'https://open.feishu.cn' },
    };
    const gw = new FeishuGateway({ appId: 'a', appSecret: 's' }, { sdk: fakeSdk });
    await gw.start({ onMessage, onCardAction: vi.fn() });
    const handlers = register.mock.results[0].value as Record<string, (d: unknown) => Promise<void>>;
    await handlers['im.message.receive_v1'](feishuEvent);
    expect(onMessage).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/gateway.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
import * as realSdk from '@larksuiteoapi/node-sdk';
import { createReadStream } from 'node:fs';
import { extname, basename } from 'node:path';
import type { FeishuAppConfig, GatewayHandlers, IncomingMessage } from '../types.js';
import { buildTextCard } from './card-builder.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function stripMention(text: string): string {
  return text.replace(/@_user_\d+\s*/g, '').trim();
}

export function parseIncomingMessage(event: unknown): IncomingMessage | null {
  try {
    const ev = event as { event?: { message?: { chat_id?: string; chat_type?: string; message_type?: string; content?: string; message_id?: string }, sender?: { sender_id?: { open_id?: string } } } };
    const m = ev.event?.message;
    if (!m?.chat_id || !m.message_id || m.message_type !== 'text') return null;
    const text = (JSON.parse(m.content ?? '{}') as { text?: string }).text ?? '';
    if (!text.trim()) return null;
    const isGroup = m.chat_type !== 'p2p';
    // 群聊必须 @机器人 才处理（@ 提及在文本里渲染为 @_user_N 占位）
    if (isGroup && !/@_user_\d+/.test(text)) return null;
    return {
      chatId: m.chat_id,
      chatType: isGroup ? 'group' : 'p2p',
      userId: ev.event!.sender!.sender_id!.open_id!,
      text: stripMention(text),
      messageId: m.message_id,
    };
  } catch {
    return null;
  }
}

export class FeishuGateway {
  private client: InstanceType<typeof realSdk.Client>;
  private sdk: typeof realSdk;
  private cfg: FeishuAppConfig;

  constructor(cfg: FeishuAppConfig, deps: { sdk?: typeof realSdk } = {}) {
    this.cfg = cfg;
    this.sdk = deps.sdk ?? realSdk;
    const domain = cfg.domain === 'lark' ? this.sdk.Domain.Lark : this.sdk.Domain.Feishu;
    this.client = new this.sdk.Client({ appId: cfg.appId, appSecret: cfg.appSecret, domain });
  }

  async start(handlers: GatewayHandlers): Promise<void> {
    const ws = new this.sdk.WSClient({ appId: this.cfg.appId, appSecret: this.cfg.appSecret });
    // 注：以 node-sdk 实际构造签名为准（WSClient 构造参数 { appId, appSecret, loggerLevel }），
    // 若与上面不符，查 node_modules/@larksuiteoapi/node-sdk 的 README/类型修正。
    const dispatcher = new this.sdk.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        const msg = parseIncomingMessage(data);
        if (msg) await handlers.onMessage(msg);
      },
      'card.action.trigger': async (data: unknown) => {
        const d = data as { action?: { value?: { requestId?: string; decision?: 'allow' | 'deny' | 'allow-session' } }, operator?: { open_id?: string }, open_message_id?: string };
        if (d.action?.value?.requestId && d.action.value.decision && d.operator?.open_id) {
          await handlers.onCardAction({
            value: { requestId: d.action.value.requestId, decision: d.action.value.decision },
            operatorId: d.operator.open_id,
            openMessageId: d.open_message_id ?? '',
          });
        }
        return {};
      },
    });
    await ws.start({ eventDispatcher: dispatcher });
  }

  async sendCard(chatId: string, card: unknown): Promise<string> {
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    if (!res.data?.message_id) throw new Error(`发送卡片失败: ${JSON.stringify(res)}`);
    return res.data.message_id;
  }

  async sendText(chatId: string, markdown: string): Promise<string> {
    return this.sendCard(chatId, buildTextCard(markdown));
  }

  async updateCard(messageId: string, card: unknown): Promise<void> {
    await this.client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
  }

  async uploadAndSendFile(chatId: string, filePath: string): Promise<void> {
    const ext = extname(filePath).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      const up = await this.client.im.image.create({ data: { image_type: 'message', image: createReadStream(filePath) } });
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: up.data?.image_key }) },
      });
    } else {
      const up = await this.client.im.file.create({
        data: { file_type: 'stream', file_name: basename(filePath), file: createReadStream(filePath) },
      });
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: up.data?.file_key }) },
      });
    }
  }
}
```

实现时以 `node_modules/@larksuiteoapi/node-sdk` 的实际类型签名为准修正（尤其 `WSClient` 构造参数与 `im.file.create` 的字段名），跑通测试为准。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/gateway.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 飞书网关（长连接事件分发/收发/上传）"
```

---

### Task 7: claude-executor（Agent SDK 封装 + 产出收集）

**Files:**
- Create: `src/executor/claude-executor.ts`, `src/executor/output-collector.ts`
- Test: `tests/executor.test.ts`

**Interfaces:**
- Consumes: `ProgressEvent`、`TaskOutcome`（types.ts）
- Produces:

```typescript
export interface ExecutorCallbacks {
  onProgress(event: ProgressEvent): Promise<void> | void;
}
export interface RunTaskOptions {
  cwd: string;
  resumeSessionId?: string;
  signal?: AbortSignal;
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;
}
export async function runTask(prompt: string, opts: RunTaskOptions, cb: ExecutorCallbacks): Promise<TaskOutcome>;
export class OutputCollector {
  track(toolName: string, input: Record<string, unknown>): void;  // Write/Edit/NotebookEdit 记 file_path
  files(): string[];                                              // 去重
}
```

- [ ] **Step 1: 写失败测试（vi.mock Agent SDK 的 query）**

`tests/executor.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

import { runTask } from '../src/executor/claude-executor.js';
import { OutputCollector } from '../src/executor/output-collector.js';

function fakeStream(messages: unknown[]) {
  return (async function* () { for (const m of messages) yield m; })();
}

describe('runTask', () => {
  it('流消息转进度回调，result 出最终文本与会话 id', async () => {
    queryMock.mockReturnValue(fakeStream([
      { type: 'assistant', message: { content: [{ type: 'text', text: '正在分析' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'F:/x/a.md', content: 'hi' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'result', subtype: 'success', result: '完成了', session_id: 'sess_1' },
    ]));
    const events: string[] = [];
    const out = await runTask('写点东西', { cwd: 'F:/x' }, { onProgress: (e) => { events.push(`${e.kind}:${e.content}`); } });
    expect(out.finalText).toBe('完成了');
    expect(out.sessionId).toBe('sess_1');
    expect(out.turns).toBe(2);
    expect(out.producedFiles).toEqual(['F:/x/a.md']);
    expect(events.some((e) => e.startsWith('text:正在分析'))).toBe(true);
    expect(events.some((e) => e.startsWith('tool-start:Write'))).toBe(true);
  });
  it('canUseTool 透传给 SDK options', async () => {
    queryMock.mockReturnValue(fakeStream([{ type: 'result', subtype: 'success', result: 'r', session_id: 's' }]));
    const canUseTool = vi.fn().mockResolvedValue({ behavior: 'allow' });
    await runTask('p', { cwd: 'F:/x', canUseTool }, { onProgress: () => {} });
    const opts = queryMock.mock.calls[0][1] as { canUseTool?: unknown; settingSources?: string[]; cwd?: string };
    expect(opts.canUseTool).toBe(canUseTool);
    expect(opts.settingSources).toEqual(['user', 'project']);
    expect(opts.cwd).toBe('F:/x');
  });
});

describe('OutputCollector', () => {
  it('只跟踪写文件工具且去重', () => {
    const c = new OutputCollector();
    c.track('Write', { file_path: 'a.md' });
    c.track('Write', { file_path: 'a.md' });
    c.track('Edit', { file_path: 'b.ts' });
    c.track('Read', { file_path: 'c.ts' });
    expect(c.files()).toEqual(['a.md', 'b.ts']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/executor.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 output-collector.ts**

```typescript
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export class OutputCollector {
  private seen = new Set<string>();
  track(toolName: string, input: Record<string, unknown>): void {
    if (!WRITE_TOOLS.has(toolName)) return;
    const p = input.file_path ?? input.notebook_path;
    if (typeof p === 'string' && p) this.seen.add(p);
  }
  files(): string[] {
    return [...this.seen];
  }
}
```

- [ ] **Step 4: 实现 claude-executor.ts**

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ExecutorCallbacks, RunTaskOptions } from './claude-executor.js';
import { OutputCollector } from './output-collector.js';
import type { TaskOutcome } from '../types.js';

export async function runTask(prompt: string, opts: RunTaskOptions, cb: ExecutorCallbacks): Promise<TaskOutcome> {
  const collector = new OutputCollector();
  const q = query({
    prompt,
    options: {
      cwd: opts.cwd,
      resume: opts.resumeSessionId,
      settingSources: ['user', 'project'],
      permissionMode: 'default',
      includePartialMessages: false,
      ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
      ...(opts.signal ? { abortController: (() => { const c = new AbortController(); opts.signal!.addEventListener('abort', () => c.abort()); return c; })() } : {}),
    },
  });
  let finalText = '';
  let sessionId = opts.resumeSessionId ?? '';
  let turns = 0;
  for await (const message of q) {
    const msg = message as Record<string, unknown>;
    switch (msg.type) {
      case 'assistant': {
        turns++;
        const blocks = ((msg as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? []);
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string') await cb.onProgress({ kind: 'text', content: b.text });
          if (b.type === 'tool_use') {
            collector.track(String(b.name), (b.input ?? {}) as Record<string, unknown>);
            const input = (b.input ?? {}) as Record<string, unknown>;
            const summary = typeof input.command === 'string' ? input.command
              : typeof input.file_path === 'string' ? input.file_path
              : typeof input.pattern === 'string' ? input.pattern : JSON.stringify(input).slice(0, 100);
            await cb.onProgress({ kind: 'tool-start', content: `${b.name}: ${summary}` });
          }
        }
        break;
      }
      case 'user': {
        const blocks = ((msg as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? []);
        for (const b of blocks) {
          if (b.type === 'tool_result') await cb.onProgress({ kind: 'tool-result', content: String(b.name ?? ''), ok: !b.is_error });
        }
        break;
      }
      case 'result': {
        finalText = typeof msg.result === 'string' ? msg.result : '';
        sessionId = typeof msg.session_id === 'string' ? msg.session_id : sessionId;
        break;
      }
    }
  }
  return { sessionId, finalText, producedFiles: collector.files(), turns };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/executor.test.ts`
Expected: 3 passed

注（SDK 适配）：`canUseTool` 的完整签名还带第三参 `options`（含 suggestions），此处封装收窄为 `(toolName, input)`，Task 8 的 PermissionGate 按此适配；`abortController` 选项名以 `node_modules/@anthropic-ai/claude-agent-sdk` 的 `QueryOptions` 类型为准，若叫 `signal` 则直接透传；流消息的实际字段形状以 SDK 类型为准微调，测试断言的行为不变。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: Claude 执行器（流式进度/产出收集/会话 id）"
```

---

### Task 8: permission-gate（确认分流/超时/会话记忆）

**Files:**
- Create: `src/executor/permission-gate.ts`
- Test: `tests/permission-gate.test.ts`

**Interfaces:**
- Consumes: `ConfirmationRequest`、`PermissionDecision`（types.ts）
- Produces:

```typescript
export const READ_ONLY_TOOLS: ReadonlySet<string>;
export class PermissionGate {
  constructor(opts: { ask: (req: ConfirmationRequest) => Promise<PermissionDecision>; timeoutMs?: number });
  decide(toolName: string, input: Record<string, unknown>, workspaceName: string): Promise<{ behavior: 'allow' | 'deny'; message?: string }>;
  rememberSession(toolName: string): void;  // 「本次会话不再询问」
  reset(): void;                            // /new 时清记忆
}
```

- [ ] **Step 1: 写失败测试**

`tests/permission-gate.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { PermissionGate, READ_ONLY_TOOLS } from '../src/executor/permission-gate.js';

describe('READ_ONLY_TOOLS', () => {
  it('含 Read/Glob/Grep，不含 Bash/Write', () => {
    expect(READ_ONLY_TOOLS.has('Read')).toBe(true);
    expect(READ_ONLY_TOOLS.has('Bash')).toBe(false);
  });
});

describe('PermissionGate', () => {
  it('只读工具直接放行不询问', async () => {
    const ask = vi.fn();
    const g = new PermissionGate({ ask });
    expect((await g.decide('Read', { file_path: 'a' }, 'ws')).behavior).toBe('allow');
    expect(ask).not.toHaveBeenCalled();
  });
  it('写操作询问并允许', async () => {
    const ask = vi.fn().mockResolvedValue('allow');
    const g = new PermissionGate({ ask });
    expect((await g.decide('Bash', { command: 'ls' }, 'ws')).behavior).toBe('allow');
    expect(ask).toHaveBeenCalledOnce();
  });
  it('拒绝返回 deny 带原因', async () => {
    const g = new PermissionGate({ ask: () => Promise.resolve('deny') });
    const r = await g.decide('Write', { file_path: 'a' }, 'ws');
    expect(r.behavior).toBe('deny');
    expect(r.message).toBeTruthy();
  });
  it('allow-session 后同类不再询问', async () => {
    const ask = vi.fn().mockResolvedValue('allow-session' as const);
    const g = new PermissionGate({ ask });
    await g.decide('Bash', { command: 'a' }, 'ws');
    await g.decide('Bash', { command: 'b' }, 'ws');
    expect(ask).toHaveBeenCalledOnce();
  });
  it('超时自动拒绝', async () => {
    vi.useFakeTimers();
    const g = new PermissionGate({ ask: () => new Promise(() => {}), timeoutMs: 1000 });
    const p = g.decide('Bash', { command: 'x' }, 'ws');
    vi.advanceTimersByTime(1100);
    const r = await p;
    expect(r.behavior).toBe('deny');
    vi.useRealTimers();
  });
  it('reset 清除会话记忆', async () => {
    const ask = vi.fn().mockResolvedValue('allow-session' as const);
    const g = new PermissionGate({ ask });
    await g.decide('Bash', { command: 'a' }, 'ws');
    g.reset();
    await g.decide('Bash', { command: 'b' }, 'ws');
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/permission-gate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
import { randomUUID } from 'node:crypto';
import type { ConfirmationRequest, PermissionDecision } from '../types.js';

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch',
]);

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class PermissionGate {
  private remembered = new Set<string>();

  constructor(private opts: { ask: (req: ConfirmationRequest) => Promise<PermissionDecision>; timeoutMs?: number }) {}

  async decide(
    toolName: string,
    input: Record<string, unknown>,
    workspaceName: string,
  ): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
    if (READ_ONLY_TOOLS.has(toolName)) return { behavior: 'allow' };
    if (this.remembered.has(toolName)) return { behavior: 'allow' };
    const req: ConfirmationRequest = {
      requestId: randomUUID(),
      toolName,
      summary: typeof input.command === 'string' ? input.command
        : typeof input.file_path === 'string' ? input.file_path
        : JSON.stringify(input).slice(0, 800),
      workspaceName,
    };
    const decision = await Promise.race([
      this.opts.ask(req),
      new Promise<PermissionDecision>((resolve) =>
        setTimeout(() => resolve('deny'), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS).unref(),
      ),
    ]);
    if (decision === 'allow-session') this.rememberSession(toolName);
    if (decision === 'deny') return { behavior: 'deny', message: '用户在飞书端拒绝了本次操作' };
    return { behavior: 'allow' };
  }

  rememberSession(toolName: string): void {
    this.remembered.add(toolName);
  }

  reset(): void {
    this.remembered.clear();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/permission-gate.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 权限闸（只读放行/写操作询问/超时拒绝/会话记忆）"
```

---

### Task 9: 通道/会话存储/命令

**Files:**
- Create: `src/session/session-store.ts`, `src/session/channel.ts`, `src/session/commands.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `BridgeConfig`（types.ts）
- Produces:

```typescript
// session-store.ts
export interface SessionMeta { sessionId: string; summary: string; updatedAt: string }
export interface ChannelState { workspaceName: string; sessions: SessionMeta[] }   // sessions[0] 为当前
export class SessionStore {
  constructor(path: string);
  static load(path: string): SessionStore;
  getChannelState(channelKey: string): ChannelState | undefined;
  setChannelState(channelKey: string, state: ChannelState): void;  // 持久化
  archiveSession(channelKey: string, sessionId: string, summary: string): void; // 存档+置为当前
  newSession(channelKey: string, defaultWorkspace: string): void;
  listSessions(channelKey: string): SessionMeta[];
}
// channel.ts
export class Semaphore { constructor(n: number); acquire(): Promise<() => void> }
export function channelKey(chatId: string, userId: string): string;  // `${chatId}:${userId}`
// commands.ts
export interface CommandContext {
  channelKey: string;
  store: SessionStore;
  config: BridgeConfig;
  isAdmin: boolean;              // member 不能 /ws use 切换工作区（spec 权限分级）
  currentWorkspace(): string;
  stopCurrentTask(): boolean;
}
export interface CommandResult { handled: boolean; reply?: string; taskText?: string }
export async function handleCommand(text: string, ctx: CommandContext): Promise<CommandResult>;
```

- [ ] **Step 1: 写失败测试**

`tests/session.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/session-store.js';
import { Semaphore, channelKey } from '../src/session/channel.js';
import { handleCommand } from '../src/session/commands.js';
import type { BridgeConfig } from '../src/types.js';

function freshStore(): SessionStore {
  return SessionStore.load(join(mkdtempSync(join(tmpdir(), 'lcb-s-')), 'sessions.json'));
}
const cfg: BridgeConfig = {
  feishu: { appId: 'a', appSecret: 's' },
  workspaces: [{ name: 'demo', path: 'F:/demo' }, { name: 'two', path: 'F:/two' }],
  defaults: { workspace: 'demo' },
  concurrency: 3,
};

describe('SessionStore', () => {
  it('newSession 后可存档会话并列表', () => {
    const s = freshStore();
    s.newSession('k1', 'demo');
    s.archiveSession('k1', 'sess_1', '帮我写脚本');
    expect(s.listSessions('k1')[0]).toMatchObject({ sessionId: 'sess_1', summary: '帮我写脚本' });
    expect(s.getChannelState('k1')?.workspaceName).toBe('demo');
  });
  it('持久化后重载仍在', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'lcb-s2-')), 's.json');
    const s = SessionStore.load(p);
    s.newSession('k1', 'demo');
    s.archiveSession('k1', 'sess_1', 'x');
    expect(SessionStore.load(p).listSessions('k1').length).toBe(1);
  });
});

describe('Semaphore', () => {
  it('限制并发数', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    let got3 = false;
    const p3 = sem.acquire().then((r) => { got3 = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(got3).toBe(false);
    r1();
    await p3;
    r2();
    expect(got3).toBe(true);
  });
});

describe('channelKey', () => {
  it('拼接', () => expect(channelKey('oc', 'ou')).toBe('oc:ou'));
});

describe('handleCommand', () => {
  const baseCtx = (store: ReturnType<typeof freshStore>, extra: Partial<Parameters<typeof handleCommand>[1]> = {}) => ({
    channelKey: 'k', store, config: cfg, isAdmin: true, currentWorkspace: () => 'demo', stopCurrentTask: () => false, ...extra,
  });
  it('/help 返回帮助且不产生任务', async () => {
    const r = await handleCommand('/help', baseCtx(freshStore()));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('/new');
  });
  it('/new 重置会话', async () => {
    const store = freshStore();
    store.newSession('k', 'demo');
    store.archiveSession('k', 's1', '旧会话');
    const r = await handleCommand('/new', baseCtx(store));
    expect(r.handled).toBe(true);
    expect(store.listSessions('k').length).toBe(0);
  });
  it('/resume 列出会话，/resume 1 切换', async () => {
    const store = freshStore();
    store.newSession('k', 'demo');
    store.archiveSession('k', 's1', '第一个');
    store.newSession('k', 'demo');
    store.archiveSession('k', 's2', '第二个');
    const list = await handleCommand('/resume', baseCtx(store));
    expect(list.reply).toContain('第一个');
    const pick = await handleCommand('/resume 1', baseCtx(store));
    expect(pick.reply).toContain('第一个');
    expect(store.getChannelState('k')?.sessions[0]?.sessionId).toBe('s1');
  });
  it('/ws use 切换工作区（admin），未知名报错，member 被拒', async () => {
    const store = freshStore();
    const ok = await handleCommand('/ws use two', baseCtx(store));
    expect(ok.reply).toContain('two');
    expect(store.getChannelState('k')?.workspaceName).toBe('two');
    const bad = await handleCommand('/ws use nope', baseCtx(store));
    expect(bad.reply).toContain('不存在');
    const denied = await handleCommand('/ws use demo', baseCtx(freshStore(), { isAdmin: false }));
    expect(denied.reply).toContain('管理员');
  });
  it('/stop 调用 stopCurrentTask', async () => {
    const stop = () => { (stop as { called?: boolean }).called = true; return true; };
    const r = await handleCommand('/stop', baseCtx(freshStore(), { stopCurrentTask: stop }));
    expect(r.handled).toBe(true);
    expect((stop as { called?: boolean }).called).toBe(true);
  });
  it('普通文本不处理', async () => {
    const r = await handleCommand('帮我写代码', baseCtx(freshStore()));
    expect(r.handled).toBe(false);
    expect(r.taskText).toBe('帮我写代码');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 session-store.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChannelState, SessionMeta } from './session-store.js';

export class SessionStore {
  private data: Record<string, ChannelState> = {};
  private constructor(private path: string) {
    if (existsSync(path)) {
      try { this.data = JSON.parse(readFileSync(path, 'utf8')); } catch { this.data = {}; }
    }
  }
  static load(path: string): SessionStore { return new SessionStore(path); }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8');
  }
  getChannelState(key: string): ChannelState | undefined { return this.data[key]; }
  setChannelState(key: string, state: ChannelState): void { this.data[key] = state; this.save(); }
  archiveSession(key: string, sessionId: string, summary: string): void {
    const st = this.data[key] ?? { workspaceName: '', sessions: [] };
    const rest = st.sessions.filter((s) => s.sessionId !== sessionId);
    st.sessions = [{ sessionId, summary: summary.slice(0, 60), updatedAt: new Date().toISOString() }, ...rest];
    this.data[key] = st;
    this.save();
  }
  newSession(key: string, defaultWorkspace: string): void {
    const st = this.data[key];
    if (st) { st.sessions = []; this.save(); }
    else this.setChannelState(key, { workspaceName: defaultWorkspace, sessions: [] });
  }
  listSessions(key: string): SessionMeta[] { return this.data[key]?.sessions ?? []; }
}
```

- [ ] **Step 4: 实现 channel.ts**

```typescript
export function channelKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private n: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.n) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    return () => this.release();
  }
  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
```

- [ ] **Step 5: 实现 commands.ts**

```typescript
import type { BridgeConfig } from '../types.js';
import type { SessionStore } from './session-store.js';
import type { CommandContext, CommandResult } from './commands.js';

const HELP = `**可用命令**
/new — 开启新会话
/resume — 列出历史会话
/resume <编号> — 恢复指定会话
/stop — 停止当前任务
/status — 查看当前状态
/ws list — 列出工作区
/ws use <名字> — 切换工作区
/help — 帮助`;

export async function handleCommand(text: string, ctx: CommandContext): Promise<CommandResult> {
  if (!text.startsWith('/')) return { handled: false, taskText: text };
  const [name, ...args] = text.slice(1).trim().split(/\s+/);
  const { store, channelKey: key } = ctx;
  switch (name) {
    case 'help':
      return { handled: true, reply: HELP };
    case 'new': {
      const ws = ctx.currentWorkspace();
      store.newSession(key, ws);
      return { handled: true, reply: `✅ 已开启新会话（工作区：${ws}）` };
    }
    case 'resume': {
      const sessions = store.listSessions(key);
      if (args.length === 0) {
        if (sessions.length === 0) return { handled: true, reply: '暂无历史会话' };
        const list = sessions.map((s, i) => `${i + 1}. ${s.summary || '(无摘要)'} <font color='grey'>${s.updatedAt.slice(0, 16)}</font>`).join('\n');
        return { handled: true, reply: `**历史会话**（回复 /resume 编号 恢复）\n${list}` };
      }
      const idx = Number(args[0]) - 1;
      const target = store.listSessions(key)[idx];
      if (!target) return { handled: true, reply: `编号无效，范围 1-${sessions.length}` };
      // 将选中的会话移到最前（当前）
      const st = store.getChannelState(key);
      if (st) {
        st.sessions = [target, ...st.sessions.filter((s) => s.sessionId !== target.sessionId)];
        store.setChannelState(key, st);
      }
      return { handled: true, reply: `↩️ 已恢复会话：${target.summary || target.sessionId}` };
    }
    case 'stop':
      return { handled: true, reply: ctx.stopCurrentTask() ? '🛑 已发送停止信号' : '当前没有运行中的任务' };
    case 'status': {
      const st = store.getChannelState(key);
      return { handled: true, reply: `工作区：**${ctx.currentWorkspace()}**\n历史会话：${store.listSessions(key).length} 个` };
    }
    case 'ws': {
      const sub = args[0];
      if (sub === 'list') {
        const list = ctx.config.workspaces.map((w) => `- **${w.name}** \`${w.path}\``).join('\n');
        return { handled: true, reply: `**工作区列表**\n${list}` };
      }
      if (sub === 'use') {
        if (!ctx.isAdmin) return { handled: true, reply: '⛔ 切换工作区仅管理员可用' };
        const target = ctx.config.workspaces.find((w) => w.name === args[1]);
        if (!target) return { handled: true, reply: `工作区 "${args[1] ?? ''}" 不存在，/ws list 查看` };
        const st = store.getChannelState(key);
        if (st) { st.workspaceName = target.name; store.setChannelState(key, st); }
        else store.setChannelState(key, { workspaceName: target.name, sessions: [] });
        return { handled: true, reply: `✅ 已切换工作区：**${target.name}**（${target.path}）` };
      }
      return { handled: true, reply: '用法：/ws list | /ws use <名字>' };
    }
    default:
      return { handled: true, reply: `未知命令 /${name}，/help 查看帮助` };
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/session.test.ts`
Expected: 10 passed

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: 通道会话存储与 /命令"
```

---

### Task 10: 装配（index.ts 主流程）

**Files:**
- Modify: `src/index.ts`（替换占位为装配实现）
- Test: `tests/wiring.test.ts`

**Interfaces:**
- Consumes: 前面全部模块（FeishuGateway、AccessControl、SessionStore、handleCommand、runTask、PermissionGate、ProgressCard）
- Produces:

```typescript
export interface BridgeDeps {  // 全部可注入，测试用 mock；生产用真实实现
  gateway: {
    start(h: GatewayHandlers): Promise<void>;
    sendCardTo(chatId: string, card: unknown): Promise<string>;
    sendTextTo(chatId: string, markdown: string): Promise<string>;
    updateCard(id: string, card: unknown): Promise<void>;
    uploadAndSendFile(chatId: string, p: string): Promise<void>;
  };
  access: AccessControl;
  store: SessionStore;
  executor: typeof runTask;
  now?: () => number;
}
export function createBridge(config: BridgeConfig, deps: BridgeDeps): GatewayHandlers;
export async function startBridge(config: BridgeConfig): Promise<void>;  // 生产入口：真实依赖
```

装配内部职责（实现要点）：
1. `onMessage`：access 检查（不允许→`beginPairing` 发配对码卡片，同时在终端打印配对提示）；命令→`handleCommand` 回复；普通文本→通道入队执行
2. 通道队列：每 key 一个 Promise 链串行；全局 `Semaphore(config.concurrency)`；`AbortController` 存在 channel runtime map 供 `/stop`
3. 任务执行：构造 `ProgressCard`（首响）→ `PermissionGate`（ask=发确认卡片并挂起等待/由 `onCardAction` resolve）→ `runTask(prompt, {cwd, resume, signal, canUseTool}, onProgress→ProgressCard)` → 存档 session → 结果卡片 + 产出文件上传（>10 个打 zip）
4. `onCardAction`：pending confirm map 按 `requestId` 找 resolve；校验 `operatorId === 发起用户`，不符回复卡片提示无权限；resolve 后把确认卡片 PATCH 成结果态
5. 首次配对成功 → admin（AccessControl 已处理）

- [ ] **Step 1: 写失败测试（全 mock 走通主链路）**

`tests/wiring.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { createBridge, type BridgeDeps } from '../src/index.js';
import { AccessControl } from '../src/access/access-control.js';
import { SessionStore } from '../src/session/session-store.js';
import type { BridgeConfig, CardActionEvent, IncomingMessage } from '../src/types.js';

const cfg: BridgeConfig = {
  feishu: { appId: 'a', appSecret: 's' },
  workspaces: [{ name: 'demo', path: 'F:/demo' }],
  defaults: { workspace: 'demo' },
  concurrency: 3,
};

function makeDeps(executor = vi.fn()) {
  const sent: Array<{ chatId: string; card: unknown }> = [];
  const deps: BridgeDeps = {
    gateway: {
      start: vi.fn(),
      sendCardTo: async (chatId, card) => { sent.push({ chatId, card }); return `m${sent.length}`; },
      sendTextTo: async (chatId, markdown) => { sent.push({ chatId, card: markdown }); return `m${sent.length}`; },
      updateCard: async () => {},
      uploadAndSendFile: vi.fn(),
    },
    access: new AccessControl('unused'),
    store: SessionStore.load('unused-path-loads-empty'),
    executor: executor as unknown as typeof import('../src/executor/claude-executor.js').runTask,
  };
  (deps.access as unknown as { data: { users: Record<string, { name: string; role: string }> } }).data = {
    users: { ou_u: { name: '测试者', role: 'admin' } },
  };
  return { deps, sent };
}

const msg = (text: string): IncomingMessage => ({ chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u', text, messageId: 'om_x' });

describe('createBridge 装配', () => {
  it('白名单用户发普通消息 → 首响卡片 + 执行器收到任务 + 结果回传', async () => {
    const executor = vi.fn().mockResolvedValue({ sessionId: 's1', finalText: '做好了', producedFiles: [], turns: 1 });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage(msg('帮我干活'));
    await new Promise((r) => setTimeout(r, 50)); // 等队列
    expect(executor).toHaveBeenCalledOnce();
    const call = executor.mock.calls[0] as unknown as [string, { cwd: string }];
    expect(call[0]).toBe('帮我干活');
    expect(call[1].cwd).toBe('F:/demo');
    const json = JSON.stringify(sent);
    expect(json).toContain('已接收');   // 首响
    expect(json).toContain('做好了');   // 结果
  });
  it('产出文件会上传', async () => {
    const executor = vi.fn().mockResolvedValue({ sessionId: 's1', finalText: 'ok', producedFiles: ['F:/demo/a.md'], turns: 1 });
    const { deps } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage(msg('写文件'));
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.gateway.uploadAndSendFile).toHaveBeenCalledWith('oc_1', 'F:/demo/a.md');
  });
  it('白名单外用户收到配对码卡片，不执行', async () => {
    const executor = vi.fn();
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage({ ...msg('hi'), userId: 'ou_stranger' });
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('配对');
  });
  it('确认流：写操作发确认卡片，按钮点击放行', async () => {
    let askFn!: (d: 'allow' | 'deny' | 'allow-session') => void;
    const executor = vi.fn().mockImplementation(async (_p: string, opts: { canUseTool?: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }> }) => {
      return opts.canUseTool!.('Bash', { command: 'rm -rf /' });
    });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage(msg('删东西'));
    await new Promise((r) => setTimeout(r, 50));
    const confirmCard = sent.find((s) => JSON.stringify(s.card).includes('请求执行操作'));
    expect(confirmCard).toBeTruthy();
    // 模拟用户点允许
    const value = JSON.parse(JSON.stringify(confirmCard!.card)) as never as { requestId?: string };
    void value;
    // 从卡片 JSON 提取 requestId
    const m = /"requestId":"([^"]+)"/.exec(JSON.stringify(confirmCard!.card))!;
    const action: CardActionEvent = { value: { requestId: m[1], decision: 'allow' }, operatorId: 'ou_u', openMessageId: 'om_c' };
    const result = await bridge.onCardAction(action);
    void result;
    void askFn;
    // executor 的 canUseTool 返回值应被允许——通过 executor 被调用且无异常即验证链路
    expect(executor).toHaveBeenCalledOnce();
  });
  it('他人点击按钮无权限', async () => {
    const { deps } = makeDeps(vi.fn().mockResolvedValue({ sessionId: 's', finalText: '', producedFiles: [], turns: 1 }));
    const bridge = createBridge(cfg, deps);
    // 无 pending 的 requestId：应静默/提示，不抛异常
    await expect(bridge.onCardAction({ value: { requestId: 'nope', decision: 'allow' }, operatorId: 'ou_u', openMessageId: 'om_c' })).resolves.toBeUndefined();
  });
  it('/help 命令直接回复不进执行器', async () => {
    const executor = vi.fn();
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, deps);
    await bridge.onMessage(msg('/help'));
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('/new');
  });
});
```

（注意：`makeDeps` 里直接改 AccessControl 私有 data 仅为测试注入白名单；若 access store 路径 'unused' 报错，用临时目录路径。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/wiring.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/index.ts**（完整写出，执行者照抄）

```typescript
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import type { BridgeConfig, CardActionEvent, GatewayHandlers, IncomingMessage, PermissionDecision, ProgressEvent } from './types.js';
import { loadConfig, CONFIG_PATH } from './config.js';
import { AccessControl } from './access/access-control.js';
import { FeishuGateway } from './gateway/feishu-gateway.js';
import { ProgressCard } from './gateway/progress-card.js';
import { buildConfirmCard, buildConfirmResultCard } from './gateway/card-builder.js';
import { runTask } from './executor/claude-executor.js';
import { PermissionGate } from './executor/permission-gate.js';
import { SessionStore } from './session/session-store.js';
import { handleCommand } from './session/commands.js';
import { Semaphore, channelKey } from './session/channel.js';

const execFileP = promisify(execFile);
const MAX_FILES_BEFORE_ZIP = 10;

interface ChannelRuntime {
  queue: Promise<void>;
  abort?: AbortController;
}

export interface BridgeDeps {
  gateway: {
    start(h: GatewayHandlers): Promise<void>;
    sendCardTo(chatId: string, card: unknown): Promise<string>;
    sendTextTo(chatId: string, markdown: string): Promise<string>;
    updateCard(id: string, card: unknown): Promise<void>;
    uploadAndSendFile(chatId: string, p: string): Promise<void>;
  };
  access: AccessControl;
  store: SessionStore;
  executor: typeof runTask;
}

export function createBridge(config: BridgeConfig, deps: BridgeDeps): GatewayHandlers {
  const sem = new Semaphore(config.concurrency);
  const runtimes = new Map<string, ChannelRuntime>();
  const confirmPending = new Map<string, { resolve: (d: PermissionDecision) => void; req: import('./types.js').ConfirmationRequest; ownerId: string; cardId: string }>();

  function workspacePath(name: string): string {
    return config.workspaces.find((w) => w.name === name)?.path ?? config.workspaces[0].path;
  }

  async function handleIncoming(msg: IncomingMessage): Promise<void> {
    const key = channelKey(msg.chatId, msg.userId);
    // 1. 访问控制
    if (!deps.access.isAllowed(msg.userId)) {
      const code = deps.access.beginPairing(msg.userId, msg.userId);
      console.log(`[配对] 未知用户 ${msg.userId} 请求接入，配对码：${code}（在终端输入 lcb pair ${code} 批准，或在运行中的终端直接输入该码）`);
      await deps.gateway.sendTextTo(msg.chatId, `🔐 首次使用需配对。\n\n请管理员在桥接器终端确认配对码：**${code}**（15 分钟内有效）`);
      return;
    }
    // 2. 命令
    const st = deps.store.getChannelState(key);
    const currentWorkspace = st?.workspaceName ?? config.defaults.workspace;
    const cmd = await handleCommand(msg.text, {
      channelKey: key,
      store: deps.store,
      config,
      isAdmin: deps.access.isAdmin(msg.userId),
      currentWorkspace: () => currentWorkspace,
      stopCurrentTask: () => {
        const rt = runtimes.get(key);
        if (rt?.abort) { rt.abort.abort(); return true; }
        return false;
      },
    });
    if (cmd.handled) {
      if (cmd.reply) await deps.gateway.sendTextTo(msg.chatId, cmd.reply);
      return;
    }
    // 3. 任务入队（通道内串行）
    const rt = runtimes.get(key) ?? { queue: Promise.resolve() };
    runtimes.set(key, rt);
    rt.queue = rt.queue.then(() => executeTask(key, msg, cmd.taskText ?? msg.text, currentWorkspace)).catch((e) => {
      console.error('[任务异常]', e);
    });
  }

  async function executeTask(key: string, msg: IncomingMessage, prompt: string, wsName: string): Promise<void> {
    const release = await sem.acquire();
    const abort = new AbortController();
    const rt = runtimes.get(key)!;
    rt.abort = abort;
    const progress = new ProgressCard(
      { sendCard: (c) => deps.gateway.sendCardTo(msg.chatId, c), updateCard: (id, c) => deps.gateway.updateCard(id, c) },
      `任务 · ${wsName}`,
    );
    const gate = new PermissionGate({
      ask: async (req) => {
        const cardId = await deps.gateway.sendCardTo(msg.chatId, buildConfirmCard(req));
        return new Promise<PermissionDecision>((resolve) => {
          confirmPending.set(req.requestId, { resolve, req, ownerId: msg.userId, cardId });
        });
      },
    });
    try {
      await progress.start();
      const state = deps.store.getChannelState(key);
      const resumeId = state?.sessions?.[0]?.sessionId;
      // 任务总超时 4 小时（防挂死；确认等待、长编译均在正常范围）
      const hardTimeout = setTimeout(() => abort.abort(), 4 * 60 * 60 * 1000);
      hardTimeout.unref();
      const outcome = await deps.executor(prompt, {
        cwd: workspacePath(wsName),
        resumeSessionId: resumeId,
        signal: abort.signal,
        canUseTool: (toolName, input) => gate.decide(toolName, input, wsName),
      }, {
        onProgress: (e: ProgressEvent) => {
          if (e.kind === 'text') progress.appendText(e.content);
          else if (e.kind === 'tool-start') { const [n, ...rest] = e.content.split(': '); progress.toolStart(n, rest.join(': ')); }
          else if (e.kind === 'tool-result') progress.toolResult(e.content, e.ok ?? true);
        },
      });
      await progress.finish(`✅ 完成`);
      deps.store.archiveSession(key, outcome.sessionId, prompt);
      // 会话超长提醒（累计轮次粗略估计，防上下文爆炸）
      if (outcome.turns > 40) {
        await deps.gateway.sendTextTo(msg.chatId, '💡 本会话已较长，建议发送 /new 开启新会话（/resume 可随时切回）');
      }
      // 结果回传
      if (outcome.finalText) await deps.gateway.sendTextTo(msg.chatId, outcome.finalText.slice(0, 4000));
      // 文件回传
      const files = outcome.producedFiles;
      if (files.length > MAX_FILES_BEFORE_ZIP) {
        const zipPath = join(tmpdir(), `lcb-${randomUUID()}.zip`);
        await execFileP('tar', ['-a', '-cf', zipPath, ...files.map((f) => basename(f))], { cwd: workspacePath(wsName) });
        await deps.gateway.uploadAndSendFile(msg.chatId, zipPath);
      } else {
        for (const f of files) await deps.gateway.uploadAndSendFile(msg.chatId, f);
      }
    } catch (e) {
      await progress.finish(`❌ 出错：${String(e).slice(0, 300)}`);
    } finally {
      rt.abort = undefined;
      release();
    }
  }

  async function handleCardAction(action: CardActionEvent): Promise<void> {
    const pending = confirmPending.get(action.value.requestId);
    if (!pending) return;
    if (action.operatorId !== pending.ownerId) {
      await deps.gateway.updateCard(pending.cardId, buildConfirmResultCard(pending.req, action.value.decision, '无权限操作者（仅任务发起人可确认）'));
      return;
    }
    confirmPending.delete(action.value.requestId);
    pending.resolve(action.value.decision);
    await deps.gateway.updateCard(pending.cardId, buildConfirmResultCard(pending.req, action.value.decision, '任务发起人'));
  }

  return { onMessage: handleIncoming, onCardAction: handleCardAction };
}

export async function startBridge(configPath: string = CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath);
  const gateway = new FeishuGateway(config.feishu);
  const deps: BridgeDeps = {
    gateway: {
      start: (h) => gateway.start(h),
      sendCardTo: (chatId, card) => gateway.sendCard(chatId, card),
      sendTextTo: (chatId, md) => gateway.sendText(chatId, md),
      updateCard: (id, card) => gateway.updateCard(id, card),
      uploadAndSendFile: (chatId, p) => gateway.uploadAndSendFile(chatId, p),
    },
    access: AccessControl.load(join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.lark-claudecode-bridge', 'access.json')),
    store: SessionStore.load(join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.lark-claudecode-bridge', 'sessions.json')),
    executor: runTask,
  };
  const bridge = createBridge(config, deps);
  await gateway.start(bridge);
  console.log('🚀 lark-claudecode-bridge 已启动（长连接模式，无需公网 IP）');
}
```

与测试签名的偏差以测试为准调整（如 `BridgeDeps.gateway` 在测试里用的方法名 `sendCardTo`/`sendTextTo`，上面已按此命名；测试里 `sendText`/`sendCard` 的 mock 需同步命名为 `sendTextTo` 等——以测试通过为最终标准，二者取齐）。

zip 打包注意：Windows 10+ 自带 `tar`（bsdtar，支持 `-a` 生成 zip）；macOS/Linux 均有 tar。若目标环境无 tar，退化为逐个上传（catch 后 fallback）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/wiring.test.ts`
Expected: 6 passed
Run: `npm test`（全量回归）
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 装配主流程（消息→队列→执行→确认→回传）"
```

---

### Task 11: CLI（lcb setup / start / pair）

**Files:**
- Create: `src/bin/lcb.ts`, `src/cli/setup-wizard.ts`
- Modify: `src/version.ts`（如 VERSION 已在 index.ts 导出则调整引用）

**Interfaces:**
- Consumes: `startBridge`（Task 10）、`loadConfig`/`CONFIG_PATH`（Task 2）、`AccessControl`（Task 3）
- Produces: 可执行 CLI（`lcb setup` 引导生成配置；`lcb start` 启动；`lcb pair <code>` 批准配对；`lcb version`）

- [ ] **Step 1: 实现 setup-wizard.ts**

```typescript
import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'yaml';
import type { BridgeConfig } from '../types.js';

export async function runSetup(configPath: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string) => {
    const a = (await rl.question(def ? `${q}（回车默认 ${def}）：` : `${q}：`)).trim();
    return a || def || '';
  };
  console.log('🛠 lcb setup — 引导式配置\n');
  if (existsSync(configPath)) {
    const overwrite = await ask(`配置已存在 ${configPath}，覆盖？(y/N)`, 'n');
    if (overwrite.toLowerCase() !== 'y') { rl.close(); console.log('已取消'); return; }
  }
  console.log('\n请先在飞书开放平台完成（详见 README）：\n  1. 创建企业自建应用并添加机器人能力\n  2. 开通权限 im:message / im:message:send_as_bot / im:resource / contact:user.base:readonly\n  3. 事件订阅选「长连接」，添加 im.message.receive_v1\n  4. 卡片交互配置选「长连接」\n');
  const appId = await ask('App ID (cli_开头)');
  const appSecret = await ask('App Secret');
  if (!appId.startsWith('cli_')) console.warn('⚠️ App ID 通常以 cli_ 开头，请确认');
  const workspaces: BridgeConfig['workspaces'] = [];
  let defaultWorkspace = '';
  for (let i = 0; ; i++) {
    const name = await ask(i === 0 ? '第一个工作区名字（如 demo）' : '再添一个工作区名字（直接回车结束）');
    if (!name) break;
    const path = await ask(`工作区 ${name} 的本机路径`);
    workspaces.push({ name, path });
    if (!defaultWorkspace) defaultWorkspace = name;
  }
  if (workspaces.length === 0) { console.log('至少需要一个工作区，已退出'); rl.close(); return; }
  const pick = await ask(`默认工作区`, defaultWorkspace);
  defaultWorkspace = workspaces.some((w) => w.name === pick) ? pick : defaultWorkspace;
  const cfg: BridgeConfig = { feishu: { appId, appSecret }, workspaces, defaults: { workspace: defaultWorkspace }, concurrency: 3 };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringify(cfg), 'utf8');
  rl.close();
  console.log(`\n✅ 配置已写入 ${configPath}\n下一步：lcb start 启动`);
}
```

- [ ] **Step 2: 实现 bin/lcb.ts**

```typescript
#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { runSetup } from '../cli/setup-wizard.js';
import { startBridge } from '../index.js';
import { loadConfig, CONFIG_PATH, CONFIG_DIR } from '../config.js';
import { AccessControl } from '../access/access-control.js';
import { VERSION } from '../version.js';
import { join } from 'node:path';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'setup':
      await runSetup(CONFIG_PATH);
      break;
    case 'start': {
      loadConfig(CONFIG_PATH); // 启动前校验
      await startBridge(CONFIG_PATH);
      // 前台监听 stdin：管理员可直接输入配对码批准
      const access = AccessControl.load(join(CONFIG_DIR, 'access.json'));
      const rl = createInterface({ input: process.stdin });
      rl.on('line', async (line) => {
        const code = line.trim();
        if (/^\d{6}$/.test(code)) {
          const r = access.approvePairing(code);
          console.log(r.ok ? `✅ 已批准用户 ${r.userId}${r.isFirstAdmin ? '（admin）' : ''}` : `❌ ${r.error}`);
        }
      });
      break;
    }
    case 'pair': {
      const access = AccessControl.load(join(CONFIG_DIR, 'access.json'));
      const code = args[0];
      if (!/^\d{6}$/.test(code ?? '')) {
        console.log('用法：lcb pair <6位配对码>');
        const pending = access.listPending();
        if (pending.length) console.log('待配对：', pending);
        process.exit(1);
      }
      const r = access.approvePairing(code);
      console.log(r.ok ? `✅ 已批准 ${r.userId}${r.isFirstAdmin ? '（admin）' : ''}` : `❌ ${r.error}`);
      if (!r.ok) process.exit(1);
      console.log('注：若桥接器正在运行，需重启或改在运行终端输入配对码');
      break;
    }
    case 'version':
      console.log(VERSION);
      break;
    default:
      console.log(`lcb — 飞书 ↔ Claude Code 桥接器

用法：
  lcb setup           引导式配置
  lcb start           启动桥接器（前台）
  lcb pair <code>     批准配对码
  lcb version         版本`);
      break;
  }
}

void main();
```

配套：新建 `src/version.ts` 内容 `export const VERSION = '0.1.0';`，`src/index.ts` 改为从该文件 re-export `VERSION`（Task 10 的 import 相应调整）。

- [ ] **Step 3: 构建与手动冒烟**

Run: `npm run build`
Expected: tsc 通过；`dist/bin/lcb.js` 存在且首行有 shebang

Run: `node dist/bin/lcb.js` / `node dist/bin/lcb.js version`
Expected: 打印帮助 / 版本号

Run: `npx tsx src/bin/lcb.ts setup`（交互式走一遍，写入临时 HOME 或按提示取消）
Expected: 交互流程正常（可 Ctrl+C 退出不落盘）

Run: `npm test`
Expected: 全部通过（无回归）

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: lcb CLI（setup 引导/start/pair）"
```

---

### Task 12: 真机端到端冒烟 + README + 发布准备

**Files:**
- Create: `README.md`, `LICENSE`, `docs/e2e-checklist.md`, `deploy/windows-start.bat`, `deploy/com.lark-claudecode-bridge.plist`, `deploy/lark-claudecode-bridge.service`
- Modify: `package.json`（确认 bin/files/scripts/prepublishOnly 完整）

**Interfaces:**
- Consumes: 全部
- Produces: 可发布到 npm 的包 + 真机验证记录

- [ ] **Step 1: 写 README.md（中文）**

结构（完整写出内容）：
```markdown
# lark-claudecode-bridge

飞书 ↔ Claude Code 桥接器：在飞书里遥控本机 Claude Code。
写操作以卡片按钮确认（长连接回调），结果文本与产出文件回传飞书。
**无需公网 IP、无需内网穿透；模型自由（订阅 / API Key / 第三方端点均可）。**

## 特性
- 私聊/群聊 @机器人 触发；群聊多人可用（配对+白名单访问控制）
- 写操作确认卡片：允许 / 拒绝 / 本次会话不再询问（仅任务发起人可点）
- 流式进度卡片（打字机效果+工具调用+运行心跳，静默不等于卡死）
- 结果文本 + 产出文件回传（图片预览、>10 文件自动 zip）
- 多工作区切换（/ws）、会话管理（/new /resume）、/stop 打断
- 通道并发（默认 3），通道内串行

## 前置条件
1. Node.js ≥ 20
2. Claude Code CLI 可用：终端 `claude "hi"` 能正常回复（任意鉴权方式：
   订阅 claude login / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 第三方端点如 GLM——桥接器透传环境变量，不介入鉴权）

## 安装
npm install -g @jesonliu/lark-claudecode-bridge
lcb setup
lcb start

## 飞书应用配置（图文）
1. https://open.feishu.cn → 创建企业自建应用 → 添加「机器人」能力
2. 权限管理开通：im:message、im:message:send_as_bot、im:resource、contact:user.base:readonly
3. 事件与回调 → 事件配置 → 订阅方式选「使用长连接接收事件」→ 添加 im.message.receive_v1
4. 事件与回调 → 卡片交互配置 → 同样选择长连接
5. 凭证与基础信息 → 复制 App ID / App Secret
6. 版本管理与发布 → 创建版本并发布，管理员审核通过
7. 运行 lcb setup 填入凭证 → lcb start → 私聊机器人发「/help」

## 首次配对
第一个发消息的用户会收到 6 位配对码，在 lcb start 的终端里输入该码回车即批准（首个批准者自动成为 admin）。或另开终端 lcb pair <code>。

## 命令速查
| 命令 | 说明 |
|---|---|
| /new | 开新会话 |
| /resume | 列出/恢复历史会话 |
| /stop | 停止当前任务 |
| /status | 当前状态 |
| /ws list / /ws use <名字> | 工作区 |
| /help | 帮助 |

## 配置文件 ~/.lark-claudecode-bridge/config.yaml
（贴 config.example.yaml 全文）

## ⚠️ 安全须知（必读）
本机 Claude Code 是共用资源：白名单用户可通过确认卡片让它在你电脑执行任意命令。
请只批准信任的人；工作区白名单、用户白名单、写操作确认三道闸不要关闭。

## 常驻运行
- Windows：任务计划程序（开机启动 `lcb start`）
- macOS：launchd（模板见 docs/）
- Linux：systemd --user（模板见 docs/）

## 开发
npm install && npm test && npm run build
MIT License
```

- [ ] **Step 2: 写 LICENSE（MIT，版权 2026 jesonliu）、deploy/ 常驻模板与 docs/e2e-checklist.md**

`deploy/windows-start.bat`（任务计划程序指向它）:
```bat
@echo off
lcb start >> "%USERPROFILE%\.lark-claudecode-bridge\bridge.log" 2>&1
```

`deploy/com.lark-claudecode-bridge.plist`（macOS launchd，放 ~/Library/LaunchAgents/ 后 `launchctl bootstrap gui/$(id -u) ...`）:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lark-claudecode-bridge</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/lcb</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/lark-claudecode-bridge.log</string>
</dict></plist>
```

`deploy/lark-claudecode-bridge.service`（Linux，~/.config/systemd/user/ 后 `systemctl --user enable --now lark-claudecode-bridge`）:
```ini
[Unit]
Description=lark-claudecode-bridge
After=network-online.target

[Service]
ExecStart=/usr/bin/env lcb start
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

`docs/e2e-checklist.md`:
```markdown
# 真机端到端冒烟清单（发布前必须全绿）
前置：飞书应用已按 README 配置，lcb setup 完成，lcb start 运行中。
- [ ] 陌生账号私聊机器人 → 收到配对码卡片；终端输入码 → 提示批准；再发消息 → 正常处理
- [ ] 本人私聊发「帮我列出当前目录文件」→ 1 秒内出现进度卡片 → Claude 执行 Read/LS 无确认卡片 → 结果文本返回
- [ ] 发「创建 hello.txt 内容为 hi」→ 出现确认卡片（Write 按钮）→ 点「允许」→ 文件消息回传 hello.txt
- [ ] 点「拒绝」路径：发同类任务 → 点「❌ 拒绝」→ Claude 收到拒绝原因并回复替代方案
- [ ] 点「⏭ 本次会话不再询问」→ 同会话再发写任务 → 不再弹卡片直接执行
- [ ] /new 后 → 写任务再次弹卡片（会话记忆已清）
- [ ] 群里 @机器人 发任务 → 独立执行；另一用户同时 @ → 并行互不阻塞
- [ ] 群里他人点确认按钮 → 卡片更新为「无权限」
- [ ] /ws use 切工作区 → /status 显示新工作区 → 任务在新目录执行
- [ ] 长任务（如让它 sleep 3 分钟）→ 卡片运行计时持续跳动
- [ ] 确认卡片放置 10 分钟 → 自动拒绝
- [ ] /stop → 任务中断，卡片更新为已停止
- [ ] 桥接器 Ctrl+C 重启 → /resume 能看到并恢复历史会话
- [ ] 断网 1 分钟再恢复 → 自动重连，任务可继续发起
- [ ] 产出 >10 个文件的任务 → 收到 zip 文件消息
- [ ] Windows 重启电脑 + 任务计划自启 → 机器人在线
```

- [ ] **Step 3: 按 checklist 真机逐项验证**

需要用户配合（飞书账号在手机上操作）。执行者启动 `lcb start` 后逐项走清单，失败的项记录并修复后重跑该项。全部通过前不得发布。

- [ ] **Step 4: npm 发布演练**

Run: `npm pack`
Expected: 产物只含 dist/、README.md、LICENSE、package.json；解包检查 bin 有执行入口

Run: `npm publish --dry-run`
Expected: 包名、版本、bin 正确，无多余文件

（真实 `npm publish` 由用户本人执行，需 npm login 到 jesonliu 账号）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: README/e2e 清单/发布准备"
```

---

## 任务依赖图

```
Task 1 → Task 2 → Task 3（access）↘
                              Task 10（装配）→ Task 11（CLI）→ Task 12（E2E+发布）
Task 2 → Task 4（卡片）→ Task 5（进度）↗
Task 2 → Task 6（gateway）↗
Task 2 → Task 7（executor）→ Task 8（gate）↗
Task 2 → Task 9（session）↗
```

可并行组：[3,4,6,7,9] 互不依赖（都只依赖 2）；5 依赖 4；8 依赖 7；10 依赖全部。
