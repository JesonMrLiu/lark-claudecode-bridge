import { afterAll, describe, it, expect, vi, type Mock } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, createConfigReloader, type BridgeDeps } from '../src/index.js';
import { DECISION_TEXT } from '../src/gateway/card-builder.js';
import { loadConfig } from '../src/config.js';
import { AccessControl } from '../src/access/access-control.js';
import { SessionStore } from '../src/session/session-store.js';
import type { BridgeConfig, CardActionEvent, FeishuAppConfig, IncomingMessage } from '../src/types.js';

const cfg: BridgeConfig = {
  apps: [{ name: 'a', appId: 'a', appSecret: 's', claudeConfigDir: 'D:/lcb/claude/a' }],
  workspaces: [{ name: 'demo', path: 'F:/demo' }],
  defaults: { workspace: 'demo' },
  concurrency: 3,
};
const appA = cfg.apps[0];

// 临时目录收集：SessionStore/AccessControl 触发 save 时会写盘，必须落在临时目录而非仓库 cwd
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeDeps(executor = vi.fn()) {
  const dir = mkdtempSync(join(tmpdir(), 'lcb-wiring-'));
  tempDirs.push(dir);
  const sent: Array<{ chatId: string; card: unknown }> = [];
  const deps: BridgeDeps = {
    gateway: {
      start: vi.fn(),
      sendCardTo: async (chatId, card) => { sent.push({ chatId, card }); return `m${sent.length}`; },
      sendTextTo: async (chatId, markdown) => { sent.push({ chatId, card: markdown }); return `m${sent.length}`; },
      updateCard: vi.fn(async () => {}),
      uploadAndSendFile: vi.fn(),
    },
    access: new AccessControl(join(dir, 'access.json')),
    store: SessionStore.load(join(dir, 'sessions.json')),
    executor: executor as unknown as typeof import('../src/executor/claude-executor.js').runTask,
  };
  // 直接注入私有 data 设白名单（须为完整 AccessStoreData 形状：evict() 会遍历 pending）
  (deps.access as unknown as { data: { users: Record<string, { name: string; role: string }>; pending: Record<string, unknown> } }).data = {
    users: { ou_u: { name: '测试者', role: 'admin' } },
    pending: {},
  };
  return { deps, sent };
}

