---
name: feishu-session-bind
description: Create or reuse a dedicated Feishu group binding for the current Codex task. Use when the user asks to bind this task, session, chat, or conversation to Feishu.
---

# 为当前 Codex 任务绑定飞书群

使用随 Skill 安装的确定性脚本。脚本只把当前 `CODEX_THREAD_ID` 交给本机 Bridge；Bridge 负责验证任务、创建仅含当前用户与 Bot 的群、按 `{Project名}/{任务名}` 或 `独立/{任务名}` 命名、应用本机 Agent 标签并持久化绑定。

1. 告诉用户：本 Skill 正在请求本机 Bridge 创建或复用当前任务的飞书绑定。
2. 运行：

   ```powershell
   & "$HOME\.agents\skills\feishu-session-bind\scripts\request-binding.ps1"
   ```

3. 解析单行 JSON：
   - `ok=true`：只报告 `result.groupName`、`result.feedGroupName`，以及是否因 `result.alreadyBound=true` 而复用了已有群。
   - `ok=false`：只报告安全的 `error.code`、`error.message` 和 `error.missingScopes`；不得声称绑定成功。
4. 不显示 Codex task ID、飞书 chat ID、App ID、App Secret、访问令牌、本机绝对工作目录或配置文件内容。
5. 不直接编辑 Codex 全局 Project 状态。Project 归属以 Codex Desktop 原生状态为准；没有 Project 的任务按“独立”处理。

成功后 Bridge 可能自动重载，这是正常行为。当前最终回复会由恢复机制发送到刚绑定的群。
