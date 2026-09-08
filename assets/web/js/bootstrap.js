// ============ 首装向导（bootstrap；非 tab 页，由 main.js 在 firstRun 时渲染） ============
import { $, toast, api, refresh } from './core.js';
import { pickDirectory } from './ui.js';

export function renderBootstrap(el) {
  el.innerHTML = `
  <div class="card">
    <h3>👋 欢迎使用 lark-claudecode-bridge</h3>
    <div class="desc">首次安装：完成下面三步即可开始使用。需要先在 <a href="https://open.feishu.cn/app" target="_blank">飞书开放平台</a> 创建应用并启用机器人能力（详见 README）。建议为每个应用填写名字——概览页与飞书 /status 将显示该名字，缺省显示 App ID。</div>
    <h3 style="margin-top:16px">① 飞书应用凭证</h3>
    <div id="bsApps"></div>
    <button class="btn sm" id="bsAddApp">+ 再添一个应用（多机器人）</button>
    <h3 style="margin-top:20px">② 本机工作区（Claude 的工作目录）</h3>
    <div class="row">
      <div><label>名字（如 demo）</label><input type="text" id="bsWsName" placeholder="demo"></div>
      <div><label>本机绝对路径</label>
        <div class="input-btn">
          <input type="text" id="bsWsPath" placeholder="F:\\workspace\\demo">
          <button class="btn sm" id="bsWsBrowse" title="浏览选择目录">浏览</button>
        </div>
      </div>
    </div>
    <h3 style="margin-top:20px">③ Claude 认证（可稍后在「Claude 认证」页配置）</h3>
    <div class="radio-row">
      <label><input type="radio" name="bsMode" value="skip" checked> 使用本机已有 ~/.claude 登录</label>
      <label><input type="radio" name="bsMode" value="managed"> 填 API Key / Token（无需本机登录）</label>
    </div>
    <div id="bsManaged" style="display:none">
      <div class="radio-row">
        <label><input type="radio" name="bsCred" value="auth_token" checked> AUTH_TOKEN（中转站常用）</label>
        <label><input type="radio" name="bsCred" value="api_key"> API_KEY（官方）</label>
      </div>
      <div class="row">
        <div><label id="bsCredLabel">Auth Token</label><input type="password" id="bsCred" placeholder="sk-…"></div>
        <div><label>BASE_URL（中转站端点，官方留空）</label><input type="text" id="bsBaseUrl" placeholder="https://relay.example.com"></div>
      </div>
      <label>模型（如 claude-sonnet-5，可留空）</label><input type="text" id="bsModel" placeholder="claude-sonnet-5">
    </div>
    <div style="margin-top:20px">
      <button class="btn primary" id="bsSubmit" style="padding:9px 28px">完成配置</button>
      <span class="hint">提交后运行 <code>lcb start</code> 启动桥接器</span>
    </div>
  </div>`;
  const appsBox = $('#bsApps');
  const addAppRow = () => {
    const div = document.createElement('div');
    div.className = 'row';
    div.style.marginBottom = '8px';
    div.innerHTML = `
      <div><label>App ID（cli_ 开头）</label><input type="text" class="bs-appid" placeholder="cli_aabbccddeeff0011"></div>
      <div><label>应用名字（建议填写）</label><input type="text" class="bs-name" placeholder="如：素材收集（概览/状态页显示用）"></div>
      <div><label>App Secret</label><input type="password" class="bs-secret" placeholder=""></div>
      <div class="btn-wrap"><button class="btn sm danger bs-del">删除</button></div>`;
    div.querySelector('.bs-del').onclick = () => div.remove();
    appsBox.appendChild(div);
  };
  addAppRow();
  $('#bsAddApp').onclick = addAppRow;
  $('#bsWsBrowse').onclick = async () => {
    const picked = await pickDirectory($('#bsWsPath').value.trim());
    if (picked != null) $('#bsWsPath').value = picked;
  };
  document.querySelectorAll('input[name=bsMode]').forEach((r) => r.onchange = () => {
    $('#bsManaged').style.display = $('[name=bsMode]:checked').value === 'managed' ? '' : 'none';
  });
  document.querySelectorAll('input[name=bsCred]').forEach((r) => r.onchange = () => {
    $('#bsCredLabel').textContent = $('[name=bsCred]:checked').value === 'api_key' ? 'API Key' : 'Auth Token';
  });
  $('#bsSubmit').onclick = async () => {
    const apps = [...appsBox.querySelectorAll('.row')].map((row) => {
      const appId = row.querySelector('.bs-appid').value.trim();
      const name = row.querySelector('.bs-name').value.trim();
      const secret = row.querySelector('.bs-secret').value.trim();
      return { app_id: appId, ...(name ? { name } : {}), app_secret: secret };
    }).filter((a) => a.app_id && a.app_secret);
    const ws = { name: $('#bsWsName').value.trim(), path: $('#bsWsPath').value.trim() };
    if (!apps.length) return toast('至少需要一个有效的应用（App ID + App Secret）', true);
    if (!ws.name || !ws.path) return toast('工作区名字与路径不能为空', true);
    const body = { apps, workspace: ws };
    if ($('[name=bsMode]:checked').value === 'managed') {
      const cred = $('[name=bsCred]:checked').value;
      const val = $('#bsCred').value.trim();
      if (!val) return toast('请填写 Auth Token / API Key', true);
      body.claude = { mode: 'managed', [cred]: val };
      const baseUrl = $('#bsBaseUrl').value.trim();
      const model = $('#bsModel').value.trim();
      if (baseUrl) body.claude.base_url = baseUrl;
      if (model) body.claude.model = model;
    }
    try {
      const r = await api('POST', '/api/bootstrap', body);
      toast(r.message || '配置完成');
      await refresh();
      toast('✅ 配置已写入，请运行 lcb start（若正在运行请重启）');
    } catch (e) { toast(e.message, true); }
  };
}
