# lark-claudecode-bridge

飞书 ↔ Claude Code 桥接器：在飞书里遥控本机 Claude Code。
写操作以卡片按钮确认（长连接回调），结果文本与产出文件回传飞书。
**无需公网 IP、无需内网穿透；模型自由（订阅 / API Key / 第三方端点均可）。**

## 特性

- 私聊 / 群聊 @机器人 触发；群聊多人可用（配对 + 白名单访问控制）
- **多机器人**：一个进程同时跑 N 个飞书机器人，各自独立会话池、独立并发、独立 Claude Code 实例（会话存储/设置/插件/模型凭证互不共享）
- 写操作确认卡片：允许 / 拒绝 / 本次会话不再询问（仅任务发起人可点）
- 流式进度卡片（打字机效果 + 工具调用 + 运行心跳，静默不等于卡死）
- 结果文本 + 产出文件回传（图片预览、>10 文件自动 zip）
- 多工作区切换（/ws）、会话管理（/new /resume）、/stop 打断
- **对话内容落盘**：用户消息与 Claude 回复全文存为 JSONL（`transcripts/`，为后续知识库挖掘打底；可选保留期）
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
4. 事件与回调 → 回调配置 → 订阅方式选「使用长连接接收回调」→「已订阅的回调」点「添加回调」，添加「卡片回传交互」（`card.action.trigger`）
5. 凭证与基础信息 → 复制 App ID / App Secret
6. 版本管理与发布 → 创建版本并发布，管理员审核通过
7. 运行 `lcb setup` 填入凭证 → `lcb start` → 私聊机器人发「/help」

## 首次配对

第一个发消息的用户会收到 6 位配对码（15 分钟内有效），在 `lcb start` 的终端里输入该码回车即批准（首个批准者自动成为 admin）。或另开终端 `lcb pair <code>`——批准写盘后，运行中的桥在下一条消息到达时自动重读白名单，无需重启。

## lcb 命令

| 命令 | 说明 |
|---|---|
| `lcb setup` | 引导式配置（写入 `~/.lark-claudecode-bridge/config.yaml`，支持一次配多个机器人） |
| `lcb start` | 启动桥接器（前台，为每个机器人各建一条长连接；终端可直接输入配对码批准） |
| `lcb pair <code>` | 另开终端批准 6 位配对码 |
| `lcb app list` | 列出机器人应用 |
| `lcb app add` | 添加机器人应用（交互式；旧单应用配置会自动升级为多应用格式，重启后生效） |
| `lcb app remove <名字\|app_id>` | 删除机器人应用（最后一个不可删；其会话分片与落盘目录保留待人工清理） |
| `lcb ws add <名字> <路径>` | 添加工作区（路径需已存在；增量写回，保留 config.yaml 注释） |
| `lcb ws remove <名字>` | 删除工作区（默认工作区被删时自动回退；apps 里的引用联动清理） |
| `lcb ws list` | 列出工作区（`*` 为默认） |
| `lcb version` | 查看版本 |

> **热生效**：桥接器运行中执行 `lcb ws add / remove`，下一条消息到达时自动重读配置，无需重启（apps 应用列表、凭证与 `concurrency` 改动除外，需重启）。

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

`lcb setup` 会引导生成，也可手动编辑（或用 `lcb app add / lcb ws add / remove` 增量维护，保留注释）。字段说明见仓库内 `config.example.yaml`：

```yaml
apps:                      # 多机器人：每个应用一条长连接
  - name: 主力助手          # 显示名，缺省取 app_id
    app_id: cli_xxxx        # 飞书开放平台 → 凭证与基础信息
    app_secret: xxxx
    # domain: lark          # 国际版 Lark 才需要
    # default_workspace: demo   # 该机器人的默认工作区
    # concurrency: 2        # 该机器人的并发上限
    # append_system_prompt: '你是我的素材收集助手'   # 人格补充
    # env:                  # per-app 环境变量（不同机器人用不同模型端点/密钥）
    #   ANTHROPIC_BASE_URL: https://your-endpoint/
workspaces:                # 工作区白名单（列表全局共享；「当前用哪个」per-app 隔离）
  - name: demo
    path: F:\workspace\demo
defaults:
  workspace: demo
concurrency: 3             # 通道间并发上限（未单独配置的 app 沿用）
# transcripts:             # 对话落盘清理策略；缺省 = 永久保留
#   retention_days: 90
```

