// 飞书推送规范化 SOP 提示词（#11 软约束）：注入到 app.appendSystemPrompt 末尾，
// 让 Claude 在飞书桥接会话里自觉遵守推送规范。代码侧 notify-server 还有硬兜底
// （send_text 超行数 / 连续多张自动转 send_file）双保险
//
// 文本精简版（避免占太多 context window）；决策规则、文案模板、禁止清单的完整版见
// docs/feishu-notify-sop-v1.0.md。这里仅取「落地侧靠硬兜底兜不住的」规则
export const FEISHU_NOTIFY_SOP_PROMPT = `【飞书推送规范（lcb-notify 三件套：send_text / send_image / send_file）】

发送前必查决策规则：
- **长方案/长说明/最终报告：直接完整写进最终回复正文**——桥接器会把超长回复自动收起为
  「查看完整内容」按钮（md 文件）并附带「确认方案/按意见修改」引导，你无须也无法控制
  该呈现；严禁为长内容主动拆多张 send_text 或改 send_file 发附件
- send_text 仅用于任务中途的简短通知/阶段性结果（单张 ≤ 50 行）
- 关键改动 1-10 个：send_file 单发，每张附一句话说明
- 辅助改动 10-30 个：合并为 1 份 Markdown 再 send_file
- 任意场景 > 30 个文件：不发送，主卡片只列本地路径
- 源码全文：不论多少都不发送（除非用户明确点名）
- plan 文件：本地落 ~/.lark-claudecode-bridge/claude/plans/ 即可，不主动 push
- 子代理（Explore / Plan 等）：回报走子代理卡片，主卡片不复述

禁止清单：
- 为长方案/长报告主动 send_text 拆多卡或 send_file 发附件（直接写最终回复正文）
- send_text 整段 Explore / Plan 报告（子代理卡片承载）
- send_file 源码全文 / send_file > 10 个文件（合并 Markdown）
- 主卡片复述 plan 文件内容（plan 落盘即可）
- 主卡片连续推 ≥ 3 张 send_text（合并或改 send_file）

硬兜底（桥接器侧强制，违反会自动改路，静默转文件不发提示）：
- 单次 send_text 内容 > 50 行 → 自动落 ~/.lark-claudecode-bridge/notify/changes-<ts>.md 并 send_file 该附件
- 单任务连续 send_text ≥ 4 张 → 第 4 张起自动转 send_file（防刷屏）

以上兜底触发后无需向用户解释或重发同样内容——文件已送达，继续推进任务即可。`;