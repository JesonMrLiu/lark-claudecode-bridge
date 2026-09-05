# lark-claudecode-bridge

飞书 ↔ Claude Code 桥接器：在飞书里遥控本机 Claude Code。
写操作以卡片按钮确认（长连接回调），结果文本与产出文件回传飞书。
**无需公网 IP、无需内网穿透；无需预装 Claude Code CLI，一键安装 + 网页配置即可使用。**

## 特性

- **一键安装开箱即用**：`npm install -g` 后 `lcb start` 自动弹出网页配置页，飞书凭证 / Claude 认证（API Key / 中转站 Token）/ 模型 / 权限白名单全部在页面完成，不依赖本机 `claude login`（已登录的本机用户可继续共享 `~/.claude`，见「认证双模式」）
- **Web 配置页随桥接器常驻**（`http://127.0.0.1:17317`）：应用 / 工作区 / 权限 / 触发词 / 插件随时可改，密钥脱敏回显；改动自动区分「热生效」与「需重启」
- **飞书斜杠命令一键同步**：配置页把 `/new` `/status` 等命令注册为飞书输入框斜杠指令（输入 `/` 弹面板、选中后可继续输入描述），替代手工去开放平台逐条创建
- **飞书端直接装插件**：聊天里 `/plugin install xxx@marketplace`（仅管理员）即可安装 / 启停 Claude Code 插件，下一条消息自动加载；配置页同样可管
- 私聊 / 群聊 @机器人 触发；群聊多人可用（配对 + 白名单访问控制）
- **直接使用本机 Claude Code 全套配置**（inherit 模式）：模型设置（`~/.claude/settings.json`）、登录态、user 级 MCP、skills、marketplace 插件自动继承，无须二次配置；已启用插件自动加载
- **斜杠透传**：飞书里直接发 `/superpowers:brainstorming` 等斜杠命令，原文透传给 Claude Code 展开（user skills / 插件命令均可触发）
- **多机器人**：一个进程同时跑 N 个飞书机器人，各自独立会话池、独立并发、独立人格（`append_system_prompt`）；共享同一套 Claude 配置
- 写操作确认卡片：允许 / 拒绝 / 本次会话不再询问（仅任务发起人可点），Write/Edit 卡片直接展示红绿 diff
- **读操作免确认**：读工具（Read/Grep/Glob 等）与 Bash 读命令默认直通，危险命令黑名单兜底；白名单可通过 `permissions.allow_tools` 自定义（配置页可增删，新建配置默认预置完整默认值）
- **开发场景工作流（`type: code-dev`）**：统一 plan mode——先出计划 → 飞书卡片批准/按意见修改/放弃 → 批准后自动执行；任务收尾发汇总 diff 卡片（红绿着色），不再整文件刷屏
- 流式进度卡片（打字机效果 + 工具调用 + 运行心跳，静默不等于卡死）
- **接收图片与富文本**：直接给机器人发图片（下载到 `~/.lark-claudecode-bridge/inbox/`，Claude 用 Read 工具识图）；粘贴的多行/带格式内容（post 富文本）自动拍平为多行文本；不支持的类型（语音等）私聊会回复提示；入站消息按 message_id 去重（WS 重投不会导致任务跑两遍）
- 结果文本 + 产出文件回传（图片预览、>10 文件自动 zip；generic 工作区）
- 多工作区切换（/ws）、会话管理（/new /resume）、/stop 打断、模型切换（/model）、加载清单查看（/skills /plugins /mcp）、插件管理（/plugin）
- **对话内容落盘**：用户消息与 Claude 回复全文存为 JSONL（`transcripts/`，为后续知识库挖掘打底；可选保留期）
- 通道并发（默认 3），通道内串行

## 前置条件