### 多机器人隔离语义（重要）

- **会话池**：每个机器人一份 `sessions.<app_id>.json`，历史会话绝不共享，`/resume` 只见自己的
- **Claude Code 实例**：每个机器人一个独立的 `claude/<app_id>/` 数据目录（会话存储、用户设置、插件、登录态各自一套）；也可用 `claude_config_dir` 显式指定
- **模型凭证**：`env` 可按机器人覆盖 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` 等（如对话机器人用高端模型、素材收集用便宜端点）
- **并发**：按机器人独立限额（缺省沿用全局 `concurrency`）；同时与多个机器人对话互不排队
- **升级兼容**：旧版 `feishu:` 单应用配置无需改动即可启动（自动归一化，旧会话原样可 `/resume`）；首次 `lcb app add` 会把旧配置原地转为 `apps:` 格式，**转换后新增的机器人请追加在列表后面**（旧数据归属第一个应用）

### 对话落盘

每轮任务的完整对话（你的消息、Claude 回复、工具调用、最终结果）以 JSONL 追加到 `~/.lark-claudecode-bridge/transcripts/<app_id>/<chat_id>/<日期>.jsonl`，按天分文件，为后续知识库挖掘（如写入 Notion）打底。不想要可设 `transcripts.retention_days` 定期清理；写失败只打警告，不影响任务执行。

## ⚠️ 安全须知（必读）

本机 Claude Code 是共用资源：白名单用户可通过确认卡片让它在你电脑执行任意命令。
请只批准信任的人；工作区白名单、用户白名单、写操作确认三道闸不要关闭。

**隐私提醒**：对话全文（含代码、文件路径）明文落盘于 `~/.lark-claudecode-bridge/transcripts/`；`config.yaml` 中的 `app_secret` 与 `apps[].env` 值同样为明文。请自行控制该目录与文件的访问权限，并按需配置 `transcripts.retention_days` 保留期。

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
2. **access.json 多进程并发写为 last-writer-wins**：`lcb pair` 独立进程批准后，运行中的桥会在下一条消息到达时重读 `~/.lark-claudecode-bridge/access.json`（无需重启、不会重复索要配对码）。剩余风险仅在极短窗口：两个进程**恰好同时**写盘时后写者覆盖先写者（如一侧刚批准的用户在另一侧写回后丢失），正常使用几乎不会触发；如遇丢失，重新配对即可。
3. **多机器人总并发 = 各应用并发之和**：每个机器人独立限额（互不排队），N 个机器人同时满载时本机会同时跑 Σ(concurrency) 个 Claude Code 子进程，机器吃紧可按 app 调低。
4. **多机器人同群的 @ 识别**：依赖每个机器人各自的 open_id 精确匹配；若某机器人的 open_id 拉取失败，多应用部署下该机器人的**群聊消息会被丢弃**（宁丢不猜，防止同群消息触发两个机器人重复执行）——私聊不受影响。
5. **旧数据迁移归属**：升级多应用后，旧 `sessions.json` 归属 `apps` 列表的第一个应用；新增机器人请追加在列表末尾，否则历史会话会挂错机器人。
6. **飞书 SDK 对非法 app_id 静默失败**：`ws.start()` 对形状不合法的 app_id 只打日志不报错，启动后请确认每条「✅ <应用名> 长连接已启动」状态行都出现了。

## 开发

```bash
npm install
npm test          # vitest 全量单测
npm run build     # tsc → dist/
node dist/bin/lcb.js version
```

## License

MIT
