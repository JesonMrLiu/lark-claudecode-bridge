# lark-claudecode-bridge 设计文档

> 状态：待用户审阅
> 日期：2026-08-27
> 项目路径：`F:\workspace\plugins\lark-claudecode-bridge`
> npm 包名：`@jesonliu/lark-claudecode-bridge`（bin 命令：`lcb`）

## 1. 背景与目标

把「飞书」变成 Claude Code 的遥控终端：在飞书里给机器人发消息（私聊直接发 / 群里 @），本机 Windows 电脑上的 Claude Code 执行任务；执行过程中需要用户确认的写操作，以**带按钮的飞书卡片**发给用户，点按钮后继续；完成后把**结果文本 + 生成的文件**回传飞书。

整个处理终端是飞书，Claude Code 跑在个人电脑上，两者**不需要在同一局域网**（WebSocket 长连接，电脑只需能上网）。

项目将开源发布，需支持多人使用场景（群聊里任何人 @ 机器人均可用，配合访问控制）。

## 2. 需求清单（含历次澄清结论）

| # | 需求 | 结论 |
|---|---|---|
| 1 | 触发方式 | 私聊机器人 + 群聊 @机器人，两者都支持 |
| 2 | 群聊可用范围 | **群里任何人 @ 都能用**（为开源多人场景设计），配访问控制 |
| 3 | 确认粒度 | **写操作**（Bash/Edit/Write 等）发卡片确认；只读（Read/Glob/Grep 等）自动放行 |
| 4 | 卡片交互 | 按钮选项：允许 / 拒绝 / 本次会话不再询问 |
| 5 | 结果回传 | 文本结果卡片 + 生成的文件上传飞书 + 过程进度推送 |
| 6 | 执行目录 | 多工作区可切换，**配置文件白名单制**（不允许消息里写任意路径） |
| 7 | 并发模型 | 每个聊天×用户一个任务通道，通道内串行、通道间并发（默认上限 3，可配） |
| 8 | 会话管理 | `/new` 开新会话、`/resume` 恢复历史、自动 compact、超长提醒（防上下文爆炸） |
| 9 | 模型鉴权 | **与鉴权无关**：继承本机 Claude Code 现有配置（订阅 / API Key / GLM 等第三方端点均可） |
| 10 | 安装分发 | npm 全局安装（`@jesonliu/lark-claudecode-bridge`），支持 Windows / macOS / Linux |
| 11 | 配置体验 | `lcb setup` 引导式配置，配置文件极简 |
| 12 | 网络约束 | 无需公网 IP、无需内网穿透、无需 ngrok |

## 3. 现有方案调研结论

调研了两个代表项目，均不能完整满足需求：