1. Node.js ≥ 20
2. Claude 认证（二选一）：
   - **bridge 托管（推荐，免本机登录）**：准备 `ANTHROPIC_API_KEY`（官方）或 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`（第三方中转端点），在配置页填写即可
   - **继承本机**：本机已 `claude login`（任意鉴权方式），桥接器自动共享 `~/.claude` 全套配置

## 安装

```bash
npm install -g @jesonliu/lark-claudecode-bridge
lcb start
```

首次运行 `lcb start` 检测到没有配置时，会自动打开浏览器进入配置页（`http://127.0.0.1:17317`）：填飞书凭证 → 选认证方式 → 完成后重新 `lcb start` 即可使用。

偏好命令行问答的也可以用 `lcb setup`（两者产物等价，setup 额外预置 permissions / server 默认段）。配置页也可单独启动：`lcb ui`（不启动机器人，可与运行中的桥接器共存）。

## 飞书应用配置（图文）

1. https://open.feishu.cn → 创建企业自建应用 → 添加「机器人」能力
2. 权限管理开通：`im:message`、`im:message:send_as_bot`、`im:resource`（**接收用户图片时下载消息资源用，不开则图片任务会提示下载失败**）、`contact:user.base:readonly`、`application:app_slash_command:write` / `application:app_slash_command:read`（斜杠命令一键同步用，见下）
3. 事件与回调 → 事件配置 → 订阅方式选「使用长连接接收事件」→ 添加 `im.message.receive_v1`
4. 事件与回调 → 回调配置 → 订阅方式选「使用长连接接收回调」→「已订阅的回调」点「添加回调」，添加「卡片回传交互」（`card.action.trigger`）
5. 凭证与基础信息 → 复制 App ID / App Secret
6. 版本管理与发布 → 创建版本并发布，管理员审核通过
7. `lcb start`（首次自动进配置页）或 `lcb setup` 填入凭证 → 私聊机器人发「/help」

### 配置斜杠命令（配置页一键同步）

配置页 →「斜杠命令」tab：选择目标应用 → **一键同步**，把 bridge 全部内置命令（`/new` `/status` `/help` …）+ 自定义透传命令注册为飞书输入框斜杠指令。用户在聊天输入 `/` 弹出指令面板，**选中后命令留在输入框，可继续输入描述**再发送（区别于机器人菜单点击即发送）。

- 同步为**全量对齐**：远端多余的命令会被删除；生效约 5 分钟（客户端缓存），PC 端需 7.70+
- 自定义命令（如把 `/produce` 关联到 content-producer 插件）：表格添加「命令 / 描述 / 图标」→ 保存 → 同步（内部命令集恒参与同步）
- 前置：应用已开通 `application:app_slash_command:write` / `read` 权限并发布版本

## 首次配对

第一个发消息的用户会收到 6 位配对码（15 分钟内有效），在 `lcb start` 的终端里输入该码回车即批准（首个批准者自动成为 admin）。或另开终端 `lcb pair <code>`——批准写盘后，运行中的桥在下一条消息到达时自动重读白名单，无需重启。

## lcb 命令

| 命令 | 说明 |
|---|---|
| `lcb setup` | 引导式配置（命令行问答；与配置页产物等价，预置 permissions / server 默认段） |
| `lcb start` | 启动桥接器（前台，为每个机器人各建一条长连接 + 内嵌 Web 配置页；首次安装自动进引导；终端可直接输入配对码批准） |
| `lcb ui` | 仅启动 Web 配置页（不启动机器人；可与运行中的桥接器共存，写盘后桥接器自动拾取可热字段） |
| `lcb pair <code>` | 另开终端批准 6 位配对码 |
| `lcb app list` | 列出机器人应用 |
| `lcb app add` | 添加机器人应用（交互式；旧单应用配置会自动升级为多应用格式，重启后生效） |
| `lcb app remove <名字\|app_id>` | 删除机器人应用（最后一个不可删；其会话分片与落盘目录保留待人工清理） |
| `lcb ws add <名字> <路径>` | 添加工作区（路径需已存在；增量写回，保留 config.yaml 注释） |
| `lcb ws remove <名字>` | 删除工作区（默认工作区被删时自动回退；apps 里的引用联动清理） |
| `lcb ws list` | 列出工作区（`*` 为默认） |
| `lcb version` | 查看版本 |

