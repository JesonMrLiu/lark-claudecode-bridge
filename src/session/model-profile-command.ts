// /model-profile 飞书端厂商档案命令：查看多厂商档案清单 / 切换当前生效档案。
// 权限分级（与 /plugin 一致）：查看对所有成员开放；切换仅 admin（改的是全局认证配置）。
// 切换内核复用 claude-profile.ts 的 switchProfile（配置页「设为当前」同款），
// 从盘上现读配置渲染清单——切换后下一条 /model-profile 立即反映真实状态
import { CONFIG_PATH, loadConfig } from '../config.js';
import { isProfileActive, switchProfile } from '../claude-profile.js';

export interface ModelProfileCommandDeps {
  isAdmin: boolean;
  /** 缺省 CONFIG_PATH；测试注入临时路径 */
  configPath?: string;
}

/** 档案行渲染：凭证只显类型不显值（聊天记录可能被转发/检索） */
function profileRow(line: number, name: string, cred: string, baseUrl: string | undefined, models: number, active: boolean): string {
  const desc = [cred, baseUrl, models > 0 ? `候选 ${models} 模型` : null].filter(Boolean).join(' · ');
  return `${line}. ${name}（${desc}）${active ? ' ← 当前' : ''}`;
}

export function handleModelProfileCommand(args: string[], deps: ModelProfileCommandDeps): string {
  const name = args.join(' ').trim();

  if (!name) {
    let config;
    try {
      config = loadConfig(deps.configPath);
    } catch (e) {
      return `配置加载失败：${e instanceof Error ? e.message : String(e)}`;
    }
    const profiles = config.claude?.profiles ?? [];
    const mode = config.claude?.mode ?? 'inherit';
    if (profiles.length === 0) {
      return '尚无厂商档案。请在配置页「Claude 认证」→「厂商档案」中添加（浏览器打开配置页，managed 模式下可管理多厂商凭证与候选模型）';
    }
    // 当前生效档案浮到第一行（找「现在用的是谁」无须翻列表），其余保持配置原序（sort 稳定）
    const lines = [...profiles]
      .sort((a, b) => Number(isProfileActive(config.claude, b)) - Number(isProfileActive(config.claude, a)))
      .map((p, i) => profileRow(
        i + 1,
        p.name,
        p.authToken ? 'AUTH_TOKEN' : p.apiKey ? 'API_KEY' : '未配凭证',
        p.baseUrl,
        p.models?.length ?? 0,
        isProfileActive(config.claude, p),
      ));
    return [
      `**厂商档案**（认证模式：${mode}）`,
      ...lines,
      '',
      `切换：/model-profile <名字>（仅管理员）${mode === 'inherit' ? '\n⚠️ 当前 inherit 模式：切换只记录配置，切到 managed 后才生效' : '，下一条任务消息即生效'}`,
      '档案管理：配置页「Claude 认证」；会话级模型切换：/model',
    ].join('\n');
  }

  if (!deps.isAdmin) {
    return '⛔ 切换厂商档案仅管理员可用（查看清单可直接 /model-profile）';
  }
  const r = switchProfile(deps.configPath ?? CONFIG_PATH, name);
  return r.ok ? `✅ ${r.message}` : `❌ ${r.error}`;
}
