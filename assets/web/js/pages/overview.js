// ============ 概览 ============
// 状态看板：4 张瓦片（桥接器进程 / Claude 认证 / 飞书 CLI / 记忆增强）+ LCB、飞书 CLI
// 各自独立的版本更新卡 + 机器人与快捷指令 + 日志查看器抽屉。
// 桥接器启停（宿主进程管理）：embedded 页面随进程生死，独立页面经 PID 跨进程操作。
import { S, $, esc, toast, api, refresh } from '../core.js';
import { openDrawer, closeDrawer, bindDialogKeys, confirmDialog, mountDialog, progressDialog, stepsDialog } from '../ui.js';
// larkNotConfigured 与后端 needsLarkCliConfig 同源（detail 含 not_configured 即「未配置应用」），
// 判定只有一份、放在弹窗模块里，避免两处漂移
import { larkNotConfigured, openLarkCliDeviceDialog } from './larkcli-device.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UPD = { checkedAt: 0, data: null };
const LARKCLI = { checkedAt: 0, data: null }; // 飞书官方 CLI 状态缓存（30s 节流，同 UPD）
const svg = (inner, s = 14) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const IC = {
  apps: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  claude: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  zap: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
  memory: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  chats: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  copy: '<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
};

function showMask(inner) {
  let m = $('#brMask');
  if (!m) {
    m = document.createElement('div');
    m.id = 'brMask'; m.className = 'modal-mask';
    m.style.zIndex = '150';
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="modal dlg" style="text-align:center"><div class="dlg-msg" style="white-space:normal">${inner}</div></div>`;
  m.style.display = 'flex';
}

/** 启停请求的容错：embedded 停止/重启时进程退出可能先于响应到达，网络断开视为已受理。
 * delivered 区分「服务确认受理」与「网络断开推定受理」——后者有两种截然相反的可能：
 * ①旧进程退出先于响应（正常）②服务根本不在、请求无人受理（2026-10-17 120s 空等根因），
 * 调用方（restartFlow）须用 probeBridgeAlive 二次分流 */
async function bridgeActionSafe(op) {
  try { return { ...await api('POST', '/api/bridge/action', { op }), delivered: true }; }
  catch (e) {
    if (/fetch|network|load failed/i.test(e.message)) return { ok: true, message: '已提交（连接关闭属预期）', delivered: false };
    throw e;
  }
}

/** 桥接器状态探测：裸 fetch /api/status，任何 HTTP 应答（含 401 锁屏/503）都算「在」；
 * 不用 api()：它对非 2xx 会抛错，而锁屏 401 时服务明明活着。本地回环毫秒级应答，3s 兜底防悬挂。
 * 返回结构化信息：401 特批响应自带顶层 pid/version（重启判定用它识别新进程，无需 200 会话）*/
async function probeStatus() {
  try {
    const res = await Promise.race([
      fetch('/api/status', { cache: 'no-store' }),
      sleep(3000).then(() => { throw new Error('probe-timeout'); }),
    ]);
    const body = await res.json().catch(() => ({}));
    return {
      alive: true,
      locked: res.status === 401,
      pid: typeof body.pid === 'number' ? body.pid : null,
      version: typeof body.version === 'string' ? body.version : null,
    };
  } catch { return { alive: false, locked: false, pid: null, version: null }; }
}

/**
 * 重启进度分步弹窗（两种运行模式统一）。步骤① LCB 重启（探测新进程上线），步骤② 记忆增强
 * OpenViking（轮询自举状态/健康探活）——两步状态源不同、节奏不同，旧版单句遮罩 + 45s 超时
 * 报错的做法在 OpenViking 冷启动（30-60s+）时必撞「重启超时」误报，整体重做：
 * - LCB 自身恢复只取决于 LCB 本体（服务端已把配置页启动前移、记忆自举后台化）
 * - 记忆增强**永不导致「重启失败」**：未就绪呈现为黄色警示 + 手动开启指引，弹窗可随时关闭
 */
async function restartFlow() {
  const embedded = !!S.status?.embedded;
  const oldPid = S.status?.bridge?.pid ?? null;
  const st = [
    { title: 'LCB 重启中', detail: '正在停止旧进程并拉起新进程…', status: 'running' },
    { title: '记忆增强（OpenViking）', detail: '等待 LCB 重启完成后检测…', status: 'pending' },
  ];
  let stopped = false;
  const dlg = stepsDialog({ title: '重启桥接器', steps: st });
  // 关弹窗 = 后台运行：停轮询，稍后刷新概览状态（重启幂等，流程在桥接器侧继续不受影响）
  dlg.onClose(() => { stopped = true; setTimeout(() => void refresh(), 3000); });
  const paint = (i, patch) => { Object.assign(st[i], patch); dlg.setSteps(st.map((s) => ({ ...s }))); };

  let delivered = true;
  try { delivered = (await bridgeActionSafe('restart')).delivered !== false; }
  catch (e) { paint(0, { status: 'failed', detail: e.message }); toast(e.message, true); return; }
  if (!delivered) {
    // 推定受理（网络断开）二次分流：服务确实不在 = 重启请求无人受理，立即明示，不空等 120s
    //（embedded 正常重启也会推定受理，但那时服务很快失联/被新进程接管，探测通过继续走轮询）
    if (!(await probeStatus()).alive) {
      paint(0, { status: 'failed', detail: '桥接器服务未在运行，重启请求未送达。请在终端运行 lcb start 拉起后重试' });
      paint(1, { status: 'skipped', detail: '配置页不可达，无法检测记忆增强（记忆增强不会导致重启失败）' });
      dlg.setHint('<button class="btn sm" id="sdReload">手动刷新页面</button>');
      document.querySelector('#sdReload').onclick = () => location.reload();
      return;
    }
  }

  // ---- 步骤①：等 LCB 回归。embedded：本页随进程失联，连续两次 /api/status 成功才算新进程
  //（排除旧进程残影）；独立：本页不失联，等 PID 文件换新（bridge.running 且 pid 变化）。
  // 超时不再报「重启失败」退出——如实呈现等待中 + 给手动刷新出口，弹窗保持观测
  const t0 = Date.now();
  await sleep(2500); // 留给旧进程退场：立刻探测可能命中尚未退出的旧 server
  let streak = false;
  let back = false;
  /** 200 轮询拿不到时的 401 兜底：新进程已上线但页面会话失效（重启清空/改密吊销/锁屏过期）
   *  → 重启本身成功，转为「重新解锁」引导而非空等 120s（401 特批响应自带顶层 pid 可判新旧） */
  const finishWithRelock = (waitedSec) => {
    paint(0, { status: 'done', detail: `LCB 已重启（用时 ${waitedSec} 秒）` });
    paint(1, { status: 'warn', detail: '配置页会话已随重启失效（安全设计），请重新解锁后查看记忆增强状态' });
    dlg.setHint('<button class="btn primary sm" id="sdReload">重新解锁页面</button>');
    document.querySelector('#sdReload').onclick = () => location.reload();
    toast('✅ LCB 已重启，请重新解锁页面');
  };
  while (!stopped && Date.now() - t0 < 120_000) {
    const sec = Math.round((Date.now() - t0) / 1000);
    let s = null;
    try { s = await api('GET', '/api/status'); } catch { /* 失联窗口 / 401 锁屏属预期 */ }
    if (!s) {
      const probe = await probeStatus();
      if (probe.pid != null && oldPid != null && probe.pid !== oldPid) {
        finishWithRelock(sec);
        return;
      }
    }
    if (s) {
      if (embedded) {
        // 新进程识别：应答者顶层 pid ≠ 重启前 PID（pid 双方齐备时），否则看 uptimeMs 是否小于
        // 已等待时长（新进程必然更年轻；旧版 LCB 无顶层 pid、或别的进程占着端口应答时兜底）。
        // 识别不过 = 旧进程残影/冒充应答：不算回归，继续等（避免端口被旧进程接管时误报「已重启」）
        const waitedMs = Date.now() - t0;
        const fresh = (s.pid != null && oldPid != null)
          ? s.pid !== oldPid
          : (s.uptimeMs != null ? s.uptimeMs < waitedMs : true);
        if (fresh) {
          if (streak) { back = true; break; }
          streak = true;
          await sleep(1000); // 快速二次确认（旧实现同口径）
          continue;
        }
        streak = false; // 残影应答：重置连击，继续等
      } else if (s.bridge?.running && (oldPid == null || s.bridge?.pid !== oldPid)) { back = true; break; }
    } else if (embedded) streak = false;
    paint(0, { detail: `已等 ${sec} 秒…（新进程上线即自动恢复）` });
    await sleep(1500);
  }
  if (stopped) return;
  if (!back) {
    // 超时三分：①新进程其实已上线但会话失效（轮询内兜底漏网的最后时机，如 oldPid 迟到才解析）
    // ②端口有应答但 PID 与重启前相同（旧进程仍占端口）③彻底无人应答（启动失败）
    const probe = await probeStatus();
    if (probe.pid != null && oldPid != null && probe.pid !== oldPid) {
      finishWithRelock(Math.round((Date.now() - t0) / 1000));
      return;
    }
    paint(0, { status: 'failed', detail: probe.alive
      ? '超过 120 秒未见新进程上线：端口上有服务应答但 PID 未变化（疑似重启前旧进程仍占用端口）——请结束占用进程（lcb start 也会自动清场）后重试'
      : '超过 120 秒未见新进程上线——可能端口占用等启动异常，请查看日志' });
    // 步骤①失败不再静默跳过步骤②：给出灰态说明，避免「记忆增强根本没显示启动」的误解
    paint(1, { status: 'skipped', detail: 'LCB 未恢复，无法检测记忆增强（记忆增强不会导致重启失败）' });
    dlg.setHint('<button class="btn sm" id="sdReload">手动刷新页面</button>');
    document.querySelector('#sdReload').onclick = () => location.reload();
    return;
  }
  paint(0, { status: 'done', detail: `LCB 已重启（用时 ${Math.round((Date.now() - t0) / 1000)} 秒）` });
  toast('✅ LCB 已重启'); // 弹窗可能已被用户关掉（后台运行），toast 兜一条完成通知

  // ---- 步骤②：记忆增强 OpenViking。embedded 轮询 /api/memory/status：enabled=false → 跳过；
  // health 探活通过 → 就绪；自举 phase=starting → 实时「已等 N 秒」；phase=failed → 黄色警示
  //（不红叉、不阻断——LCB 本体已正常，只是记忆增强没起来）。独立模式本页拿不到桥接器进程内
  // 的自举报告，以 health 探活为准（新桥接器起来会自动拉起受管服务）。
  paint(1, { status: 'running', detail: '正在检测记忆服务…' });
  const MEM_POLL_MAX_MS = embedded ? 620_000 : 150_000; // embedded 与后端慢启动续等窗口（600s）对齐
  const m0 = Date.now();
  while (!stopped) {
    let ms = null;
    try { ms = await api('GET', '/api/memory/status'); } catch { /* 新进程刚回来时的空窗：静默重试 */ }
    const sec = Math.round((Date.now() - m0) / 1000);
    if (ms) {
      if (ms.memory?.enabled === false) { paint(1, { status: 'skipped', detail: '未启用（config.yaml 的 memory.enabled=false）' }); break; }
      if (ms.health?.healthy) { paint(1, { status: 'done', detail: `记忆服务已就绪：${ms.memory?.endpoint || ''}` }); break; }
      const auto = embedded ? ms.install?.autoStart : undefined;
      if (auto?.phase === 'failed') {
        paint(1, { status: 'warn', detail: `${auto.detail}${auto.hint ? `。${auto.hint}` : ''}` });
        break;
      }
      if (auto?.phase === 'starting') {
        const waited = auto.at ? Math.max(0, Math.round((Date.now() - new Date(auto.at).getTime()) / 1000)) : sec;
        paint(1, { detail: `${auto.detail}（已等 ${waited} 秒）` });
      } else {
        paint(1, { detail: embedded ? `检测记忆服务状态…（${sec} 秒）` : `等待桥接器拉起记忆服务…（已等 ${sec} 秒）` });
      }
    }
    if (Date.now() - m0 > MEM_POLL_MAX_MS) {
      paint(1, { status: 'warn', detail: '长时间未见就绪，请到「记忆增强」页查看服务状态或手动启动' });
      break;
    }
    await sleep(2000);
  }
  dlg.setHint('本弹窗可随时关闭（后台运行），重启与记忆启动不受影响');
  void refresh();
}

async function startFlow() {
  try {
    const r = await bridgeActionSafe('start');
    toast(r.message || '✅ 已在后台启动');
    setTimeout(() => refresh(), 2500); // 后台进程写 PID / 起长连接需数秒
    setTimeout(() => refresh(), 7000);
  } catch (e) { toast(e.message, true); }
}

async function stopFlow() {
  const embedded = !!S.status?.embedded;
  const msg = embedded
    ? '停止后本配置页将随桥接器进程一同关闭。\n之后可运行 lcb ui 重开配置页（并在其中重新启动桥接器）。'
    : '停止后机器人将不再响应消息。';
  if (!(await confirmDialog({ title: '停止桥接器', message: msg, danger: true, confirmText: '停止' }))) return;
  try {
    const r = await bridgeActionSafe('stop');
    if (embedded) {
      toast(r.message || '正在停止…');
      await sleep(2500);
      try { await api('GET', '/api/status'); await refresh(); } // 进程仍在（异常场景）：正常刷新
      catch { showMask('<b>桥接器已停止</b><div class="hint" style="margin-top:8px">本配置页已随进程离线。重新打开请运行 lcb ui；启动桥接器请运行 lcb start。</div>'); }
    } else {
      toast(r.message || '已发送停止信号');
      setTimeout(() => refresh(), 1500); // 硬终止无 PID 清理：陈旧文件由探活兜底删除
      setTimeout(() => refresh(), 4000);
    }
  } catch (e) { toast(e.message, true); }
}

function renderUpdateResult() {
  const el = $('#updLatest');
  const r = UPD.data;
  if (!el) return;
  if (!r) { el.innerHTML = '<span class="hint">未检查</span>'; return; }
  el.innerHTML = r.hasUpdate
    ? `<span class="tag warn">有新版本</span> <span class="chip">v${esc(r.latest)}</span>`
    : `<span class="tag ok">已是最新</span> <span class="chip">v${esc(r.latest)}</span>`;
  const area = $('#updArea');
  if (!area) return;
  if (r.hasUpdate && r.mode === 'global') {
    area.innerHTML = `<button class="btn sm primary" id="btnUpdRun">更新到 v${esc(r.latest)}</button>`;
    $('#btnUpdRun').onclick = runUpdateFlow;
  } else if (r.hasUpdate) {
    area.innerHTML = '<span class="hint">当前非 npm 全局安装运行，请手动更新</span>';
  } else area.innerHTML = '';
}

async function doCheckUpdate() {
  const el = $('#updLatest'); if (!el) return;
  el.innerHTML = '<span class="hint">检查中…</span>';
  try {
    UPD.data = await api('GET', '/api/update/check');
    UPD.checkedAt = Date.now();
    renderUpdateResult();
  } catch (e) {
    el.innerHTML = `<span class="hint">检查失败：${esc(e.message)}</span>`;
  }
}

async function runUpdateFlow() {
  const running = S.status?.embedded || S.status?.bridge?.running;
  const extra = running ? '，完成后自动重启桥接器（页面将短暂失联后自动恢复）' : '（桥接器未在运行，下次启动生效）';
  if (!(await confirmDialog({ title: '一键更新', message: `将通过 npm 安装桥接器最新版本${extra}，可能需要 1-2 分钟。`, confirmText: '开始更新' }))) return;
  const btn = $('#btnUpdRun');
  if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }
  try {
    // 只更新桥接器自身：飞书 CLI 的更新在它自己那张卡点「更新」，两条更新各自独立
    await api('POST', '/api/update/run');
    UPD.checkedAt = 0; LARKCLI.checkedAt = 0;
    if (running) await restartFlow();
    else toast('✅ 更新完成，下次启动生效');
    await refresh();
  } catch (e) {
    toast(`更新失败：${e.message}`, true);
    renderUpdateResult(); // 恢复按钮
  }
}

/** 纯函数（可测）：飞书 CLI 状态 HTML（不含操作按钮，按钮由 renderLarkCliResult 按需挂） */
export function larkCliStatHtml(r) {
  if (!r) return '<span class="hint">未检查</span>';
  if (!r.installed) return '<span class="tag off">未安装</span>';
  // authorized 之外一律呈现为可点授权按钮的警示态（含探测不出的 unknown）：UI 不留没有出口的状态。
  // expired 单列（曾授权但 refresh token 失效）：与「从未授权」区分，detail 悬浮带原因与过期日期。
  const authTag = r.auth?.state === 'authorized'
    ? '<span class="tag ok">已授权</span>'
    : r.auth?.state === 'expired'
      ? `<span class="tag warn"${r.auth?.detail ? ` title="${esc(r.auth.detail)}"` : ''}>已过期</span>`
      : `<span class="tag warn"${r.auth?.detail ? ` title="${esc(r.auth.detail)}"` : ''}>未授权</span>`;
  // skill 字段为旧后端所无（undefined 时不显示），与 auth 解耦展示
  const skillTag = r.skill
    ? (r.skill.installed ? '<span class="tag ok">SKILL</span>' : '<span class="tag warn">SKILL 未装</span>')
    : '';
  return `<span class="tag ok">已安装</span> <span class="chip">${r.version ? `v${esc(r.version)}` : '版本未知'}</span>`
    + (r.hasUpdate ? ' <span class="tag warn">有新版本</span>' : '')
    + (skillTag ? ` ${skillTag}` : '')
    + ` ${authTag}`;
}

/**
 * 纯函数（可测）：飞书 CLI 主入口按钮的文案——按「点开后会先走哪一步」命名，
 * 不出现「按钮写扫码授权、点开弹窗却是配置二维码」的错位。
 * 未配置应用时弹窗从 config 阶段起步（见 openDeviceDialog 与 larkcli-device.js），故叫「配置应用」。
 * 探测不出（unknown）**不**算未配置：误判会把已配好应用的用户反复推去重配，按「扫码授权」处理。
 */
export function larkCliPrimaryLabel(r) {
  if (r?.auth?.state === 'authorized' || r?.auth?.state === 'expired') return '重新授权';
  return larkNotConfigured(r) ? '配置应用' : '扫码授权';
}

/**
 * 扫码弹窗（配置 + 授权的主路径）。未配置应用时它从**配置阶段**起步：页面内直接出示
 * 配置二维码，用户扫完在浏览器里建好应用，弹窗自动接续出示授权二维码——全程不切窗口，
 * 无桌面 / SSH 环境下同样走得通（那条路上「去终端向导」原本是无出口的死路）。
 * 两个阶段的「改用终端窗口」都接回既有终端链路：那条路一行没改，保留补跑命令的能力。
 */
function openDeviceDialog() {
  openLarkCliDeviceDialog({
    wasAuthorized: LARKCLI.data?.auth?.state === 'authorized',
    notConfigured: larkNotConfigured(LARKCLI.data),
    onChange: (r) => { LARKCLI.data = r; LARKCLI.checkedAt = Date.now(); renderLarkCliResult(); },
    onTerminal: () => void larkCliActionFlow('auth'),
    onConfigTerminal: () => void larkCliActionFlow('config'),
  });
}

/** 飞书 CLI 卡内的动作按钮区（安装 / 更新 / 授权 / SKILL） */
function renderLarkCliResult() {
  const el = $('#larkCliStat');
  const r = LARKCLI.data;
  if (!el) return;
  el.innerHTML = `${larkCliStatHtml(r)} <span id="larkCliArea" style="display:inline-flex;gap:6px;margin-left:6px;vertical-align:1px"></span>`;
  const area = $('#larkCliArea');
  if (!area || !r) return;
  const add = (label, op) => {
    const b = document.createElement('button');
    b.className = 'btn sm';
    b.textContent = label;
    b.onclick = () => (op === 'auth-device' ? openDeviceDialog() : larkCliActionFlow(op));
    area.appendChild(b);
  };
  if (!r.installed) { add('安装', 'install'); return; }
  if (r.hasUpdate) add('更新', 'update');
  // 入口常驻，且已授权也给（token 会过期，随时可重走一遍 device flow 刷新）。
  // 走**页面内二维码**（主路径，无桌面环境同样可用）；终端窗口降级为弹窗里的备选。
  add(larkCliPrimaryLabel(r), 'auth-device');
  if (r.skill && !r.skill.installed) add('装 SKILL', 'skill');
  paintCliTile(r); // 30s 缓存路径（render 时直接重放）同样回填瓦片
}

/** 飞书 CLI 瓦片回填：检测结果同时刷新上方瓦片（此前只回填更新卡，瓦片永远停在「检测中」） */
function paintCliTile(r, failed = false) {
  const top = $('#tileCliTop');
  if (!top) return; // 页面已切走
  let dot = 'off';
  let dstate = '未安装';
  let subText = '未安装——点「安装」一键装好并引导授权';
  if (failed) {
    dot = 'err';
    dstate = '检测失败';
    subText = 'CLI 状态探测异常，点「检查更新」重试';
  } else if (r?.installed) {
    dot = r.auth?.state === 'authorized' ? 'ok' : 'warn';
    dstate = r.auth?.state === 'authorized' ? '已授权' : r.auth?.state === 'expired' ? '授权已过期' : '未授权';
    subText = `v${r.version || '?'} · SKILL ${r.skill?.installed ? '已装' : '未装'}${r.hasUpdate ? ' · 可更新' : ''}`;
  }
  top.innerHTML = `<span class="dot ${dot}"></span><span class="tile-state" style="color:var(--${dot}-tx)">${dstate}</span><span class="tile-ico">${svg(IC.zap, 16)}</span>`;
  const sub = $('#tileCliSub');
  if (sub) { sub.textContent = subText; sub.title = subText; }
  const btn = $('#tileCliAuth');
  if (btn) btn.textContent = r?.installed ? (r.auth?.state === 'authorized' ? '重新授权' : '去授权') : '安装';
}

async function doCheckLarkCli() {
  const el = $('#larkCliStat'); if (!el) return;
  try {
    LARKCLI.data = await api('GET', '/api/lark-cli?check=1');
    LARKCLI.checkedAt = Date.now();
    renderLarkCliResult();
    paintCliTile(LARKCLI.data);
  } catch (e) {
    el.innerHTML = `<span class="hint">检测失败：${esc(e.message)}</span>`;
    paintCliTile(null, true);
  }
}

/**
 * 终端已拉起后的提示弹窗：终端是 detached 的独立进程，这里的「检测」「关闭」
 * 都只作用于本弹窗，不影响终端里的安装/授权。
 */
function openLarkCliTerminalDialog(op) {
  const taskLabel = op === 'auth' ? '授权' : op === 'config' ? '配置应用' : '安装 / 更新';
  const { mask, unmount } = mountDialog(`
    <div class="modal dlg" role="dialog" aria-modal="true" style="width:min(600px,94vw)">
      <h3 class="dlg-title">飞书 CLI ${taskLabel}</h3>
      <div class="dlg-msg">已拉起<b>终端窗口</b>执行命令，请按窗口里的提示完成${op === 'auth' ? '授权' : op === 'config' ? '应用配置（在浏览器完成创建后终端会自动继续）' : '安装与配置、授权'}。</div>
      <div class="hint" style="margin-top:10px">关闭本弹窗<b>不会中断</b>终端里的进程；终端还在跑时请不要关掉它。</div>
      <div id="lktStat" style="margin-top:12px"><span class="hint">检测中…</span></div>
      <div class="dlg-foot">
        <button class="btn" data-lkt="auth" hidden>去终端授权</button>
        <button class="btn" data-lkt="check">检测</button>
        <button class="btn primary" data-lkt="close">关闭</button>
      </div>
    </div>`);
  const statEl = mask.querySelector('#lktStat');
  const authBtn = mask.querySelector('[data-lkt="auth"]');
  const POLL_MS = 5000;
  const POLL_MAX = 120; // 约 10 分钟：安装 + 走完 device flow 通常远快于此
  let timer = null;
  let polls = 0;
  let busy = false;    // 去重：手动「检测」与自动轮询不叠加
  let stopped = false;
  // 打开弹窗时是否已授权（快照）：重新授权场景靠它区分「本来就好」与「刚跑完」
  const wasAuthorized = LARKCLI.data?.auth?.state === 'authorized';

  const stop = (note) => {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (note) statEl.insertAdjacentHTML('beforeend', `<div class="hint" style="margin-top:6px">${note}</div>`);
  };

  const paint = (r) => {
    const auth = r.auth?.state;
    const tag = !r.installed ? '<span class="tag off">未安装</span>'
      : `<span class="tag ok">已安装</span> <span class="chip">${r.version ? `v${esc(r.version)}` : '版本未知'}</span> `
        + (auth === 'authorized' ? '<span class="tag ok">已授权</span>' : '<span class="tag warn">未授权</span>');
    statEl.innerHTML = tag + (stopped ? '' : ` <span class="hint">（每 ${POLL_MS / 1000} 秒自动检测一次）</span>`);
    // 已安装即给授权入口：未授权可去授权，已授权可重新授权
    authBtn.hidden = !r.installed;
    authBtn.textContent = auth === 'authorized' ? '重新授权' : '去终端授权';
  };

  const refreshBoth = (r) => {
    LARKCLI.data = r;
    LARKCLI.checkedAt = Date.now();
    renderLarkCliResult();
    paint(r);
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // 不带 check=1：纯本地探测（detect + auth status），轮询绝不能把 npm registry 打爆
      refreshBoth(await api('GET', '/api/lark-cli'));
      polls++;
      const ok = LARKCLI.data?.installed && LARKCLI.data?.auth?.state === 'authorized';
      // 重新授权场景（打开弹窗时就已授权）不能一进来就判「完成」——终端的 device flow 还没跑完，
      // 此时只持续刷新状态，由用户看终端结果后自行关闭。
      if (ok && !wasAuthorized) {
        stop(op === 'auth' ? '✅ 授权完成，可以关闭本弹窗了。' : '✅ 安装并授权完成，可以关闭本弹窗了。');
      } else if (polls >= POLL_MAX) {
        stop(ok ? '本次自动检测到此为止，终端流程应已完成。' : '自动检测已停止（超时），可点「检测」手动刷新。');
      }
    } catch {
      // 静默重试：一键更新会重启桥接器，轮询撞上失联窗口属预期，弹错反而吓人
    } finally { busy = false; }
  };

  const doCheck = async () => {
    if (busy) return;
    busy = true;
    statEl.innerHTML = '<span class="hint">检测中…</span>';
    try {
      refreshBoth(await api('GET', '/api/lark-cli'));
    } catch (e) {
      statEl.innerHTML = `<span class="hint">检测失败：${esc(e.message)}</span>`;
    } finally { busy = false; }
  };

  const close = () => {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    unbind();
    unmount();
  };
  const unbind = bindDialogKeys((k) => { if (k === 'Escape') close(); });
  mask.querySelector('[data-lkt="close"]').onclick = close;
  mask.querySelector('[data-lkt="check"]').onclick = () => void doCheck();
  authBtn.onclick = () => { close(); void larkCliActionFlow('auth'); };
  mask.onclick = (e) => { if (e.target === mask) close(); };
  timer = setInterval(tick, POLL_MS);
  void tick(); // 立即给一次现状：安装 / 配置流程下可直接看到「完成」并停止轮询
}

async function larkCliActionFlow(op = 'install') {
  const meta = {
    install: {
      what: '安装',
      msg: '将打开一个终端窗口依次执行：<code>npm install -g @larksuite/cli</code>、官方 SKILL 安装、'
        + '（未配置应用时）<code>lark-cli config init --new</code> 配置向导、<code>lark-cli auth login</code> 授权登录。'
        + '<br><br>若本机没有可用终端（无桌面 / SSH 会话），会自动降级为后台静默安装。',
    },
    update: {
      what: '更新',
      msg: '将打开一个终端窗口更新 lark-cli 并顺势完成官方 SKILL 安装、（未配置应用时）配置向导与授权登录。'
        + '<br><br>若本机没有可用终端（无桌面 / SSH 会话），会自动降级为后台静默安装。',
    },
    auth: {
      what: '授权登录',
      msg: '将打开一个终端窗口执行 <code>lark-cli auth login --recommend</code>：按窗口里的提示在浏览器或飞书中确认即可。'
        + '<br><br>已授权时也可重跑（用于刷新授权、补勾选新权限）。'
        + '<br><br>若本机没有可用终端（无桌面 / SSH 会话），需在服务器上手动执行该命令。',
    },
    config: {
      what: '配置应用',
      // 这是**备选**路径：主路径是弹窗里的配置二维码（见 larkcli-device.js 的 config 阶段），
      // 只有用户在弹窗里显式点「改用终端窗口」才会走到这里
      msg: '将打开一个终端窗口执行 <code>lark-cli config init --new</code>：按窗口打印的链接在浏览器完成飞书应用创建，'
        + '完成后会自动进入授权登录。'
        + '<br><br>若本机没有可用终端（无桌面 / SSH 会话），需在服务器上手动执行该命令。',
    },
    skill: {
      what: 'SKILL 安装',
      msg: '将后台执行 <code>npx skills add https://open.feishu.cn</code> 安装飞书官方 SKILL（教 AI 工具怎么用 lark-cli）。'
        + '<br><br>安装完成后需<b>重启桥接器</b>，飞书会话才能看到该 SKILL。',
    },
  };
  const { what, msg } = meta[op] || meta.install;
  if (!(await confirmDialog({ title: `飞书 CLI ${what}`, message: msg, confirmText: '开始' }))) return;
  const rowBtn = $('#larkCliArea button');
  if (rowBtn) rowBtn.disabled = true;
  // 先弹进度框再发请求：静默降级那条路最长 5 分钟，没有它页面会静默无反馈
  const dlg = progressDialog({
    title: `飞书 CLI ${what}`,
    note: op === 'skill' ? '正在安装 SKILL…' : '正在探测可用终端…',
    reportMaxHeight: op === 'skill' ? 360 : 220, // SKILL 要列 28 条名单，默认 220px 只够十来行
  });
  try {
    const r = await api('POST', '/api/lark-cli/action', { op });
    if (r.mode === 'terminal') {
      dlg.unmount(); // 交给终端弹窗，两者不叠加
      openLarkCliTerminalDialog(op);
      toast('已拉起终端窗口，请在终端里完成操作');
    } else {
      // SKILL 装完展示扫盘得到的名单，而不是 npx 那段带 ANSI 的进度表原文
      // （名单由后端 listLarkCliSkills 扫 ~/.claude/skills 得出，比解析输出可靠）
      if (op === 'skill' && Array.isArray(r.skills) && r.skills.length) {
        dlg.setNote(`已同步 ${r.skills.length} 个 SKILL\n\n`
          + r.skills.map((s) => `• ${s}`).join('\n'));
      } else {
        dlg.setNote(String(r.output || '').trim().slice(-600) || '完成');
      }
      if (r.reason) dlg.appendLog(`⚠️ 未使用终端：${r.reason}`);
      const done = op === 'skill' ? '✅ SKILL 安装完成，重启桥接器后飞书会话可见' : `✅ 飞书 CLI ${what}完成`;
      dlg.finish(true, done);
      dlg.onClose(() => { void refresh(); });
      toast(done);
    }
    await doCheckLarkCli();
  } catch (e) {
    dlg.appendLog(`❌ ${e.message}`);
    dlg.finish(false, `❌ 飞书 CLI ${what}失败`);
    dlg.onClose(() => renderLarkCliResult());
  } finally {
    if (rowBtn) rowBtn.disabled = false;
  }
}

// ============ 开机自启开关（GET/POST /api/autostart；注册状态以 OS 查询为权威） ============
function paintAutostart(el, r) {
  const tags = r.enabled
    ? '<span class="tag ok">已开启</span>'
    : '<span class="tag off">未开启</span>';
  // 只留开关 + 状态 tag + 过期警示；各平台的「登录启动管理方式」说明文案一律不显示（主人拍板）
  const stale = r.stale ? ' <span class="tag warn">启动命令已过期，关闭再开启可更新</span>' : '';
  el.innerHTML = `<span class="switch-row" style="margin:0"><label class="switch"><input type="checkbox" id="asToggle" ${r.enabled ? 'checked' : ''}><span class="track"></span></label>${tags}${stale}</span>`;
  $('#asToggle').onchange = async (e) => {
    const on = e.target.checked;
    try {
      const res = await api('POST', '/api/autostart', { enabled: on });
      toast(on ? '✅ 已注册开机自启（下次登录时自动启动）' : '已关闭开机自启');
      paintAutostart(el, res);
    } catch (err) {
      toast(err.message, true);
      e.target.checked = !on; // 失败回滚开关视觉态（注册失败不能显示为已开）
    }
  };
}

/** LCB 更新卡内「开机自启」行：首次渲染拉状态；开关点击即生效（低风险，即时保存） */
async function renderAutostart() {
  const el = $('#asStat');
  if (!el) return;
  let r;
  try {
    r = await api('GET', '/api/autostart');
  } catch (e) {
    el.innerHTML = `<span class="hint">检测失败：${esc(e.message)}</span>`;
    return;
  }
  if (!r.supported) {
    el.innerHTML = `<span class="tag off">不支持</span><span class="hint">${esc(r.detail || '当前运行方式不支持开机自启，请手动运行 lcb start')}</span>`;
    return;
  }
  paintAutostart(el, r);
}

// ============ 运行日志查看器（快捷时间切换 + 截止天优先 + 关键字全范围检索） ============
async function logViewer() {
  const pad2 = (n) => String(n).padStart(2, '0');
  const dpart = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const tpart = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const at = (dayOffset, h, m) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d; };
  /** 快捷档 → [开始, 结束]（Date） */
  const QUICKS = {
    today: () => [at(0, 0, 0), at(0, 23, 59)],
    yesterday: () => [at(-1, 0, 0), at(-1, 23, 59)],
    week: () => [at(-6, 0, 0), at(0, 23, 59)],
  };
  openDrawer({
    title: '运行日志',
    bodyHtml: `
      <div class="subtabs" id="lgChips" style="margin-bottom:10px">
        <button data-q="today" class="active">今天</button>
        <button data-q="yesterday">昨天</button>
        <button data-q="week">最近7天</button>
        <button data-q="custom">自定义</button>
      </div>
      <div id="lgCustom" style="display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <input type="datetime-local" id="lgFrom" style="width:210px;padding:5px 10px;font-size:12.5px">
        <span class="mut" style="font-size:12.5px">至</span>
        <input type="datetime-local" id="lgTo" style="width:210px;padding:5px 10px;font-size:12.5px">
        <button class="btn sm primary" id="lgQuery">查询</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px" title="勾选后显示所选时间范围内的全部日志；默认只显示截止那天的日志"><input type="checkbox" id="lgAll"> 显示整个范围</label>
        <select id="lgLevel" style="width:auto;padding:5px 10px;font-size:12.5px">
          <option value="all">全部级别</option>
          <option value="INFO">Info</option>
          <option value="WARN">Warn</option>
          <option value="ERROR">Error</option>
        </select>
        <input type="search" id="lgQ" placeholder="关键字（在时间范围内检索）…" style="width:200px;padding:5px 10px;font-size:12.5px">
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px"><input type="checkbox" id="lgAuto" checked> 自动滚动</label>
        <span style="flex:1"></span>
        <button class="btn sm" id="lgRefresh">↻ 刷新</button>
        <button class="btn sm" id="lgCopy">复制</button>
        <button class="btn sm" id="lgDownload">下载</button>
      </div>
      <pre id="lgView" style="background:#0d1117;color:#c9d4e6;border:1px solid var(--border);border-radius:10px;padding:14px 16px;font-family:var(--mono);font-size:12px;line-height:1.8;overflow:auto;max-height:calc(100vh - 340px);white-space:pre-wrap;word-break:break-all;margin:0">加载中…</pre>
      <div class="mini-note" style="margin-top:8px" id="lgNote">默认只显示截止那天的日志；输入关键字或勾选「显示整个范围」时才检索所选范围（最多 7 天）。日志按天落盘于 <code>~/.lark-claudecode-bridge/logs/</code>，14 天前自动清理。</div>`,
    footHtml: `<span class="sp"></span><button class="btn" id="lgClose">关闭</button>`,
  });
  $('#lgClose').onclick = closeDrawer;
  const lvlColor = (l) => (l === 'ERROR' ? '#ff8f94' : l === 'WARN' ? '#ffb45e' : '#7d8aa5');
  /** 行首日期（YYYY-MM-DD）/ 时刻，解析失败返回 null（该行只受关键字/级别过滤） */
  const lineDay = (t) => t.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
  const lineTime = (t) => {
    const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    return m ? new Date(`${m[1]}T${m[2]}`).getTime() : null;
  };
  let allLines = [];     // 后端返回的时间范围内的全部行（按时间序）
  let rangeFrom = null;  // Date
  let rangeTo = null;    // Date

  /** 视图行 = 时间窗（默认只显截止天）∩ 级别 ∩ 关键字 */
  const viewLines = () => {
    const lv = $('#lgLevel').value;
    const q = $('#lgQ').value.trim().toLowerCase();
    const wantAll = $('#lgAll').checked || !!q;
    const fromMs = rangeFrom?.getTime();
    const toMs = rangeTo?.getTime();
    const toDay = rangeTo ? dpart(rangeTo) : '';
    const timeOk = (t) => {
      if (wantAll) {
        if (fromMs != null) { const ts = lineTime(t); if (ts != null && ts < fromMs) return false; }
        if (toMs != null) { const ts = lineTime(t); if (ts != null && ts > toMs) return false; }
        return true;
      }
      // 默认：只看截止那天（且不超过结束时刻）
      if (toDay && lineDay(t) !== toDay) return false;
      if (toMs != null) { const ts = lineTime(t); if (ts != null && ts > toMs) return false; }
      return true;
    };
    return allLines.filter((t) => timeOk(t)
      && ((lv === 'all' || (t.match(/\b(ERROR|WARN|INFO|DEBUG)\b/)?.[1] || 'INFO') === lv))
      && (!q || t.toLowerCase().includes(q)));
  };

  const paintView = () => {
    const rows = viewLines();
    $('#lgView').innerHTML = (rows.length ? rows : ['（无匹配日志行）']).map((t) => {
      const m = t.match(/\b(ERROR|WARN|INFO|DEBUG)\b/);
      const level = m ? m[1] : 'INFO';
      const i = m ? t.indexOf(m[1]) : -1;
      if (i < 0) return esc(t);
      return `<span style="color:${lvlColor(level)};font-weight:600">${esc(t.slice(0, i + level.length))}</span><span>${esc(t.slice(i + level.length))}</span>`;
    }).join('\n');
    if ($('#lgAuto').checked) { const v = $('#lgView'); v.scrollTop = v.scrollHeight; }
  };

  const setNote = (extra) => {
    const q = $('#lgQ').value.trim();
    const wantAll = $('#lgAll').checked;
    const span = rangeFrom && rangeTo ? `${dpart(rangeFrom)} ${tpart(rangeFrom)} ~ ${dpart(rangeTo)} ${tpart(rangeTo)}` : '';
    $('#lgNote').innerHTML = `范围 ${esc(span)}；当前显示：${q ? '关键字命中的整个范围' : wantAll ? '整个范围' : '截止那天'}（${allLines.length} 行已载入${extra ? `，${extra}` : ''}）`;
  };

  const loadRange = async () => {
    const fromV = $('#lgFrom').value;
    const toV = $('#lgTo').value;
    if (!fromV || !toV) { $('#lgView').textContent = '请选择开始与结束时间'; return; }
    const from = new Date(fromV);
    const to = new Date(toV);
    if (to < from) { $('#lgView').textContent = '结束时间不能早于开始时间'; return; }
    if ((dpart(to) - dpart(from)) / 86_400_000 > 6) {
      $('#lgView').textContent = '抱歉，最多只能搜索7天范围内日志，请重新选择时间';
      return;
    }
    $('#lgView').textContent = '加载中…';
    try {
      const r = await api('GET', `/api/logs/content?from=${encodeURIComponent(dpart(from))}&to=${encodeURIComponent(dpart(to))}&lines=2000`);
      allLines = r.lines || [];
      rangeFrom = from;
      rangeTo = to;
      setNote(`${r.files.length} 个日志文件${r.truncated ? '，日志量大仅显示末尾部分' : ''}`);
      paintView();
    } catch (e) {
      allLines = [];
      $('#lgView').textContent = `加载失败：${e.message}`;
    }
  };

  /** 快捷档：设置起止时间并立即查询 */
  const applyQuick = (key) => {
    let from; let to;
    if (key === 'custom') {
      $('#lgCustom').style.display = 'flex';
      return; // 自定义等手动改完点「查询」
    }
    $('#lgCustom').style.display = 'none';
    [from, to] = QUICKS[key]();
    $('#lgFrom').value = `${dpart(from)}T${tpart(from)}`;
    $('#lgTo').value = `${dpart(to)}T${tpart(to)}`;
    void loadRange();
  };

  $('#lgChips').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('#lgChips').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      applyQuick(b.dataset.q);
    };
  });
  $('#lgQuery').onclick = () => void loadRange();
  $('#lgLevel').onchange = paintView;
  $('#lgQ').oninput = paintView;
  $('#lgAll').onchange = () => { paintView(); setNote(); };
  $('#lgAuto').onchange = paintView;
  $('#lgRefresh').onclick = () => void loadRange();
  $('#lgCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(viewLines().join('\n')); toast('当前视图日志已复制到剪贴板'); }
    catch { toast('复制失败（浏览器剪贴板权限）', true); }
  };
  $('#lgDownload').onclick = () => {
    const blob = new Blob([viewLines().join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lcb-logs-${($('#lgFrom').value || 'start').replace(/[:T]/g, '')}-${($('#lgTo').value || 'end').replace(/[:T]/g, '')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  applyQuick('today'); // 默认今天
}

// ============ 页面 ============
export const page = {
  id: 'overview',
  title: '概览',
  desc: '桥接器运行状态、版本与快捷入口',
  icon: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  async render(el) {
    const st = S.status || {};
    const stale = !st.bridge; // 旧版本进程（API 无 bridge 字段）：进程托管功能整体不可用
    const br = stale ? { running: st.embedded === true, pid: null, spawnable: false } : st.bridge;
    const claudeReady = st.claude?.hasAuth !== false && st.claude?.hasAuth !== null;
    const tile = ({ dot, dstate, name, sub, icon, actions = '', id = '' }) => `
      <div class="tile"${id ? ` id="${id}"` : ''}>
        <div class="tile-top"${id ? ` id="${id}Top"` : ''}><span class="dot ${dot}"></span><span class="tile-state" style="color:var(--${dot}-tx)">${dstate}</span><span class="tile-ico">${svg(icon, 16)}</span></div>
        <div class="tile-name">${name}</div>
        <div class="tile-sub"${id ? ` id="${id}Sub"` : ''} title="${esc(sub)}">${sub}</div>
        <div class="tile-actions">${actions}</div>
      </div>`;
    const brCtl = stale
      ? '<span class="hint">进程为旧版本，启停不可用</span>'
      : br.spawnable === false
        ? '<span class="hint">当前运行方式不支持页面托管启停</span>'
        : br.running
          ? '<button class="btn" id="btnBrRestart">重启</button><button class="btn danger" id="btnBrStop">停止</button>'
          : '<button class="btn primary" id="btnBrStart">启动</button>';
    el.innerHTML = `
    <div class="tiles">
      ${tile({
        dot: br.running ? 'ok' : 'off',
        dstate: br.running ? '运行中' : (stale && st.embedded ? '运行中（旧版本）' : '未运行'),
        name: '桥接器进程',
        sub: br.running ? `PID ${br.pid ?? '?'} · ${st.embedded ? '随 lcb start 常驻' : '独立页面托管'}` : (st.embedded ? '随 lcb start 常驻' : '独立页面托管'),
        icon: IC.apps,
        actions: brCtl,
      })}
      ${tile({
        dot: claudeReady ? 'ok' : 'err',
        dstate: st.claude?.hasAuth === null ? '未知' : claudeReady ? '已就绪' : '未认证',
        name: 'Claude 认证',
        sub: `${st.claude?.mode === 'managed' ? 'bridge 托管' : '继承本机'} · ${esc(st.claude?.current?.model || 'CLI 默认')}`,
        icon: IC.claude,
        actions: '<button class="btn" data-go="claude">管理</button>',
      })}
      ${tile({
        dot: 'off',
        dstate: '检测中',
        name: '飞书 CLI',
        sub: '安装 / 授权状态检测中…',
        icon: IC.zap,
        actions: '<button class="btn" id="tileCliAuth">授权</button>',
        id: 'tileCli',
      })}
      ${tile({
        dot: 'off',
        dstate: '检测中',
        name: '记忆增强',
        sub: 'OpenViking 记忆服务检测中…',
        icon: IC.memory,
        actions: '<button class="btn" data-go="memory">管理</button>',
      })}
    </div>

    <div class="grid2" style="gap:16px;align-items:stretch;margin-bottom: 16px;">
      <div class="panel" style="margin:0">
        <header class="panel-head"><h3>LCB 桥接器 · 版本与更新</h3>
          <div class="panel-actions" id="updLatest"><span class="hint">未检查</span></div>
        </header>
        <div class="panel-body">
          <table class="kv">
            <tr><td>当前版本</td><td><span class="chip">v${esc(st.version)}</span></td></tr>
            <tr><td>运行模式</td><td>${st.embedded ? '随 lcb start 常驻' : 'lcb ui 独立页面'}</td></tr>
            <tr><td>配置文件</td><td><code>${esc(st.configPath)}</code></td></tr>
            <tr><td>开机自启</td><td id="asStat"><span class="hint">检测中…</span></td></tr>
          </table>
          <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
            <button class="btn sm" id="btnUpdCheck">检查更新</button>
            <span id="updArea"></span>
          </div>
        </div>
      </div>
      <div class="panel" style="margin:0">
        <header class="panel-head"><h3>飞书 CLI · 版本与更新</h3>
          <div class="panel-actions"><button class="btn sm" id="btnCliCheck">检查更新</button></div>
        </header>
        <div class="panel-body">
          <table class="kv">
            <tr><td>当前状态</td><td id="larkCliStat"><span class="hint">检测中…</span></td></tr>
          </table>
          <div class="mini-note" style="margin-top:10px">飞书官方 CLI（@larksuite/cli）负责设备授权与应用配置；与 LCB 桥接器的更新相互独立、各走各的按钮。</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <header class="panel-head"><h3>飞书快捷指令</h3>
        <div class="panel-actions"><button class="btn sm" data-go="slash">管理命令 →</button></div>
      </header>
      <div class="panel-body" style="padding-top:8px">
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${(st.commands || []).map((c) => `<span class="chip src" style="font-size:12.5px;padding:4px 12px">/${esc(c.command)}<span class="mut" style="margin-left:4px">${esc(c.description)}</span></span>`).join('')}
        </div>
        <div class="mini-note" style="margin-top:10px">在飞书聊天框输入 / 触发；其它 / 开头的消息原文透传给 Claude Code。</div>
      </div>
    </div>

    <div class="panel">
      <header class="panel-head"><h3>常用指引</h3></header>
      <div class="panel-body">
        <div class="mini-note">飞书端与机器人对话即可使用；<code>/help</code> 查看全部命令。配置修改后：<b>应用 / 认证 / server 段需重启 lcb start</b>，工作区 / 权限 / 触发词下一条消息自动生效。${st.claude?.hasAuth === false ? '<br>⚠️ 未检测到 Claude 认证：到「Claude 认证」页配置，或在配置页所在机器执行 claude login。' : ''}</div>
      </div>
    </div>`;
    $('#pageActions').innerHTML = `<button class="btn primary" id="btnOpenLog">${svg(IC.file, 14)} 查看日志</button>`;
    // 页头按钮在 #view 之外，需单独绑定（绑在 #view 委托上会因不在容器内而永远收不到事件）
    $('#btnOpenLog').onclick = () => void logViewer();

    // ---- 瓦片与跳转 ----
    el.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => { location.hash = b.dataset.go; });
    const bind = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    bind('#btnBrStart', startFlow); bind('#btnBrStop', stopFlow); bind('#btnBrRestart', restartFlow);
    bind('#btnUpdCheck', doCheckUpdate);
    bind('#btnCliCheck', () => void doCheckLarkCli());
    $('#tileCliAuth').onclick = () => (
      LARKCLI.data && !LARKCLI.data.installed ? void larkCliActionFlow('install') : openDeviceDialog()
    );
    // 自动检查 30s 节流（切回概览 tab 不重复打 npm）
    if (UPD.data && Date.now() - UPD.checkedAt < 30000) renderUpdateResult();
    else doCheckUpdate();
    if (LARKCLI.data && Date.now() - LARKCLI.checkedAt < 30000) renderLarkCliResult();
    else void doCheckLarkCli();
    void renderAutostart();

    // ---- 记忆增强瓦片：异步补状态（失败静默保留「检测中」） ----
    void (async () => {
      let ms = null;
      try { ms = await api('GET', '/api/memory/status'); } catch { /* 首装/服务未装：瓦片保持未就绪 */ }
      const tileEl = [...el.querySelectorAll('.tile')].find((t) => t.querySelector('.tile-name')?.textContent === '记忆增强');
      if (!tileEl) return;
      const m = ms?.memory || {};
      const healthy = !!ms?.health?.healthy;
      const dot = m.enabled === false ? 'off' : healthy ? 'ok' : 'warn';
      const dstate = m.enabled === false ? '已停用' : healthy ? '运行中' : '服务异常';
      const sub = healthy ? `OpenViking · ${m.endpoint || ''}` : (m.enabled === false ? '未启用（可在记忆增强页开启）' : '未就绪——到记忆增强页检查或启动');
      tileEl.querySelector('.tile-top').innerHTML = `<span class="dot ${dot}"></span><span class="tile-state" style="color:var(--${dot}-tx)">${dstate}</span><span class="tile-ico">${svg(IC.memory, 16)}</span>`;
      const subEl = tileEl.querySelector('.tile-sub');
      subEl.textContent = sub;
      subEl.title = sub;
    })();
  },
};
