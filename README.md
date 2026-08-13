# Feishu ↔ Codex 本地桥接

通过飞书私聊安全地继续本机 Codex 任务：桥接复用电脑上已有的 ChatGPT 登录态，不需要 OpenAI API Key，并使用官方飞书 Channel SDK 接收消息、展示实时进度和返回最终结果。

> 当前版本面向 Windows 单用户本地部署，仅处理配置中指定用户发给机器人的私聊文本。

## 主要能力

- 从飞书继续、创建和切换本机 Codex 任务，完整保留原任务上下文。
- 用同一张动态卡片展示耗时、公开过程说明、脱敏活动和最终结果。
- 支持临时异步 Chat；原任务运行时也能在独立队列中处理临时问题。
- `/status`、`/model`、`/capacity` 等本地查询不调用模型，也不消耗新的 token。
- 最终答案先持久化再投递；遇到网络超时会按指数退避自动补发，不会重复运行 Codex。
- App Secret 使用 Windows DPAPI 加密，明文不会写入配置、日志或仓库。

## 一句话安装 Prompt

把下面这一句话直接发给具有本机终端权限的 Codex：

> 请在 Windows 上安装并配置 [feishu-codex-bridge](https://github.com/Jiakai-Zhang/feishu-codex-bridge)：先检查 Node.js、PowerShell、已登录的 Codex CLI，以及用于读写飞书文档等资源的 `lark-cli` 登录状态，克隆仓库并安装依赖，复制配置模板后逐项引导我填写飞书 App ID、允许用户的 open_id、Codex 任务 ID、工作目录以及 Node/Codex 可执行文件路径，再让我亲自在 `setup-channel-secret.ps1` 中输入 App Secret，最后运行测试、启动桥接并验证连接状态；不要读取或回显任何密钥，覆盖现有配置或执行其他难以恢复的操作前必须先征得我的明确确认。

## 已验证的系统测试环境

以下结果来自 2026-08-12 的本机测试：

| 组件 | 已验证版本或状态 |
| --- | --- |
| 操作系统 | Windows 10 专业版 22H2，10.0.19045，x64 |
| PowerShell | Windows PowerShell 5.1.19041.6456 |
| Node.js | 24.19.0 |
| npm | 11.17.0 |
| Codex CLI | 0.146.1，已登录 ChatGPT |
| 飞书 CLI | `lark-cli` 1.0.84；供 Codex 读写飞书文档等资源 |
| 飞书 Channel SDK | `@larksuite/channel` 0.4.1 |
| 自动化测试 | `npm test`：20 项通过，0 项失败 |
| 本机联调 | Channel SDK 已连接，桥接运行正常 |

其他 Windows、Node.js 或 Codex CLI 版本尚未在本项目中系统验证；部署时建议优先使用上表版本或更新的兼容版本。

## 安装前准备

- Windows 与 PowerShell 5.1 或更高版本。
- Node.js 和 npm。
- 已安装并登录的 [Codex CLI](https://developers.openai.com/codex/cli/)。
- 如果需要让 Codex 读写飞书文档、表格、多维表格等资源，还需安装 `lark-cli`、执行 `lark-cli auth login`，并为登录身份授予相应权限。
- 已启用机器人和 Channel SDK 的飞书自建应用，以及该应用的 App ID、App Secret。
- 获准使用机器人的飞书用户 `open_id`，以及一个已有的本机 Codex 任务 ID。

`@larksuite/channel` 与 `lark-cli` 用途不同：前者是本项目收发飞书消息所必需的运行时依赖；后者不是启动桥接的硬依赖，但它是 Codex 执行飞书文档、云空间、表格、多维表格等操作时所需的工具。若希望通过本桥接让 Codex 完成这些飞书操作，应安装并登录 `lark-cli`。

## 手动安装

### 1. 获取代码和依赖

```powershell
git clone https://github.com/Jiakai-Zhang/feishu-codex-bridge.git
Set-Location .\feishu-codex-bridge
npm install
Copy-Item .\bridge.config.example.json .\bridge.config.json
```

如果目录中已经有自己的 `bridge.config.json`，不要覆盖它。

### 2. 填写本地配置

编辑 `bridge.config.json`。Windows JSON 路径中的反斜杠需要写成 `\\`。

| 字段 | 说明 |
| --- | --- |
| `appId` | 飞书自建应用的 App ID |
| `threadId` | 首次连接的本机 Codex 任务 ID；之后可在飞书中切换 |
| `allowedSenderOpenId` | 唯一允许向机器人发指令的飞书用户 `open_id` |
| `workspace` | Codex 工作目录，同时用于保存桥接运行状态 |
| `nodeExecutable` | `node.exe` 的绝对路径，可用 `Get-Command node` 查询 |
| `codexExecutable` | Codex 可执行文件的绝对路径，可用 `Get-Command codex` 查询 |
| `sandboxMode` | 飞书触发 Codex 时使用的沙箱模式，示例为 `danger-full-access` |

模板里的超时、轮询周期和输入输出长度字段均可保持默认值。`larkCliEntry` 是旧配置兼容字段，当前桥接不会读取它。

真实配置已被 `.gitignore` 排除，不应提交到 Git。

### 3. 安全保存 App Secret

```powershell
& .\setup-channel-secret.ps1
```

请在脚本打开的安全输入框中亲自粘贴 App Secret。脚本使用当前 Windows 用户的 DPAPI 加密保存密钥；启动器只在内存中解密并传给 Channel SDK 子进程。

### 4. 测试并启动

```powershell
npm test
& .\start-bridge.ps1
& .\status-bridge.ps1
```

状态显示 `running` 且 `connected=True` 后，即可在飞书中私聊应用机器人。停止桥接时运行：

```powershell
& .\stop-bridge.ps1
```

运行日志、任务选择、消息去重和待补发结果保存在 `<workspace>\work\feishu-codex-bridge`。

## 飞书命令

| 命令 | 作用 | 是否调用模型 |
| --- | --- | --- |
| `/new`、`/new 主题` | 创建并切换到新的 Codex 任务 | 否，仅初始化 |
| `/threads` | 列出最近 10 个本机 Codex 任务 | 否 |
| `/use 2` | 切换到任务列表中的第 2 个任务 | 否 |
| `/current` | 查看当前任务、模型和容量摘要 | 否 |
| `/status` | 查看连接、运行时间、当前进度、队列和待补发结果 | 否 |
| `/model` | 查看模型、推理强度、提供方和 CLI 版本 | 否 |
| `/capacity`、`/quota` | 查看上下文与账户用量的最近本地快照 | 否 |
| `/chat` | 创建临时 Codex Chat，并记住当前原任务 | 否，仅初始化 |
| `/chat 正文` | 创建或使用临时 Chat，并立即处理正文 | 是 |
| `/endchat`、`/end` | 将后续消息路由回原任务 | 否 |
| `/help` | 显示命令帮助 | 否 |

普通文本会发送给当前选中的 Codex 任务。`/use` 只能选择本机 Codex 任务，不能切换到普通 ChatGPT 对话。

### 临时异步 Chat

- 临时 Chat 与原任务使用不同的执行队列，因此原任务正在运行时仍可创建 Chat 和继续提问。
- `/chat 正文` 中的正文是第一条用户消息，不会被当作标题；已经处于临时 Chat 时也会直接处理正文。
- `/endchat` 会立即把后续消息路由回原任务，但不会取消已经提交给临时 Chat 的回合。
- 返回位置会持久化，桥接重启后仍可用 `/endchat` 回到原任务。
- 临时 Chat 仍保留在 Codex 任务列表中；临时模式下执行 `/new` 或 `/use` 前，需先执行 `/endchat`。

## 可靠性设计

- 同一 Codex 任务内的消息按顺序执行，不同任务可以并行处理。
- 前 8 分钟使用飞书原生流式卡片；之后继续更新同一张卡片，不会不断创建续接卡片。
- 活跃任务每 30 秒刷新耗时心跳，并增量检查本地 rollout；这些检查不调用模型。
- 检测到稳定的 `task_complete` 后，即使 Windows 上的 `codex exec resume` 没有退出，也会采用已有最终答案并清理本次残留辅助进程。
- 最终答案会先写入 `pending-deliveries.json`；网络超时或连接重置时每分钟检查并按指数退避补发。
- 补发使用稳定的幂等键，不会重新运行 Codex，也不会产生新的模型 token。
- 最近 1000 条已完成消息 ID 会被保存，避免重复回复。

## 安全边界

- 只接受 `allowedSenderOpenId` 指定用户的单聊文本；群消息、其他发送者和非文本消息全部忽略。
- 飞书触发的 Codex 默认使用 `danger-full-access`，能够读写本机文件并执行命令，请仅在受信任的电脑和飞书应用中使用。
- 递归删除、覆盖重要数据、重置凭据或权限、强制推送、清空数据库等难以恢复的操作，仍必须再次征得用户确认。
- 桥接不复制 ChatGPT 登录凭据，也不传输模型内部思维链、reasoning 内容、完整命令或敏感路径。
- 动态卡片中的“Codex 过程说明”来自 CLI 的公开 `agent_message`，属于可展示给用户审阅的进度信息。

## 当前限制

- 仅支持 Windows；App Secret 的保存依赖 Windows DPAPI。
- 仅支持指定单个用户与机器人的私聊文本。
- 同一 Codex 任务不应同时在桌面端和飞书中运行两个回合；桌面端回合结束后再从飞书发送新消息。
- 默认最多接收 12,000 个字符，并在飞书回复超过 10,000 个字符时截断；完整上下文仍保留在 Codex 任务中。