const msg = (text: string): IncomingMessage => ({ chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u', text, messageId: 'om_x' });

describe('createBridge 装配', () => {
  it('白名单用户发普通消息 → 首响卡片 + 执行器收到任务 + 结果回传', async () => {
    const executor = vi.fn().mockResolvedValue({ sessionId: 's1', finalText: '做好了', producedFiles: [], turns: 1 });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps);
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
    const bridge = createBridge(cfg, appA, deps);
    await bridge.onMessage(msg('写文件'));
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.gateway.uploadAndSendFile).toHaveBeenCalledWith('oc_1', 'F:/demo/a.md');
  });
  it('lcb-notify：executor 注入进程内 mcpServers，通知工具经 canUseTool 直通不弹确认卡', async () => {
    let decision: { behavior: string } | undefined;
    let injected: { type?: string; name?: string } | undefined;
    const executor = vi.fn().mockImplementation(async (_p: string, opts: { canUseTool?: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }>; mcpServers?: Record<string, { type?: string; name?: string }> }) => {
      injected = opts.mcpServers?.['lcb-notify'];
      decision = await opts.canUseTool!('mcp__lcb-notify__send_image', { path: 'F:/demo/1.png' });
      return { sessionId: 's1', finalText: 'ok', producedFiles: [], turns: 1 };
    });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps);
    await bridge.onMessage(msg('生图'));
    await new Promise((r) => setTimeout(r, 50));
    // 注入形状：进程内 sdk server
    expect(injected?.type).toBe('sdk');
    expect(injected?.name).toBe('lcb-notify');
    // 通知工具直通：允许且全程无确认卡（对比：写操作会发「请求执行操作」卡）
    expect(decision).toEqual({ behavior: 'allow' });
    expect(JSON.stringify(sent)).not.toContain('请求执行操作');
  });
  it('触发词：/produce 改写后入队并提示；未命中的斜杠命令仍走未知命令回复', async () => {
    const executor = vi.fn().mockResolvedValue({ sessionId: 's1', finalText: 'ok', producedFiles: [], turns: 1 });
    const { deps, sent } = makeDeps(executor);
    const appT: FeishuAppConfig = { ...appA, triggers: [{ match: '/produce', rewrite: '执行 content-producer 流程。任务参数：{args}' }] };
    const bridge = createBridge(cfg, appT, deps);
    await bridge.onMessage(msg('/produce https://x.com/a 公众号复刻'));
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0][0]).toBe('执行 content-producer 流程。任务参数：https://x.com/a 公众号复刻');
    expect(JSON.stringify(sent)).toContain('已按触发词');
    // 未命中触发词的斜杠命令：保持「未知命令」防呆 UX，不入队
    executor.mockClear();
    await bridge.onMessage(msg('/whatever'));
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('未知命令');
  });
  it('per-app plugins 透传给 executor（{path} 数组；type:local 映射在 runTask 内完成）', async () => {
    const executor = vi.fn().mockResolvedValue({ sessionId: 's1', finalText: 'ok', producedFiles: [], turns: 1 });
    const { deps } = makeDeps(executor);
    const appP: FeishuAppConfig = { ...appA, plugins: [{ name: 'content-producer', path: 'F:/workspace/plugins/content-producer/plugin' }] };
    const bridge = createBridge(cfg, appP, deps);
    await bridge.onMessage(msg('干活'));
    await new Promise((r) => setTimeout(r, 50));
    const opts = executor.mock.calls[0][1] as { plugins?: Array<{ path: string }> };
    expect(opts.plugins).toEqual([{ path: 'F:/workspace/plugins/content-producer/plugin' }]);
  });
  it('触发词热重载：外部写盘后下一条消息即生效（无需重启）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcb-wiring-'));
    tempDirs.push(dir);
    const cfgPath = join(dir, 'config.yaml');
    const write = (triggers: string) => writeFileSync(cfgPath, `apps:\n  - name: a\n    app_id: a\n    app_secret: s\n${triggers}workspaces:\n  - name: demo\n    path: F:/demo\ndefaults:\n  workspace: demo\nconcurrency: 3\n`, 'utf8');
    write('');
    const live = loadConfig(cfgPath);
    const executor = vi.fn().mockResolvedValue({ sessionId: 's1', finalText: 'ok', producedFiles: [], turns: 1 });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(live, live.apps[0], deps, { reloadConfig: createConfigReloader(live, cfgPath) });
    // 初始无触发词：/produce 走未知命令回复
    await bridge.onMessage(msg('/produce x'));
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('未知命令');
    // 模拟外部进程写盘加触发词 → 桥内存不重启即生效
    write('    triggers:\n      - match: /produce\n        rewrite: 技能流程：{args}\n');
    await bridge.onMessage(msg('/produce 任务甲'));
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0][0]).toBe('技能流程：任务甲');
  });
  it('白名单外用户收到配对码卡片，不执行', async () => {
    const executor = vi.fn();
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps);
    await bridge.onMessage({ ...msg('hi'), userId: 'ou_stranger' });
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('配对');
  });
  it('确认流：写操作发确认卡片，按钮点击放行', async () => {
    let decision: { behavior: string } | undefined;
    const executor = vi.fn().mockImplementation(async (_p: string, opts: { canUseTool?: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }> }) => {
      decision = await opts.canUseTool!('Bash', { command: 'rm -rf /' });
      return { sessionId: 's1', finalText: '', producedFiles: [], turns: 1 };
    });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps);
    await bridge.onMessage(msg('删东西'));
    await new Promise((r) => setTimeout(r, 50));
    const confirmCard = sent.find((s) => JSON.stringify(s.card).includes('请求执行操作'));
    expect(confirmCard).toBeTruthy();
    // 模拟用户点允许：从卡片 JSON 提取 requestId
    const m = /"requestId":"([^"]+)"/.exec(JSON.stringify(confirmCard!.card))!;
    const action: CardActionEvent = { value: { requestId: m[1], decision: 'allow' }, operatorId: 'ou_u', openMessageId: 'om_c' };
    const ret = await bridge.onCardAction(action);
    // 点击反馈：success toast 即时提示 + 响应内联结果卡同步换卡（按钮消失）
    expect(ret).toMatchObject({ toast: { type: 'success', content: DECISION_TEXT.allow }, card: { type: 'raw' } });
    expect(JSON.stringify(ret?.card?.data)).toContain('已允许');
    // 兜底 PATCH 换结果卡：按确认卡 cardId 'm2' 过滤（进度卡 flush 也调同一 mock，不可裸计数）
    const confirmUpdates = () => (deps.gateway.updateCard as Mock).mock.calls
      .filter(([id]) => id === 'm2') as Array<[string, unknown]>;
    expect(confirmUpdates()).toHaveLength(1);
    expect(JSON.stringify(confirmUpdates()[0][1])).toContain('已允许');
    // 重复点击同 requestId（决策已生效）：info toast 提示，不再新增 PATCH、不再 resolve
    const ret2 = await bridge.onCardAction(action);
    expect(ret2).toEqual({ toast: { type: 'info', content: '该确认已被处理或已过期，无需重复操作' } });
    await bridge.onCardAction(action);
    expect(confirmUpdates()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50)); // 等放行后的 canUseTool 返回与任务收尾
    // 「点击→放行」必须真正发生：确认链路失效（resolve 未发生）时此断言失败
    expect(decision).toEqual({ behavior: 'allow' });
    expect(executor).toHaveBeenCalledOnce();
  });
  it('确认超时：卡片置为过期态、任务按拒绝继续，迟到点击静默不产生决策态', async () => {
    let decision: { behavior: string } | undefined;
    const executor = vi.fn().mockImplementation(async (_p: string, opts: { canUseTool?: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }> }) => {
      decision = await opts.canUseTool!('Bash', { command: 'rm -rf /' });
      return { sessionId: 's1', finalText: 'done', producedFiles: [], turns: 1 };
    });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps, { confirmTimeoutMs: 30 });
    await bridge.onMessage(msg('删东西'));
    await new Promise((r) => setTimeout(r, 50)); // 确认卡片已发出并挂起等待
    await new Promise((r) => setTimeout(r, 100)); // 超时已触发，任务按 deny 继续并收尾
    const updates = (deps.gateway.updateCard as Mock).mock.calls as Array<[string, unknown]>;
    expect(updates.some(([, card]) => JSON.stringify(card).includes('超时'))).toBe(true); // 卡片被 PATCH 为过期态
    expect(decision?.behavior).toBe('deny');                        // gate 收到拒绝，任务未被卡死
    expect(JSON.stringify(sent)).toContain('done');                 // 任务正常收尾
    // 迟到点击（条目已被超时清理）：toast 提示后忽略，不产生新的卡片更新——不得显示与实际不符的决策态
    const confirmCard = sent.find((s) => JSON.stringify(s.card).includes('请求执行操作'));
    const m = /"requestId":"([^"]+)"/.exec(JSON.stringify(confirmCard!.card))!;
    const before = updates.length;
    await bridge.onCardAction({ value: { requestId: m[1], decision: 'allow' }, operatorId: 'ou_u', openMessageId: 'om_c' });
    await new Promise((r) => setTimeout(r, 50));
    expect((deps.gateway.updateCard as Mock).mock.calls.length).toBe(before);
  });
  it('已处理/过期的 requestId 返回提示 toast，不抛异常', async () => {
    const { deps } = makeDeps(vi.fn().mockResolvedValue({ sessionId: 's', finalText: '', producedFiles: [], turns: 1 }));
    const bridge = createBridge(cfg, appA, deps);
    // 无 pending 的 requestId（已处理/过期/桥接器重启后的孤儿卡）：info toast 反馈，不 PATCH、不抛异常
    const ret = await bridge.onCardAction({ value: { requestId: 'nope', decision: 'allow' }, operatorId: 'ou_u', openMessageId: 'om_c' });
    expect(ret).toEqual({ toast: { type: 'info', content: '该确认已被处理或已过期，无需重复操作' } });
    expect(deps.gateway.updateCard).not.toHaveBeenCalled();
  });
  it('/help 命令直接回复不进执行器', async () => {
    const executor = vi.fn();
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps);
    await bridge.onMessage(msg('/help'));
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('/new');
  });
  it('I2 回归：非发起人点击不改写卡片（按钮保留），发起人后续点击仍放行', async () => {
    let decision: { behavior: string } | undefined;
    const executor = vi.fn().mockImplementation(async (_p: string, opts: { canUseTool?: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }> }) => {
      decision = await opts.canUseTool!('Bash', { command: 'rm -rf /' });
      return { sessionId: 's1', finalText: '', producedFiles: [], turns: 1 };
    });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps);
    await bridge.onMessage(msg('删东西'));
    await new Promise((r) => setTimeout(r, 50));
    const confirmCard = sent.find((s) => JSON.stringify(s.card).includes('请求执行操作'))!;
    const m = /"requestId":"([^"]+)"/.exec(JSON.stringify(confirmCard.card))!;
    // 他人点击：返回 toast、不 PATCH 卡片、不 resolve 决策；
    // toEqual 全等断言同时锁定响应不得携带 card 字段（内联换卡会把发起人的按钮一并抹掉）
    const ret = await bridge.onCardAction({ value: { requestId: m[1], decision: 'deny' }, operatorId: 'ou_other', openMessageId: 'om_c' });
    expect(ret).toEqual({ toast: { type: 'info', content: '仅任务发起人可确认' } });
    expect(deps.gateway.updateCard).not.toHaveBeenCalled(); // 卡片保持原样（按钮保留）
    expect(decision).toBeUndefined();                       // 等待真正发起人
    // 发起人点击：仍放行，且反馈含 success toast + 内联换卡
    const ret2 = await bridge.onCardAction({ value: { requestId: m[1], decision: 'allow' }, operatorId: 'ou_u', openMessageId: 'om_c' });
    expect(ret2).toMatchObject({ toast: { type: 'success', content: DECISION_TEXT.allow }, card: { type: 'raw' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(decision).toEqual({ behavior: 'allow' });
    expect(executor).toHaveBeenCalledOnce();
  });
  it('I1 回归：「本次会话不再询问」通道级生效（跨任务），/new 后恢复询问', async () => {
    const executor = vi.fn().mockImplementation(async (_p: string, opts: { canUseTool?: (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }> }) => {
      await opts.canUseTool!('Bash', { command: 'x' });
      return { sessionId: 's' + executor.mock.calls.length, finalText: '', producedFiles: [], turns: 1 };
    });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps);
    const confirmCardCount = () => sent.filter((s) => JSON.stringify(s.card).includes('请求执行操作')).length;
    const clickLatest = async (decision: 'allow' | 'deny' | 'allow-session') => {
      const confirmCard = [...sent].reverse().find((s) => JSON.stringify(s.card).includes('请求执行操作'))!;
      const m = /"requestId":"([^"]+)"/.exec(JSON.stringify(confirmCard.card))!;
      await bridge.onCardAction({ value: { requestId: m[1], decision }, operatorId: 'ou_u', openMessageId: 'om_c' });
      await new Promise((r) => setTimeout(r, 50));
    };
    // 任务 A：询问一次，点「本次会话不再询问」
    await bridge.onMessage(msg('任务A'));
    await new Promise((r) => setTimeout(r, 50));
    expect(confirmCardCount()).toBe(1);
    await clickLatest('allow-session');
    // 任务 B：同工具不再询问（修复前 gate 每任务新建，会再次发确认卡）
    await bridge.onMessage(msg('任务B'));
    await new Promise((r) => setTimeout(r, 50));
    expect(confirmCardCount()).toBe(1);
    // /new：会话结束，通道 gate 记忆清除
    await bridge.onMessage(msg('/new'));
    await new Promise((r) => setTimeout(r, 50));
    // 任务 C：恢复询问
    await bridge.onMessage(msg('任务C'));
    await new Promise((r) => setTimeout(r, 50));
    expect(confirmCardCount()).toBe(2);
    await clickLatest('allow');
    expect(executor).toHaveBeenCalledTimes(3);
  });
  it('I4 回归：/stop 中止后任务显示「已停止」、不上传产出文件（会话归档保留）', async () => {
    let releaseTask: () => void = () => {};
    const blocked = new Promise<void>((r) => { releaseTask = r; });
    const executor = vi.fn().mockImplementation(async (_p: string, _opts: unknown) => {
      await blocked; // 挂起模拟长任务，等测试发 /stop
      // abort 后 SDK 流仍正常收尾返回成功形状（这正是 I4 的触发条件）
      return { sessionId: 's_stop', finalText: '', producedFiles: ['F:/demo/out.md'], turns: 1 };
    });
    const { deps, sent } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps);
    await bridge.onMessage(msg('长任务'));
    await new Promise((r) => setTimeout(r, 50)); // 任务已启动并挂起
    await bridge.onMessage(msg('/stop'));
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(sent)).toContain('已发送停止信号');
    releaseTask(); // 任务流收尾
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(sent)).not.toContain('✅ 完成');     // 不误报完成
    expect(deps.gateway.uploadAndSendFile).not.toHaveBeenCalled(); // 产出文件不上传
    expect(deps.store.listSessions('oc_1:ou_u')).toHaveLength(1);  // 会话归档保留
    expect(deps.store.listSessions('oc_1:ou_u')[0].sessionId).toBe('s_stop');
  });
  it('C1 回归：外部进程批准配对写盘后，桥在下一条消息即可识别（无需重启/不再死循环）', async () => {
    const executor = vi.fn().mockResolvedValue({ sessionId: 's1', finalText: 'ok', producedFiles: [], turns: 1 });
    const { deps } = makeDeps(executor);
    const bridge = createBridge(cfg, appA, deps);
    const storePath = (deps.access as unknown as { storePath: string }).storePath;
    // 第 1 条消息：未知用户进配对分支（beginPairing 把内存态整盘落盘）
    await bridge.onMessage({ ...msg('hi'), userId: 'ou_new' });
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).not.toHaveBeenCalled();
    // 模拟 lcb pair 独立进程批准：直接改写 store 文件（桥内存实例对此无感知）
    const disk = JSON.parse(readFileSync(storePath, 'utf8')) as {
      users: Record<string, unknown>;
      pending: Record<string, unknown>;
    };
    disk.users.ou_new = { name: '新用户', role: 'member', pairedAt: new Date().toISOString() };
    delete disk.pending.ou_new;
    writeFileSync(storePath, JSON.stringify(disk), 'utf8');
    // 第 2 条消息：onMessage 入口先 reload → isAllowed 命中新用户 → 正常执行（修复前：仍查旧内存 → 再发配对码且 save() 抹掉刚批准的 users）
    await bridge.onMessage({ ...msg('干活'), userId: 'ou_new' });
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).toHaveBeenCalledOnce();
    expect(deps.access.isAllowed('ou_new')).toBe(true);
  });
  it('配置热重载：外部 lcb ws add 写盘后，/ws list 免重启可见', async () => {
    // 真实临时 config 文件 + createConfigReloader，复刻 startBridge 的注入方式
    const dir = mkdtempSync(join(tmpdir(), 'lcb-wiring-'));
    tempDirs.push(dir);
    const cfgPath = join(dir, 'config.yaml');
    const writeCfg = (ws: Array<{ name: string; path: string }>) => writeFileSync(cfgPath, [
      'feishu:', '  app_id: a', '  app_secret: s',
      'workspaces:', ...ws.flatMap((w) => [`  - name: ${w.name}`, `    path: ${w.path}`]),
      'defaults:', `  workspace: ${ws[0].name}`, 'concurrency: 3',
    ].join('\n') + '\n', 'utf8');
    writeCfg([{ name: 'demo', path: 'F:/demo' }]);
    const live = loadConfig(cfgPath); // 桥「启动时」加载的实例
    const { deps, sent } = makeDeps(vi.fn().mockResolvedValue({ sessionId: 's1', finalText: 'ok', producedFiles: [], turns: 1 }));
    const bridge = createBridge(live, live.apps[0], deps, { reloadConfig: createConfigReloader(live, cfgPath) });
    await bridge.onMessage(msg('/ws list'));
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(sent)).not.toContain('blog');
    // 模拟 lcb ws add 独立进程写盘（桥内存实例对此无感知）
    writeCfg([{ name: 'demo', path: 'F:/demo' }, { name: 'blog', path: 'F:/blog' }]);
    await bridge.onMessage(msg('/ws list'));
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(sent)).toContain('blog'); // 下一条消息即见新工作区，无需重启
  });
});