> **热生效**：桥接器运行中执行 `lcb ws add / remove`，下一条消息到达时自动重读配置，无需重启（apps 应用列表、凭证与 `concurrency` 改动除外，需重启）。

## 配置页进程管理与自动更新

配置页「概览」支持托管桥接器进程与自更新（源码 tsx 运行模式下自动降级为手动指引）：

- **启停/重启**：概览「运行状态」卡显示桥接器进程状态（PID），可一键启动（后台守护进程）/ 停止 / 重启。`lcb start` 内嵌页面停止/重启时页面随进程短暂失联后自动恢复；`lcb ui` 独立页面则跨进程操作（Windows 下停止为硬终止，会话逐消息落盘不受影响）。
- **后台运行日志**：经页面启动/重启的桥接器，输出落 `~/.lark-claudecode-bridge/bridge.log`（超 5MB 自动截断）；进程 PID 记录于同目录 `bridge.pid`（进程消亡后自动清理）。
- **版本更新**：概览「版本与更新」卡自动对比 npm registry（跟随本机 `.npmrc` 镜像配置）与当前版本；有新版时一键更新（`npm install -g`）并自动重启生效。

## 命令速查（飞书里发给机器人）

| 命令 | 说明 |
|---|---|
| /new | 开新会话（历史保留，`/resume` 可随时切回） |
| /resume | 列出/恢复历史会话（`/resume <编号>` 恢复指定会话；列表标注当前续接的会话） |
| /stop | 停止当前任务 |
| /status | 当前状态 |
| /ws list / /ws use \<名字\> | 工作区（切换仅 admin 可用） |
| /model | 查看当前模型；`/model <名字>` 通道级切换；`/model reset` 恢复默认 |
| /skills / /plugins / /mcp | 查看本会话实际加载的技能 / 插件 / MCP 服务 |
| /plugin | 插件管理：`/plugin list`（全员，含本机 ~/.claude 与托管目录两处清单）；`install/uninstall/enable/disable/marketplace …`（仅 admin，默认装 ~/.claude，`--dir=managed` 装托管目录），装好下一条消息自动加载 |
| /reload-plugins | 重载插件：清插件发现缓存，下一条消息重新扫描加载（终端命令的 bridge 等价物） |
| /help | 帮助 |
| 其它 `/xxx` | **原文透传**给 Claude Code 派发斜杠命令（如 `/superpowers:brainstorming` 触发插件技能） |

> 清单类命令（/skills 等）的数据来自最近一次会话的加载清单；刚启动还没跑过任务时，先发一条普通消息（如「你好」）再查。

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
    # append_system_prompt: '你是我的素材收集助手'   # 人格补充（多机器人差异化定位的主要手段）
    # env:                  # per-app 环境变量（注意 ~/.claude/settings.json 的 env 优先级更高，
    #                         此处适合放 settings.json 里没有的键）
    #   SOME_PLUGIN_KEY: xxx
workspaces:                # 工作区白名单（列表全局共享；「当前用哪个」per-app 隔离）
  - name: demo
    path: F:\workspace\demo
    # type: code-dev       # 代码开发工作区：统一 plan mode + 收尾汇总 diff 卡片；缺省 generic
defaults:
  workspace: demo
