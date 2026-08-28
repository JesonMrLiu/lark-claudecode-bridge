# lark-claudecode-bridge

飞书 ↔ Claude Code 桥接器：在飞书里遥控本机 Claude Code。
写操作以卡片按钮确认（长连接回调），结果文本与产出文件回传飞书。
**无需公网 IP、无需内网穿透；模型自由（订阅 / API Key / 第三方端点均可）。**

## 特性

- 私聊 / 群聊 @机器人 触发；群聊多人可用（配对 + 白名单访问控制）
- 写操作确认卡片：允许 / 拒绝 / 本次会话不再询问（仅任务发起人可点）
- 流式进度卡片（打字机效果 + 工具调用 + 运行心跳，静默不等于卡死）
- 结果文本 + 产出文件回传（图片预览、>10 文件自动 zip）
- 多工作区切换（/ws）、会话管理（/new /resume）、/stop 打断
- 通道并发（默认 3），通道内串行

## 前置条件

1. Node.js ≥ 20
2. Claude Code CLI 可用：终端 `claude "hi"` 能正常回复（任意鉴权方式：
   订阅 `claude login` / `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 第三方端点如 GLM——桥接器透传环境变量，不介入鉴权）

## 安装

```bash
npm install -g @jesonliu/lark-claudecode-bridge
lcb setup
lcb start
```

## 飞书应用配置（图文）

1. https://open.feishu.cn → 创建企业自建应用 → 添加「机器人」能力
2. 权限管理开通：`im:message`、`im:message:send_as_bot`、`im:resource`、`contact:user.base:readonly`
3. 事件与回调 → 事件配置 → 订阅方式选「使用长连接接收事件」→ 添加 `im.message.receive_v1`
4. 事件与回调 → 卡片交互配置 → 同样选择长连接
5. 凭证与基础信息 → 复制 App ID / App Secret
6. 版本管理与发布 → 创建版本并发布，管理员审核通过
7. 运行 `lcb setup` 填入凭证 → `lcb start` → 私聊机器人发「/help」

## 首次配对

第一个发消息的用户会收到 6 位配对码（15 分钟内有效），在 `lcb start` 的终端里输入该码回车即批准（首个批准者自动成为 admin）。或另开终端 `lcb pair <code>`（注意：独立进程批准后，运行中的桥需重启才能识别新用户，推荐直接在运行终端输入）。

## lcb 命令

| 命令 | 说明 |
|---|---|
| `lcb setup` | 引导式配置（写入 `~/.lark-claudecode-bridge/config.yaml`） |
| `lcb start` | 启动桥接器（前台，终端可直接输入配对码批准） |
| `lcb pair <code>` | 另开终端批准 6 位配对码 |
| `lcb version` | 查看版本 |

## 命令速查（飞书里发给机器人）

| 命令 | 说明 |
|---|---|
| /new | 开新会话 |
| /resume | 列出/恢复历史会话（`/resume <编号>` 恢复指定会话） |
| /stop | 停止当前任务 |
| /status | 当前状态 |
| /ws list / /ws use \<名字\> | 工作区（切换仅 admin 可用） |
| /help | 帮助 |

## 配置文件 ~/.lark-claudecode-bridge/config.yaml

`lcb setup` 会引导生成，也可手动编辑。字段说明见仓库内 `config.example.yaml`：

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

## ⚠️ 安全须知（必读）

本机 Claude Code 是共用资源：白名单用户可通过确认卡片让它在你电脑执行任意命令。
请只批准信任的人；工作区白名单、用户白名单、写操作确认三道闸不要关闭。

## 常驻运行

- **Windows**：任务计划程序建「开机时启动」任务，程序指向下面的 `windows-start.bat`（先放到固定位置，如 `C:\tools\lcb\windows-start.bat`）
- **macOS**：launchd——把 `com.lark-claudecode-bridge.plist` 放到 `~/Library/LaunchAgents/`，然后 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lark-claudecode-bridge.plist`
- **Linux**：systemd user 单元——把 `lark-claudecode-bridge.service` 放到 `~/.config/systemd/user/`，然后 `systemctl --user daemon-reload && systemctl --user enable --now lark-claudecode-bridge`

模板全文（npm 包内 `deploy/` 目录，或仓库 [deploy/](deploy/)）：

**deploy/windows-start.bat**

```bat
@echo off
lcb start >> "%USERPROFILE%\.lark-claudecode-bridge\bridge.log" 2>&1
```

**deploy/com.lark-claudecode-bridge.plist**

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

**deploy/lark-claudecode-bridge.service**

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

## 已知限制

1. **Linux 上 >10 文件不打 zip**：文件打包用 `tar -a`（按扩展名选容器），Windows 10+ / macOS 自带的 bsdtar 支持 zip 容器；Linux 的 GNU tar 不支持创建 zip，会自动退化为逐个上传文件（功能不丢，只是消息条数多）。
2. **access.json 多进程并发写为 last-writer-wins**：`lcb pair` 独立进程与运行中的桥同时批准配对时，两边各自整盘写回 `~/.lark-claudecode-bridge/access.json`，极端情况下可能互相覆盖（如一侧刚批准的用户在另一侧写回后丢失）。日常使用（在 `lcb start` 终端里输码批准）不受影响；如遇丢失，重新配对即可。

## 开发

```bash
npm install
npm test          # vitest 全量单测
npm run build     # tsc → dist/
node dist/bin/lcb.js version
```

发布前真机验证清单见 [docs/e2e-checklist.md](docs/e2e-checklist.md)。

## License

MIT