describe('createBridge · per-app 多应用（隔离与差异化）', () => {
  const appB: FeishuAppConfig = {
    name: 'B机器人', appId: 'cli_b', appSecret: 'sb',
    defaultWorkspace: 'two', concurrency: 1,
    claudeConfigDir: 'D:/lcb/claude/b',
    appendSystemPrompt: '你是素材收集助手',
    env: { ANTHROPIC_MODEL: 'glm-4.6' },
  };
  const cfg2: BridgeConfig = {
    apps: [appA, appB],
    workspaces: [{ name: 'demo', path: 'F:/demo' }, { name: 'two', path: 'F:/two' }],
    defaults: { workspace: 'demo' },
    concurrency: 3,
  };
  const ok = () => ({ sessionId: 's1', finalText: 'ok', producedFiles: [], turns: 1 });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('per-app 默认工作区与环境：B 的任务落 B 默认工作区，注入 B 的 CLAUDE_CONFIG_DIR/env/人格', async () => {
    const executor = vi.fn().mockResolvedValue(ok());
    const { deps } = makeDeps(executor);
    const bridge = createBridge(cfg2, appB, deps);
    await bridge.onMessage(msg('收集素材'));
    await wait(50);
    const opts = executor.mock.calls[0][1] as { cwd: string; env?: Record<string, string | undefined>; appendSystemPrompt?: string };
    expect(opts.cwd).toBe('F:/two');
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBe('D:/lcb/claude/b');
    expect(opts.env?.ANTHROPIC_MODEL).toBe('glm-4.6');
    expect(opts.appendSystemPrompt).toBe('你是素材收集助手');
  });
  it('A 实例注入 A 自己的环境，不受 B 配置影响', async () => {
    const executor = vi.fn().mockResolvedValue(ok());
    const { deps } = makeDeps(executor);
    const bridge = createBridge(cfg2, appA, deps);
    await bridge.onMessage(msg('干活'));
    await wait(50);
    const opts = executor.mock.calls[0][1] as { env?: Record<string, string | undefined> };
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBe('D:/lcb/claude/a');
    // A 未配置 env 覆盖：B 的 ANTHROPIC_MODEL 不泄漏进来，process.env 原值照常透传
    expect(opts.env?.ANTHROPIC_MODEL).toBe(process.env.ANTHROPIC_MODEL);
    expect(opts.env?.ANTHROPIC_MODEL).not.toBe('glm-4.6');
  });
  it('会话池隔离：A 归档的会话与 /ws use 通道状态对 B 完全不可见（独立 store）', async () => {
    const execA = vi.fn().mockResolvedValue(ok());
    const execB = vi.fn().mockResolvedValue(ok());
    const { deps: dA } = makeDeps(execA);
    const { deps: dB } = makeDeps(execB);
    const bridgeA = createBridge(cfg2, appA, dA);
    const bridgeB = createBridge(cfg2, appB, dB);
    await bridgeA.onMessage(msg('A 的任务'));
    await wait(50);
    expect(dA.store.listSessions('oc_1:ou_u')).toHaveLength(1);
    expect(dB.store.listSessions('oc_1:ou_u')).toHaveLength(0); // B 看不到 A 的历史会话
    await bridgeA.onMessage(msg('/ws use two'));
    await wait(50);
    expect(dA.store.getChannelState('oc_1:ou_u')?.workspaceName).toBe('two');
    expect(dB.store.getChannelState('oc_1:ou_u')).toBeUndefined(); // A 的切换不污染 B 的通道状态
    await bridgeB.onMessage(msg('B 的任务'));
    await wait(50);
    expect((execB.mock.calls[0][1] as { cwd: string }).cwd).toBe('F:/two'); // B 仍用自己的默认工作区
  });
  it('per-app 并发闸：A（concurrency=1）内两任务串行，B 同时不受阻', async () => {
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => { releaseA = r; });
    const execA = vi.fn().mockImplementation(async () => { await gate; return ok(); });
    const execB = vi.fn().mockResolvedValue(ok());
    const cfgSerial: BridgeConfig = { ...cfg2, apps: [{ ...appA, concurrency: 1 }, appB] };
    const { deps: dA } = makeDeps(execA);
    const { deps: dB } = makeDeps(execB);
    const bridgeA = createBridge(cfgSerial, cfgSerial.apps[0], dA);
    const bridgeB = createBridge(cfgSerial, appB, dB);
    await bridgeA.onMessage({ ...msg('任务1'), chatId: 'oc_a1' }); // 不同 chatId：绕开通道串行，直击并发闸
    await bridgeA.onMessage({ ...msg('任务2'), chatId: 'oc_a2' });
    await wait(50);
    expect(execA).toHaveBeenCalledTimes(1); // 第二个任务在 A 的闸外排队
    await bridgeB.onMessage(msg('B 任务'));
    await wait(50);
    expect(execB).toHaveBeenCalledTimes(1); // B 的闸独立，不被 A 占用
    releaseA();
    await wait(100);
    expect(execA).toHaveBeenCalledTimes(2); // 释放后 A 的第二个任务进入
  });
  it('transcript 落盘接线：user/assistant/tool/result 事件在对应写点触发，resume 带上轮 sessionId', async () => {
    const events: Array<Record<string, unknown>> = [];
    const transcript = {
      user: (e: Record<string, unknown>) => events.push(e),
      assistant: (e: Record<string, unknown>) => events.push(e),
      tool: (e: Record<string, unknown>) => events.push(e),
      result: (e: Record<string, unknown>) => events.push(e),
    };
    const executor = vi.fn().mockImplementation(async (_p: string, _o: unknown, cb: { onProgress(e: { kind: string; content: string; ok?: boolean }): Promise<void> }) => {
      await cb.onProgress({ kind: 'text', content: '正在处理' });
      await cb.onProgress({ kind: 'tool-start', content: 'Bash: ls' });
      await cb.onProgress({ kind: 'tool-result', content: 'Bash', ok: true });
      return { sessionId: 's9', finalText: '完成了', producedFiles: [], turns: 1 };
    });
    const { deps } = makeDeps(executor);
    (deps as BridgeDeps & { transcript?: unknown }).transcript = transcript;
    const bridge = createBridge(cfg2, appB, deps);
    await bridge.onMessage(msg('帮我整理'));
    await wait(50);
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'result']);
    expect(events[0]).toMatchObject({ text: '帮我整理', app: 'cli_b', chatId: 'oc_1', userId: 'ou_u', workspace: 'two' });
    expect(events[1]).toMatchObject({ text: '正在处理' });
    expect(events[4]).toMatchObject({ sessionId: 's9', subtype: 'success', text: '完成了' });
    // 第二轮任务：user 事件应带上轮 sessionId（resume 链路可见）
    events.length = 0;
    await bridge.onMessage(msg('再来一次'));
    await wait(50);
    expect(events[0]).toMatchObject({ kind: 'user', sessionId: 's9' });
  });
  it('executor 抛错 → transcript 记录 subtype error（错误串入 text）', async () => {
    const events: Array<Record<string, unknown>> = [];
    const transcript = {
      user: (e: Record<string, unknown>) => events.push(e),
      assistant: (e: Record<string, unknown>) => events.push(e),
      tool: (e: Record<string, unknown>) => events.push(e),
      result: (e: Record<string, unknown>) => events.push(e),
    };
    const executor = vi.fn().mockRejectedValue(new Error('boom'));
    const { deps } = makeDeps(executor);
    (deps as BridgeDeps & { transcript?: unknown }).transcript = transcript;
    const bridge = createBridge(cfg2, appB, deps);
    await bridge.onMessage(msg('坏任务'));
    await wait(50);
    expect(events.at(-1)).toMatchObject({ kind: 'result', subtype: 'error' });
    expect(String(events.at(-1)?.text)).toContain('boom');
  });
  it('/stop 中止 → transcript 记录 subtype stopped', async () => {
    const events: Array<Record<string, unknown>> = [];
    const transcript = {
      user: (e: Record<string, unknown>) => events.push(e),
      assistant: (e: Record<string, unknown>) => events.push(e),
      tool: (e: Record<string, unknown>) => events.push(e),
      result: (e: Record<string, unknown>) => events.push(e),
    };
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const executor = vi.fn().mockImplementation(async () => {
      await blocked;
      return { sessionId: 's_stop', finalText: '', producedFiles: [], turns: 1 };
    });
    const { deps } = makeDeps(executor);
    (deps as BridgeDeps & { transcript?: unknown }).transcript = transcript;
    const bridge = createBridge(cfg2, appB, deps);
    await bridge.onMessage(msg('长任务'));
    await wait(50);
    await bridge.onMessage(msg('/stop'));
    await wait(50);
    release();
    await wait(50);
    expect(events.at(-1)).toMatchObject({ kind: 'result', subtype: 'stopped' });
  });
  it('/status 显示机器人名称（多机器人同群时辨认对谁说话）', async () => {
    const { deps, sent } = makeDeps(vi.fn());
    const bridge = createBridge(cfg2, appB, deps);
    await bridge.onMessage(msg('/status'));
    await wait(50);
    expect(JSON.stringify(sent)).toContain('B机器人');
  });
});