concurrency: 3             # 通道间并发上限（未单独配置的 app 沿用）
# permissions:             # 工具白名单（整块可选；setup / 配置页新建时预置完整默认值，页面可增删）
#   allow_tools:           # 免确认直通工具；配置即整体替换内置默认
#                          # 内置默认：Read/Glob/Grep/LS/TodoRead/TodoWrite/WebFetch/WebSearch/Bash
#   dangerous_commands:    # Bash 危险命令正则（不区分大小写），命中弹确认卡
#   - 'rm\s+-rf'           # 内置默认覆盖 rm -rf/sudo/git push --force/git reset --hard/mkfs/dd if=/
#                          #   chmod 777/管道执行远程脚本/shutdown 等
# server:                  # Web 配置页（随 lcb start 常驻；也可 lcb ui 单独启动）
#   enabled: true          # 缺省 true；false 则不启动
#   host: 127.0.0.1        # 仅绑回环（改非回环 = 局域网可见，注意安全）
#   port: 17317
# claude:                  # 认证双模式；缺省 = inherit（共享本机 ~/.claude）
#   mode: managed          # managed = bridge 托管（无需本机 claude login）
#   auth_token: sk-xxx     # ANTHROPIC_AUTH_TOKEN（中转站常用；与 api_key 二选一）
#   # api_key: sk-ant-xxx  # ANTHROPIC_API_KEY（官方）
#   base_url: https://relay.example   # 中转站端点；官方留空
#   model: claude-sonnet-5 # 写入托管目录 settings.json
# slash_commands:          # 飞书斜杠命令同步；内置命令恒参与，此处为自定义透传命令
#   extra:
#     - command: produce
#       description: 内容生产流程
#       icon: skill_outlined
# transcripts:             # 对话落盘清理策略；缺省 = 永久保留
#   retention_days: 90
```

### 认证双模式（inherit / managed）

| | inherit（缺省） | managed |
|---|---|---|
| 认证来源 | 本机 `~/.claude`（`claude login` 或其 settings.json） | config.yaml `claude` 段 → 写入 `~/.lark-claudecode-bridge/claude/settings.json` |
| 适用 | 本机已在用 Claude Code 的用户 | 干净机器 / 不想动本机配置；配 API Key 或中转站 Token |
| 模型/MCP/skills | 继承 `~/.claude` 全套 | 全部落在托管目录，与本机 `~/.claude` 完全隔离 |
| 插件 | `~/.claude` 已启用插件自动加载 | **双目录合并加载**：托管目录 + 本机 `~/.claude` 已启用插件（同名托管目录优先），本机已装插件无须重装 |
| 切换 | 改 `claude.mode` 后**重启**生效 | 同 |

配置页「Claude 认证」tab 可视化切换；managed 模式下认证/模型改动保存后即对后续任务生效（无需重启）。

**managed 模式的 MCP 与环境继承**（0.14.0 起，`lcb start` 时自动完成）：本机 `~/.claude.json` 的全局 `mcpServers` 单向同步到托管目录（CLI 读 `$CLAUDE_CONFIG_DIR/.claude.json`，不同步则托管会话丢掉全部 user 级 MCP）；本机 `~/.claude/settings.json` env 块中的**非认证键**（MCP 工具依赖的 `IMAGE_GEN_*`、`API_HOST` 等自定义变量）并入托管 settings.json。需要覆盖继承值或本机没有这些配置时，用**显式配置**：配置页「Claude 认证」→「环境变量」行编辑器（或 config.yaml 的 `claude.env` 键值对），优先级 `claude.env` > 本机继承 > 托管目录既有值；认证与模型 4 键（`ANTHROPIC_AUTH_TOKEN/API_KEY/BASE_URL/MODEL`）不在此生效——永远以认证表单为准。

**插件双目录（managed 模式）**：新装插件默认装到本机 `~/.claude`（与本机 claude CLI 共用一份），`/plugin install xxx --dir=managed` 或配置页安装框选「bridge 托管目录」可装到托管目录；启停/卸载自动按插件所在目录执行，两处清单在配置页「插件」tab 与 `/plugin list` 中均带来源标记。

### 开发场景工作流（`type: code-dev`）

给代码开发类工作区设置 `type: code-dev` 后，每个任务自动走「先计划、后执行」：

1. **计划审批**：任务以 plan mode 启动（期间只允许读操作），Claude 查阅代码后提交计划 → 飞书收到计划卡片：
   - **✅ 批准执行**：批准即授权——Claude 自动切入 acceptEdits 模式按计划开工，**后续写文件不再逐次弹确认卡**（对齐本机 CLI「批准计划 → accept edits on」语义；Bash 危险命令黑名单仍生效，命中照弹确认）
   - **📝 按意见修改**：在卡片输入框填修改意见后点击，Claude 修订计划重新提交（同一会话内循环，直到批准或放弃）
   - **❌ 放弃计划**：任务终止；10 分钟无操作自动放弃
2. **收尾汇总 diff**：任务完成后不再把改动文件逐个上传，而是发**汇总 diff 卡片**（标题含文件数与 +X/-Y 行统计，正文红绿着色，超长自动拆多张）。改动以 `git diff HEAD` + untracked 新文件为准，因此 **code-dev 工作区需要是 git 仓库**（非 git 仓库自动回退为旧的文件上传行为，并提示 `git init`）

**执行器为 Streaming Input 模式**（0.14.0 起）：prompt 经持久输入流送入 CLI，stdin 全程保持打开——这是计划审批与提问卡片能稳定工作的前提（旧版单轮模式在轮次边界会触发 CLI 的 "Stream closed" 中断，属 Agent SDK 已知问题）。**提问卡片**：Claude 调用 AskUserQuestion 时飞书收到问题选项卡，点选项作答（多选题可多选）、全部作答后「提交答案」——答案直接回传模型继续任务。

**读操作免确认**：读工具与 Bash 默认直通（`ls`/`cat`/`grep` 不再弹卡），命中 `dangerous_commands` 黑名单（`rm -rf`、`sudo`、`git push --force` 等）仍弹确认卡；「本次会话不再询问」的记忆同样绕不过黑名单。想放行其它工具（如 `Edit`）往 `permissions.allow_tools` 追加即可——注意配置即**整体替换**内置默认，需把内置读工具一并写上。

> plan 卡片与 permissions 配置的改动需重启 bridge 进程生效（`workspaces[].type` 改动亦然）。

### 配置继承（inherit 模式：本机 ~/.claude 一处配置，全机器人共享）

inherit 模式（缺省）下所有机器人共享本机 `~/.claude`，以下内容自动继承、无须在 config.yaml 重复配置（managed 模式则全部落在托管目录）：

| 继承项 | 来源 | 说明 |
|---|---|---|
| 模型设置 | `~/.claude/settings.json` 的 `model` 与 `env` | 含 `ANTHROPIC_*`、第三方端点等全部环境变量 |
| 登录态 | `~/.claude/.credentials.json` / settings.json 认证声明 | 本机 `claude login` 一次即可 |
| user 级 MCP | `~/.claude.json` 的 `mcpServers` | 与本机 CLI 用同一批 MCP 服务 |
| skills | `~/.claude/skills/` | 可直接在飞书发 `/技能名` 触发（透传） |
| 插件 | `~/.claude/plugins/` 中已启用的 marketplace 插件 | 按 `installed_plugins.json` + `enabledPlugins` 自动加载 |
| 会话记录 | `~/.claude/projects/` | 飞书跑过的会话，本机 `claude --resume` 也能接着看 |

**插件自动发现**：安装 / 卸载 / 启停自动跟随（按文件 mtime 失效缓存 + 操作后主动失效）。三种管理入口等价：飞书端 `/plugin install xxx@marketplace`（admin）、配置页「插件」tab、本机 CLI。`apps[].plugins` 显式配置用于开发期直指源码目录，与自动发现同名时显式优先。

**多机器人隔离语义**：

- **会话池**：每个机器人一份 `sessions.<app_id>.json`，历史会话绝不共享，`/resume` 只见自己的
- **人格**：`append_system_prompt` 按机器人定制（如对话助手 / 素材收集各一套）
- **并发**：按机器人独立限额（缺省沿用全局 `concurrency`）；同时与多个机器人对话互不排队
- **升级兼容**：旧版 `feishu:` 单应用配置无需改动即可启动（自动归一化）；首次 `lcb app add` 会把旧配置原地转为 `apps:` 格式，**转换后新增的机器人请追加在列表后面**（旧数据归属第一个应用）
- ⚠️ **0.4 起废弃 `claude_config_dir`**：所有机器人统一用 `~/.claude（共享配置）`，机器人间仅会话池隔离。旧版独立目录 `~/.lark-claudecode-bridge/claude/<app_id>/` 中的历史会话不再可 `/resume`（启动时会提示目录位置，确认无用后可手动删除）

### 快捷操作：飞书斜杠命令 / 机器人菜单

**推荐：斜杠命令**（配置页「斜杠命令」tab 一键同步）——聊天输入框输入 `/` 弹出指令面板，选中后命令留在输入框、**可继续输入描述**（如 `/produce 写一篇公众号文章`），发送后经命令 / 透传链路执行。自定义命令在表格维护，保存后点「一键同步」。

备选：机器人菜单（点击即发送，无法附加描述）——开放平台 → 应用功能 → 机器人 → 机器人菜单，添加「发送消息」类菜单项填 `/content-producer:content-producer` 即可。菜单命令格式：`/<插件名>:<技能名>`（插件技能）或 `/<技能名>`（user skill），可用命令清单发 `/skills` 查看。

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
7. **共享 ~/.claude 的副作用**：本机 user 级 hooks 也会在机器人任务里执行（含阻断型 PostToolUse hook）；`apps[].env` 的同名键会被 `~/.claude/settings.json` 的 `env` 覆盖（优先级：CLI flags（/model）> settings.json env > apps[].env > 进程环境）。插件加载失败 SDK 会静默跳过，实际加载情况以 `/plugins` 清单为准。
8. **plan 卡片的「按意见修改」依赖飞书卡片输入框回传**：修改意见经卡片 input 组件随按钮回调传回；若个别客户端版本不回传输入值，点「按意见修改」会提示先填写意见——此时可改用「放弃计划」后在会话里直接发修改要求重新起任务。
9. **code-dev 工作区的收尾 diff 基于 git**：`type: code-dev` 的工作区需要是 git 仓库（含未提交改动即可，无需 commit）；非 git 仓库自动回退为旧的整文件上传行为。untracked 新文件按全新增 diff 展示（目录级 untracked 与超过 20 个的 untracked 文件不展开）。
10. **入站图片不清理**：用户发送的图片落盘 `~/.lark-claudecode-bridge/inbox/` 后不会自动删除（供会话内多次查看），长期使用可手动清理；Claude 是否能「看懂」图片取决于当前模型是否多模态（非多模态模型可配置识图 MCP 兜底）。富文本（post）中的超链接以 `[文字](链接)` 形式拍平进文本，@用户 被移除。
11. **短回复不再单独发结果消息**：回复不超过进度卡正文上限（1200 字）时，结果就展示在进度卡终态里（避免同内容两条消息）；更长回复仍会单独发一条结果消息（进度卡只保留尾部）。
12. **Web 配置页改 apps/workspaces 段会丢段内手写注释**：页面按整段替换写回（值未变的段落跳过重写、注释保留；`lcb ws add` 等增量命令不受影响）。手工注释建议写在段外或段头。
13. **config.yaml 并发写**：配置页写盘为原子替换，但与 `lcb ws add` / `lcb app add` 等独立进程命令同时操作存在读-改-写窗口，请避免同时修改。
14. **配置页默认仅本机可访问**（127.0.0.1）；改 `server.host` 放开到局域网意味着页面可读写全部凭证，请仅在可信网络使用。

## 开发

```bash
npm install
npm test          # vitest 全量单测
npm run build     # tsc → dist/
node dist/bin/lcb.js version
```

## License

MIT
