# Feishu ↔ Codex Bridge

在 macOS 或 Windows 上把飞书群固定连接到本机 Codex Session。它复用 ChatGPT/Codex Desktop/CLI 的登录状态，不需要 OpenAI API Key；你可以从飞书继续同一段 Codex 对话，也能把 Desktop 发起的结果同步回群。

> **Beta 状态**：Windows 有固定 beta release；macOS 移植目前以 `v0.3.2-macos-rc.10` 提供固定候选 tag，基于上游提交 `7c8668e` 的领域目录与静态检查基线，尚未提升为稳定 release。两者都依赖 Codex App Server 的实验性 WebSocket 接口，不建议作为无人值守的生产服务。仓库保留的 Project Agent/多人协作实现仍是实验代码。

## 版本边界

| 基线 | 包含内容 |
| --- | --- |
| 固定安装版 `v0.3.1-beta.1` | Session 绑定、queue/steer、公开进度、最终提醒、模型/Plan/Goal 控制、原生附件和 Desktop 连续 watchdog |
| 上游 `7c8668e` | 已合并附件 PR #12，并完成领域目录迁移、稳定/实验代码隔离、Codex Session 拆分和 ESLint 语义检查 |
| `v0.3.2-macos-rc.10` | 保留 rc.9 的代理与 watchdog 修复，并把完整安装要求收拢到固定版本协议链接 |

当前 `package.json` 仍为 `0.3.1-beta.1`，但 `main` 已包含固定 tag 之后的改动。安装代理仍应使用明确 release tag；在下一个固定 tag 发布前，不要把 `main` 新能力当作 `v0.3.1-beta.1` 的发布保证。