| 维度 | [joewongjc/feishu-claude-code](https://github.com/joewongjc/feishu-claude-code)（Python） | [AnInteger/claude-channel-feishu](https://github.com/AnInteger/claude-channel-feishu)（TS 插件） |
|---|---|---|
| 长连接收消息（免公网） | ✅ | ✅ |
| 卡片按钮确认 | ⚠️ 按钮回调**必须 ngrok 暴露公网端口**，不配则按钮全失效 | ❌ 权限转发是纯文本 `yes <id>` / `no <id>` |
| 文件回传飞书 | ❌ | ❌ |
| 多工作区 | ✅ `/ws save` `/ws use`（设计成熟，本设计借鉴） | ❌ |
| 群聊多人 | ✅ 但无访问控制（谁都能用，危险） | ✅ 配对码/白名单/策略（本设计借鉴） |
| Windows | ❌ 仅 macOS/Linux 部署脚本 | ⚠️ 依赖实验性 `--channels` 特性 |
| 流式进度 | ✅ 流式卡片实时刷新（本设计借鉴） | ❌ |

**关键技术验证**：飞书新版消息卡片回调事件 `card.action.trigger` 支持 WebSocket 长连接接收（[官方文档](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks)），与收消息同通道——**免公网 IP 实现按钮交互的基石**。注意：仅企业自建应用支持；旧版卡片回传交互不支持长连接（须用新版卡片）；Python SDK 曾有长连接下卡片事件被丢弃的 bug（larksuite/oapi-sdk-python#126），Node SDK 无此问题 → **技术栈定 Node/TypeScript**。

## 4. 总体架构

一个常驻 Node 进程，四个模块：

```
┌────────────────────────────────────────────────────┐
│                lark-claudecode-bridge              │
│  ① feishu-gateway   飞书网关                        │
│     长连接收发：消息/卡片按钮回调；发文本卡片/          │
│     进度卡片/确认卡片；上传文件                        │
│  ② session-manager  会话管理                        │
│     每个聊天(私聊/群)×用户 → 独立 Claude 会话；        │
│     工作区绑定；任务队列；/命令解析                    │
│  ③ claude-executor  Claude 执行器                    │
│     Agent SDK 驱动；canUseTool 权限拦截；             │
│     流式进度；会话恢复(resume)；文件产出收集            │
│  ④ access-control   访问控制                        │
│     配对码/白名单/权限分级                             │
└────────────────────────────────────────────────────┘
```

**技术栈**：TypeScript、Node ≥20、`@larksuiteoapi/node-sdk`（长连接+卡片+文件上传）、`@anthropic-ai/claude-agent-sdk`（执行器）。

**一条消息的完整生命周期**：

```
用户在飞书发消息/@机器人
  → ①gateway 收到，交给 ②session-manager
  → ②解析 /命令（本地处理）或普通消息（入队）
  → ③executor 从队列取任务：启动/恢复 Claude 会话执行
  → ③期间：只读工具直接放行；写操作 → ①发确认卡片（带按钮）
  → 用户点按钮 → ①gateway 收到卡片回调 → resolve 挂起的等待 → Claude 继续
  → ③完成：收集最终文本 + 产出文件清单
  → ①发结果卡片（markdown 渲染）+ 文件逐个上传发送
```

## 5. 会话模型与并发

**通道** = 聊天（私聊/群）× 用户。每个通道一个任务队列与一个连续 Claude 会话。

| 场景 | 通道划分 | 效果 |
|---|---|---|
| 用户私聊机器人 | 用户×机器人 = 1 通道 | 消息排队执行 |
| 群里 A、B 先后 @机器人 | A×群、B×群 = 2 通道 | 互不阻塞，各自排队 |
| 同一人连发多条 | 同一通道 | 排队；运行中提示「/stop 可打断」 |

- 通道内严格串行；通道间并发，全局并发上限默认 3（可配）
- **会话生命周期**（防上下文爆炸的三重防线）：
  - `/new` 立即开新会话（旧会话自动存档）
  - `/resume` 列出历史会话（带自动摘要），回数字恢复
  - Claude Code 内建 compact 自动压缩；轮次/上下文超阈值时机器人主动提醒 `/new`
- 会话映射持久化本地 json，桥接器重启不断
- 工作区：通道绑定（`/ws use <名字>`），白名单来自配置文件；文件产出按通道分开记录

## 6. 飞书侧设计

**应用配置**（README 图文引导）：
1. 飞书开放平台创建企业自建应用，添加「机器人」能力
2. 权限：`im:message`、`im:message:send_as_bot`、`im:resource`、`contact:user.base:readonly`
3. 事件订阅选**长连接模式**，订阅 `im.message.receive_v1`（收消息）
4. 卡片交互配置同样选**长连接模式**，接收 `card.action.trigger`（按钮回调）
5. 获取 App ID / App Secret 填入配置

**确认卡片**：

```
┌─────────────────────────────────────┐
│ 🔐 Claude 请求执行操作                │
│ 工具: Bash          工作区: xxx      │
│ ┌─────────────────────────────┐    │
│ │ git push origin main        │    │ ← 命令/改动以代码块展示
│ └─────────────────────────────┘    │
│ （文件修改类显示 diff 摘要）           │
│ [✅ 允许] [❌ 拒绝] [⏭ 本次会话不再询问] │
└─────────────────────────────────────┘
```

- 允许 = 放行本次；拒绝 = 终止该工具调用（Claude 收到拒绝原因继续）；本次会话不再询问 = 同类操作自动放行直至 `/new`
- 点击后卡片变为结果态（"✅ 已由 张三 允许"），防重复点击
- **仅发起任务的用户的按钮生效**（群里他人点击提示无权限）
- 超时 10 分钟自动按拒绝处理，任务继续
- 只读工具（Read/Glob/Grep 等）不卡片、自动放行

**进度**：一个任务一张流式卡片，实时 PATCH 刷新（文本增量 + 当前工具调用），不逐条刷屏。

**结果**：
1. 最终回复渲染 markdown 卡片，长文自动分段
2. 任务中 Write/Edit 产出（新增+修改）去重后经飞书文件消息逐个上传（≤30MB/个；图片走图片消息带预览）
3. 文件 >10 个时改发清单 + 打包 zip 上传

## 7. Claude 执行器

- **Agent SDK `query()` 驱动**，`canUseTool` 回调拦截工具调用——异步 `await` 一个 Promise，由飞书卡片按钮点击 resolve（暂停等确认 → 继续是语言层原生能力）
- **鉴权透传**：spawn 时继承当前环境变量与 `~/.claude` 用户配置，不覆盖 `ANTHROPIC_*` 等变量——订阅 / API Key / GLM 等第三方端点均可用，桥接器零介入
- **插件兼容**：`settingSources: ['user', 'project']` 加载用户/项目配置，本机已装的 Claude Code 插件（如 content-producer）照常生效
- 会话恢复：`resume` session id 实现连续对话
- 文件产出收集：跟踪 Write/Edit 工具调用目标路径（不依赖 git，非 git 目录也可用）

## 8. 访问控制与安全

- **配对**：白名单外用户首次私聊/@，机器人发 6 位配对码，管理员在终端（`lcb pair`）确认后入白名单
- 白名单外用户：礼貌拒绝
- **权限分级**：`admin`（全部命令 + 所有工作区 + 批准配对）/ `member`（普通任务 + 已绑定工作区）
- **admin 来源**：`lcb setup` 引导时，机器人发出的第一个配对码确认者自动成为 admin（即部署者本人）；后续 admin 可在配置文件 `users` 段增删
- 三道闸缺一不可（写进开源文档的风险边界）：用户白名单 × 工作区白名单 × 写操作卡片确认
- 明示：本机 Claude Code 是共用资源，白名单用户可让其执行命令，请谨慎授权

## 9. 错误处理与可靠性

| 场景 | 行为 |
|---|---|
| 长连接断开 | SDK 自动重连；本地任务不受影响 |
| 桥接器崩溃/重启 | 会话映射持久化，重启后 /resume 照常 |
| 任务卡死 | 智能空闲超时（检测子进程活跃度，编译/下载不误杀）+ `/stop` 强制停止 |
| Claude 执行报错 | 错误信息原样回传卡片 |
| 等确认超时 | 10 分钟自动拒绝 |
| 飞书 API 限流 | 指数退避重试 |

## 10. 配置与安装分发

**前置依赖**：Node ≥20；Claude Code CLI 本机可用（终端 `claude "hi"` 能正常回复即可，任意鉴权方式）。

**安装**（三平台一致）：

```bash
npm install -g @jesonliu/lark-claudecode-bridge
lcb setup    # 引导式配置
lcb start    # 前台运行
```

**配置文件** `~/.lark-claudecode-bridge/config.yaml`（setup 自动生成）：

```yaml
feishu:
  app_id: cli_xxxx
  app_secret: xxxx
workspaces:                    # 工作区白名单：名字 + 路径
  - name: auto-produce
    path: F:\publish\auto-produce
defaults:
  workspace: auto-produce
concurrency: 3                 # 通道间并发上限
```

**备选**：git clone 源码 `npm install && npm run setup && npm start`。

**常驻自启**（一期文档+模板，二期 `lcb service install` 封装）：Windows 任务计划程序 / macOS launchd / Linux systemd --user。

**跨平台规范**：`path` 模块处理路径；yaml 中 Windows 路径正反斜杠均可；chalk 终端颜色；LF 归一。

**暂不做**（stretch goals）：单文件 exe 打包（Claude CLI 依赖仍在，收益小）。

## 11. 项目结构（实现计划时细化）

```
lark-claudecode-bridge/
├── src/
│   ├── gateway/        # 飞书网关：长连接、卡片、上传
│   ├── session/        # 会话管理：通道、队列、/命令
│   ├── executor/       # Claude 执行器：canUseTool、进度、产出
│   ├── access/         # 访问控制：配对、白名单
│   └── index.ts        # 装配入口
├── bin/lcb.ts          # CLI（setup/start/pair/service）
├── docs/
└── package.json        # name: @jesonliu/lark-claudecode-bridge, bin: lcb
```

## 12. 测试策略

- gateway：注入伪造飞书事件（消息/卡片回调）单测卡片构造与状态机
- executor：canUseTool 分流逻辑单测（只读放行/写操作挂起/超时拒绝）；真实 `claude` CLI 冒烟
- 端到端：手动清单（私聊全流程 / 群聊多人 / 按钮点击 / 断网重连 / 重启恢复）
- 开源前：三平台（Win/mac/Linux）至少各一轮手动验证（Windows 必测，其余找机会）

## 13. 一期范围与非目标

**一期做**：私聊+群聊触发、写操作卡片确认（长连接回调）、流式进度卡片、结果文本+文件回传、多工作区、/new /resume /stop /ws 命令、配对+白名单、并发上限、三平台安装运行。

**一期不做（非目标）**：消息历史搜索、CLI handover（终端会话移交）、单文件 exe、Web 管理界面、多实例集群。