describe('createConfigReloader', () => {
  /** 写临时 config 并 loadConfig，返回活配置与文件改写器 */
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'lcb-reload-'));
    tempDirs.push(dir);
    const cfgPath = join(dir, 'config.yaml');
    const write = (yaml: string) => writeFileSync(cfgPath, yaml, 'utf8');
    write('feishu:\n  app_id: a\n  app_secret: s\nworkspaces:\n  - name: demo\n    path: F:/demo\ndefaults:\n  workspace: demo\nconcurrency: 3\n');
    return { cfgPath, write, live: loadConfig(cfgPath) };
  }
  it('热应用 workspaces + defaults；不热应用 concurrency / feishu（启动时构造的资源无法热替换）', () => {
    const { cfgPath, write, live } = fixture();
    write('feishu:\n  app_id: changed\n  app_secret: s\nworkspaces:\n  - name: demo\n    path: F:/demo\n  - name: blog\n    path: F:/blog\ndefaults:\n  workspace: blog\nconcurrency: 9\n');
    createConfigReloader(live, cfgPath)();
    expect(live.workspaces.map((w) => w.name)).toEqual(['demo', 'blog']);
    expect(live.defaults.workspace).toBe('blog');
    expect(live.concurrency).toBe(3);          // 保持启动值
    expect(live.apps[0].appId).toBe('a');      // 保持启动值
  });
  it('读失败（文件写坏的中间态）沿用旧值不抛', () => {
    const { cfgPath, write, live } = fixture();
    write('feishu: [broken');
    expect(() => createConfigReloader(live, cfgPath)()).not.toThrow();
    expect(live.workspaces).toHaveLength(1);
  });
});