- [v0.3.1-beta.1 Release Note](docs/releases/v0.3.1-beta.1.md)
- [v0.3.2-macos-rc.10 Release Note](docs/releases/v0.3.2-macos-rc.10.md)
- [v0.3.2-macos-rc.9 Release Note](docs/releases/v0.3.2-macos-rc.9.md)
- [v0.3.2-macos-rc.8 Release Note](docs/releases/v0.3.2-macos-rc.8.md)
- [`main`：Bridge pointer 生命周期](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/8)
- [`main`：单张持久流式卡片](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/9)
- [`main`：长回答文档与媒体转发](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/10)
- [已合并 PR #12：飞书入站附件 relay](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/12)
- [上游 PR #19：静态检查基线](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/19)

## 能做什么

- **固定绑定**：一个仅含 owner 与当前 Bot 的飞书群，对应一个 Codex Session；同一 Bot 可以管理多个绑定群。
- **双向续聊**：飞书和 Codex Desktop 都能向同一 Session 输入，最终回答同步回绑定群。
- **异步输入**：普通消息可按 Session 选择 `queue` 或 `steer`；持久队列在 Bridge 重启后继续恢复。
- **原生控制**：直接在群内查看状态、切换模型与推理强度、控制 Plan/Goal、停止当前 Turn 或管理队列，不把这些命令发送给模型。
- **公开进度**：只转发 Codex 明确标记为 commentary 的公开阶段说明；隐藏思维链、raw reasoning 和工具原始输出不会发送到飞书。
- **可靠投递**：最终答案先写入本机持久发件箱，再发送到飞书；网络失败不会重新运行 Codex。
- **双向文件与长回答**：当前 `main` 可把飞书上传的图片和附件交给 Codex，也会把 Codex 本地媒体作为群内图片/原生附件返回；超长 Markdown 写入飞书云文档。
- **Desktop fail-open**：共享 App Server 与连续 watchdog 会验证监听器和 relay pointer；恢复失败时优先让 Desktop 回退，而不是卡在不可连接的地址。

运行链路：

```text
飞书绑定群
    │  Channel SDK 长连接
    ▼
Feishu Codex Bridge ── 持久队列 / 设置 / 发件箱
    │  loopback WebSocket
    ▼
共享 Codex App Server ◀────▶ Codex Desktop
    │
    ▼
同一个 Codex Session
```

## 安装

### 交给 Codex 安装（推荐）

macOS 请使用固定候选 tag `v0.3.2-macos-rc.10`。把下面两行复制到这台 Mac 上一个新的 Codex 任务；完整执行要求都在固定版本协议内：

```text
请按照以下 GitHub 安装协议，在这台 Mac 上部署并完整验收 Feishu Codex Bridge：
https://raw.githubusercontent.com/ninmon/feishu-codex-bridge/v0.3.2-macos-rc.10/docs/INSTALL_MACOS_PROMPT.md
```

完整协议也可直接查看[给 Codex 的 macOS 全新安装 Prompt](docs/INSTALL_MACOS_PROMPT.md)。Windows 仍使用下面的固定 release 流程：

把下面这段发到一个新的 Codex 对话：

```text
请按照 https://github.com/ninmon/feishu-codex-bridge/releases/tag/v0.3.1-beta.1 中的 AGENTS.md 和 docs/INSTALL_AGENT.md，在这台 Windows 电脑安装并部署 Codex Session Relay。先做只读预检；需要安装系统依赖、创建或修改飞书应用、浏览器授权、管理员审批、输入 App Secret、重启 Codex Desktop 时先说明并等我操作。不得在聊天、日志或仓库中输出 App Secret、token 或账户/会话标识。完成后运行 doctor.ps1 -RequireRunning -RequireDesktopRelay，并实际验证飞书和 Desktop 双向消息。
```

固定 tag 可以避免安装期间读到正在变化的分支。完整协议和人工步骤：

- [Windows 安装指南](docs/INSTALL.md)
- [macOS 安装指南](docs/INSTALL_MACOS.md)
- [给 Codex 的 macOS 全新安装 Prompt](docs/INSTALL_MACOS_PROMPT.md)
- [Codex 安装代理协议](docs/INSTALL_AGENT.md)
- [可复制的安装与升级 Prompt](docs/INSTALL_AGENT_PROMPT.md)
- [飞书自建应用配置](docs/FEISHU_APP_SETUP.md)

### 系统依赖

| 依赖 | 要求 |
| --- | --- |
| 操作系统 | macOS 13+ 或 Windows 10/11 |
| Codex | 已安装并登录 Codex Desktop；CLI/App Server 能力可用 |
| Node.js | `>=22.13.0`，并带 npm |
| 其他 | macOS 自带 Bash/launchd/Keychain，或 PowerShell 5.1/7；Git |
| 飞书 | 可创建企业自建应用的组织账号；macOS 安装脚本会打开官方模板配置权限和事件 |

仓库依赖通过 `npm ci` 安装，锁定 `@larksuite/channel` 和 `@larksuite/cli`；日常使用仓库内的 `lark-cli.sh` 或 `lark-cli.ps1`，无需全局安装飞书 CLI。

## 飞书权限速查

应用权限与事件必须配置并生效；macOS 推荐由 `configure-feishu-app.sh` 打开官方模板一次确认，手工后台配置仅用于故障回退。若飞书要求发布新版本或管理员审批，等待状态生效后再继续。

| 应用权限 | 用途 |
| --- | --- |
| `im:message` | 发送回复、富文本和互动卡片；下载 owner 消息中的图片与附件 |
| `im:message.p2p_msg:readonly` | 接收 Bot 私聊中的 `/add` 与全局设置命令 |
| `im:message.group_msg` | 接收绑定群中未 `@Bot` 的普通消息 |
| `im:chat:readonly` | 读取绑定群基本信息 |
| `im:chat.members:read` | 校验群内严格只有 owner 与当前 Bot |
| `im:chat:create` | 自动创建专属 Session 群 |
| `im:resource` | 把 Codex 输出中的图片、视频和其他文件上传回飞书 |
| `docx:document:create` | 创建长回答云文档（当前 `main`） |
| `docx:document:write_only` | 写入长回答 Markdown（当前 `main`） |

事件订阅必须使用长连接，并包含 `im.message.receive_v1`。

标准安装还会以当前用户身份调用 Feed 标签与长回答文档接口，因此需要浏览器 OAuth：

- `im:feed_group_v1:read`
- `im:feed_group_v1:write`
- `docx:document:create`（当前 `main`）
- `docx:document:write_only`（当前 `main`）

`auth status --json --verify` 的完整结果含身份信息，不要粘贴到聊天、Issue 或日志。App Secret 只允许在本机可见的 `setup-channel-secret.sh`/`.ps1` 交互提示中输入，并由 macOS Keychain 或 Windows DPAPI 保存。

## 开始使用

### 1. 创建绑定

启动并完成 Desktop relay 验证后，私聊 Bot 发送：

```text
/add
```

按编号选择 Codex Desktop Project（或“独立”）和 Session。Bridge 会创建私有群、校验成员、应用个人 Agent 标签并写入固定绑定。也可以在目标 Codex 对话里调用 `$feishu-session-bind`，或直接说“帮我把当前 Session 绑定到飞书群”。

Project 列表只显示未归档的顶层用户任务，排除 guardian 等子 Agent 任务；尚无原生归属的用户任务只有在 cwd 唯一落入该 Project 根目录或 Git worktree 时才会被安全补充，Bridge 不修改 Codex 全局状态。Project 暂时为空时，向导会提供“重新扫描”“返回 Project 列表”和“新建任务”。

绑定完成后，在新群直接发送文本、图片或附件即可，无需 `@Bot`。图片作为 Codex 原生 `localImage` 视觉输入；PDF、Office 文档、压缩包、音视频和其他普通文件会保存到受控本机缓存，并按 Codex Desktop 自身持久化文件 Prompt 的格式提交（文件名、本地路径和 `My request for Codex`）。这让模型可以读取原文件，Desktop 可按原生文件消息呈现；Bridge 不再发送自定义 XML，也不把底层本机路径回显到飞书。飞书无法在同一消息里附带说明的普通文件可以连续上传多条，Bridge 会先暂存，直到第一条普通文字 Prompt 到达，再把全部附件合并为该 Turn 的一次用户输入。Session Relay 不提供 `/new`、`/use` 或全局“当前任务”切换；每个群始终指向自己的 Session。

### 2. 群内命令

这些命令由 Bridge 直接执行，不会作为 prompt 发送给模型：

| 命令 | 作用 |
| --- | --- |
| `/status` | 查看连接、Turn、模型、Plan、Token、Goal、队列和待提交附件摘要 |
| `/stop` | 暂停活动 Goal（如有）并中止当前 Turn；不清空队列 |
| `/queue <Prompt>` | 把 Prompt 作为独立新 Turn 持久排队 |
| `/queue` / `remove` / `clear` | 查看、删除或清空待执行 Prompt |
| `/attachments` / `clear` | 查看或放弃当前 Session 暂存的待提交附件 |
| `/settings` | 查看当前 Session 的输入、公开进度和最终提醒设置 |
| `/settings input steer\|queue` | 设置普通消息是调整当前 Turn，还是排队新 Turn |
| `/settings progress on\|off` | 开关公开 commentary 进度 |
| `/settings mention on\|off` | 开关最终回答的 `@owner` 提醒 |
| `/model` | 查看或修改模型、推理强度和 `standard\|fast` 速度 |
| `/plan on\|off` | 切换 App Server 原生 Plan 模式 |
| `/goal ...` | 创建、暂停、恢复、替换、设置预算或清除原生 Goal |
| `/delete` | 经二次确认解除当前群绑定；不删除群或 Codex Session |
| `/cancel` | 取消进行中的 `/add` 向导 |

未知斜杠文本不会被 Bridge 吞掉。例如 `/review this change` 仍按当前 `queue|steer` 设置交给 Codex。完整参数和行为见 [Session Relay 参考](docs/SESSION_RELAY.md)。

### 3. 默认设置

新安装默认：

```text
queue + 公开进度开启 + 最终回答 @提醒开启
```

在绑定群运行 `/settings` 只修改当前 Session。在 Bot 私聊运行 `/settings` 修改后续新绑定的默认快照，不追改已有群。旧安装中没有设置记录的绑定继续保留旧安全默认，升级不会偷偷改变输入方式。

## 输出、文件与可靠性

- 飞书入站默认单文件不超过 30 MiB；单条消息或同一 Session 的整份暂存草稿最多 10 个资源、总计 60 MiB。暂存附件和已排队附件都会持久化，Bridge 重启后仍能继续。缓存默认保留 7 天，并受 1 GiB 总容量限制。
- 只有第一条普通文字 Prompt 或 `/queue <Prompt>` 会消费暂存附件；`/status`、`/model` 等 Bridge 命令不会。已有附件草稿时，后续纯图片消息也会加入草稿；没有草稿时，单独图片仍立即作为 Prompt 发送。
- 入站图片在 Codex 与最终 Prompt 回显中按图片展示；普通附件只回显安全文件名，不显示飞书 `file_key` 或本机绝对路径。
- 当前 `main` 的一个 Turn 只使用一张可更新卡片；公开进度在原卡片刷新，完成后由最终答案原位替换，并显示完成时间、总用时和本轮真实 Token。
- 公开进度始终不 `@`；最终回答可按 Session 设置发送一次完成提醒。
- 固定版支持本地图片与原生附件。当前 `main` 中，图片不超过 10 MiB 时内嵌；视频及其他文件不超过 30 MiB 时作为原生附件发送，且不暴露本机绝对路径。
- 当前 `main` 中，最终文本超过 `maxReplyChars` 时会写入当前用户的飞书云文档；创建失败则回退到普通文本投递。
- Bridge 启动时不会补发历史答案；若启动时绑定 Session 正在运行，会接管活动 Turn，并补齐断线期间刚完成的结果。
- 最终回答和附件先写入持久发件箱，使用确定性投递 ID 重试；发送失败不会重复运行 Codex。

## 安全边界

- 入站消息必须来自绑定 owner，且 `chat_id` 必须精确匹配固定绑定。
- 发送任何可能包含任务内容的结果前，会重新核验群内严格只有 owner 一人和当前 Bot 一个；无法完整核验时 fail closed。
- 默认 `sandboxMode` 是 `workspace-write`。配置也接受 `read-only` 和高风险的 `danger-full-access`；不要在不可信群、共享应用或不受控工作区启用全权限。
- 共享 App Server 只允许 `ws://` loopback 地址，不接受远程监听器。
- App Secret、OAuth token、App ID、open ID、chat ID、Codex Session 标识、真实配置和本机任务路径都不应进入聊天、日志或 Git。
- Bridge 不传输隐藏思维链、raw reasoning、完整工具输出或敏感本机路径。

## 日常运维

macOS：

```bash
./start-bridge.sh
./status-bridge.sh
./doctor.sh --require-running
./stop-bridge.sh
```

Windows：

```powershell
.\start-bridge.ps1
.\status-bridge.ps1
.\doctor.ps1 -RequireRunning
.\stop-bridge.ps1
```

首次启用共享 App Server 时，还要运行：

macOS：

```bash
./configure-codex-desktop-relay.sh
./doctor.sh --require-running --require-desktop-relay
```

Windows：

```powershell
.\configure-codex-desktop-relay.ps1
.\doctor.ps1 -RequireRunning -RequireDesktopRelay
```

严格 Doctor 通过后，完全退出并重新打开 ChatGPT/Codex Desktop，让新进程读取 relay pointer。正常停止请使用对应平台的 `stop-bridge.sh` 或 `stop-bridge.ps1`，不要单独结束 Bridge、supervisor 或 App Server 进程。

升级固定 release：

```powershell
.\update.ps1 -Version <目标 release tag>
```

两个平台的升级器都会拒绝脏工作树，保留本机配置、凭据、绑定、Session 设置、待提交附件草稿、队列、输入账本和投递状态；失败时自动回滚。macOS 使用 `./update.sh --version <tag>`，且必须先完全退出 Desktop，再从独立 Terminal 执行；updater 会拒绝从活跃 Codex 任务中自更新。Windows 使用 `.\update.ps1 -Version <tag>`；不得跨平台混用。详见 [macOS 更新](docs/INSTALL_MACOS.md#更新固定版本) 与 [Windows 更新](docs/INSTALL.md#更新)。

## 文档

- [Session Relay 行为、命令与生命周期参考](docs/SESSION_RELAY.md)
- [macOS 安装与运维](docs/INSTALL_MACOS.md)
- [给 Codex 的 macOS 全新安装 Prompt](docs/INSTALL_MACOS_PROMPT.md)
- [Windows 安装与升级](docs/INSTALL.md)
- [飞书应用、权限、事件、发布与 OAuth](docs/FEISHU_APP_SETUP.md)
- [Codex 安装代理协议](docs/INSTALL_AGENT.md)
- [Project Agent / 多人协作保留模式](docs/PROJECT_AGENT.md)
- Release Notes：[v0.1](docs/releases/v0.1.0-beta.1.md) · [v0.2](docs/releases/v0.2.0-beta.1.md) · [v0.3](docs/releases/v0.3.0-beta.1.md) · [v0.3.1](docs/releases/v0.3.1-beta.1.md)

## 开发与验证

```bash
npm ci
npm test
node --check ./session-relay.mjs
```

提交前还应运行 `git diff --check`。真实 `bridge.config.json`、Keychain/DPAPI 凭据、运行状态、日志和身份/会话标识不得提交到仓库。
