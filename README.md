# Feishu ↔ Codex Bridge

在 macOS 或 Windows 上把飞书群固定连接到本机 Codex Session。它复用 ChatGPT/Codex Desktop/CLI 的登录状态，不需要 OpenAI API Key；你可以从飞书继续同一段 Codex 对话，也能把 Desktop 发起的结果同步回群。

> **Beta 状态**：macOS 私有多用户候选版为 `v0.4.0-macos-rc.2`；Windows 公开候选版为 `v0.3.2-windows-rc.4`，私有多用户候选版为 `v0.4.0-windows-rc.1`。它们都依赖 Codex App Server 的实验性 WebSocket 接口，不建议作为无人值守的生产服务。v0.4 候选版共享同一套成员目录与多人 Session 权限模型，平台安装、凭据和 Desktop relay 仍各自隔离。

## 版本边界

| 基线 | 包含内容 |
| --- | --- |
| 固定安装版 `v0.3.1-beta.1` | Session 绑定、queue/steer、公开进度、最终提醒、模型/Plan/Goal 控制、原生附件和 Desktop 连续 watchdog |
| 上游 `be75d65` | 在附件与领域架构基线上继续合并原生媒体、串行 JSON 持久化、私聊临时 Chat 和单 Session writer 冲突隔离 |
| `v0.3.2-macos-rc.10` | 保留 rc.9 的代理与 watchdog 修复，并把完整安装要求收拢到固定版本协议链接 |
| `v0.3.2-macos-rc.11` | 安装前强制当前对话 Full access，增加 Keychain 诊断和不含 App ID 的浏览器备用 URL |
| `v0.3.2-macos-rc.12` | 合入原生媒体、临时 Chat、串行持久化和单 Session writer 隔离，并补齐私有发行源、升级回滚与 macOS CI |
| `v0.3.2-windows-rc.4` | Windows 安装前强制当前对话 Full access，补齐 Doctor/relay 提示及 Windows 上的 POSIX 附件路径归一化 |
| `v0.4.0-windows-rc.1` | 私有 Windows 测试版：成员个人 Project 目录、Session 共享权限、多人群 queue/steer 规则，以及保留 Desktop 代理/守护状态的事务升级 |
| `v0.4.0-macos-rc.1` | 私有 macOS 测试版：同步 Windows v0.4 的多用户 Session 权限，新增不暴露绝对路径的 `setup-project-root.sh`，并保留 Keychain、launchd relay 和升级回滚边界 |
| `v0.4.0-macos-rc.2` | macOS 多用户候选版：登记成员后由 Bot 主动发送私聊欢迎消息和 `/add` 指引；投递失败不回滚成员状态，并向 Owner 提供安全兜底 |

当前项目不发布 npm 包，`package.json` 仍保留 `0.3.1-beta.1`；平台固定 tag 才是安装版本依据。安装代理必须使用明确 release tag，不得用持续变化的 `main` 代替固定版本。

- [v0.3.1-beta.1 Release Note](docs/releases/v0.3.1-beta.1.md)
- [v0.3.2-macos-rc.12 Release Note](docs/releases/v0.3.2-macos-rc.12.md)
- [v0.4.0-macos-rc.1 Release Note](docs/releases/v0.4.0-macos-rc.1.md)
- [v0.4.0-macos-rc.2 Release Note](docs/releases/v0.4.0-macos-rc.2.md)
- [v0.4.0-windows-rc.1 Release Note](docs/releases/v0.4.0-windows-rc.1.md)
- [v0.3.2-macos-rc.11 Release Note](docs/releases/v0.3.2-macos-rc.11.md)
- [v0.3.2-macos-rc.10 Release Note](docs/releases/v0.3.2-macos-rc.10.md)
- [v0.3.2-macos-rc.9 Release Note](docs/releases/v0.3.2-macos-rc.9.md)
- [v0.3.2-macos-rc.8 Release Note](docs/releases/v0.3.2-macos-rc.8.md)
- [v0.3.2-windows-rc.4 Release Note](docs/releases/v0.3.2-windows-rc.4.md)
- [v0.3.2-windows-rc.3 Release Note](docs/releases/v0.3.2-windows-rc.3.md)
- [v0.3.2-windows-rc.1 Release Note](docs/releases/v0.3.2-windows-rc.1.md)
- [`main`：Bridge pointer 生命周期](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/8)
- [`main`：单张持久流式卡片](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/9)
- [`main`：长回答文档与媒体转发](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/10)
- [已合并 PR #12：飞书入站附件 relay](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/12)
- [上游 PR #19：静态检查基线](https://github.com/Jiakai-Zhang/feishu-codex-bridge/pull/19)

## 能做什么

- **固定绑定**：一个初始只含 Session owner 与当前 Bot 的规范绑定群，对应一个 Codex Session；启用多用户后可加入已登记成员共享该 Session，同一 Bot 可以管理多个绑定群。
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

macOS 请使用私有仓库固定候选 tag `v0.4.0-macos-rc.2`。把下面内容复制到这台 Mac 上一个新的 Codex 任务；Codex 会通过本机已登录的 GitHub CLI 读取私有固定版本，完整执行要求仍全部放在仓库协议内：

```text
请使用本机已登录且有仓库访问权的 GitHub CLI，完整读取并执行以下私有固定版本中的安装协议：
仓库：ninmon/feishu-codex-bridge-private
tag：v0.4.0-macos-rc.2
文件：docs/INSTALL_MACOS_PROMPT.md
将文件中“可复制 Prompt”部分视为我的完整执行指令，不得改用 main 或其他版本。
如果 GitHub CLI 未安装、未登录或没有仓库权限，请明确告诉我并暂停，不得索取或输出访问 Token。
```

完整协议也可直接查看[给 Codex 的 macOS 全新安装 Prompt](docs/INSTALL_MACOS_PROMPT.md)。

Windows 固定候选版 `v0.3.2-windows-rc.4` 同样只需复制两行。安装代理会先暂停，要求把当前 Codex 对话设为“完全访问（Full access）”；“替我审批”不能代替该权限：

```text
请按照以下 GitHub 安装协议，在这台 Windows 电脑上部署并完整验收 Feishu Codex Bridge：
https://raw.githubusercontent.com/ninmon/feishu-codex-bridge/v0.3.2-windows-rc.4/docs/INSTALL_WINDOWS_PROMPT.md
```

固定 tag 可以避免安装期间读到正在变化的分支。完整协议和人工步骤：

- [Windows 安装指南](docs/INSTALL.md)
- [macOS 安装指南](docs/INSTALL_MACOS.md)
- [给 Codex 的 macOS 全新安装 Prompt](docs/INSTALL_MACOS_PROMPT.md)
- [给 Codex 的 Windows 全新安装 Prompt](docs/INSTALL_WINDOWS_PROMPT.md)
- [Codex 安装代理协议](docs/INSTALL_AGENT.md)
- [可复制的安装与升级 Prompt](docs/INSTALL_AGENT_PROMPT.md)
- [飞书自建应用配置](docs/FEISHU_APP_SETUP.md)

### 系统依赖

| 依赖 | 要求 |
| --- | --- |
| 操作系统 | macOS 13+ 或 Windows 10/11 |
| Codex | 已安装并登录 Codex Desktop；CLI/App Server 能力可用；macOS 或 Windows 由 Codex 执行安装时，当前对话均已设为“完全访问（Full access）”；“替我审批”不解除沙盒边界 |
| Node.js | `>=22.13.0`，并带 npm |
| 其他 | macOS 自带 Bash/launchd/Keychain，或 PowerShell 5.1/7；Git |
| 飞书 | 可创建企业自建应用的组织账号；macOS 和 Windows 安装脚本都会打开官方模板配置权限和事件 |

仓库依赖通过 `npm ci` 安装，锁定 `@larksuite/channel` 和 `@larksuite/cli`；日常使用仓库内的 `lark-cli.sh` 或 `lark-cli.ps1`，无需全局安装飞书 CLI。

## 飞书权限速查

应用权限与事件必须配置并生效；macOS 使用 `configure-feishu-app.sh`，Windows 使用 `configure-feishu-app.ps1` 打开官方模板一次确认，手工后台配置仅用于故障回退。若飞书要求发布新版本或管理员审批，等待状态生效后再继续。

| 应用权限 | 用途 |
| --- | --- |
| `im:message` | 发送回复、富文本和互动卡片；下载 owner 消息中的图片与附件 |
| `im:message.p2p_msg:readonly` | 接收 Bot 私聊中的 `/chat`、`/add` 与全局设置命令 |
| `im:message.group_msg` | 接收绑定群中未 `@Bot` 的普通消息 |
| `im:chat:readonly` | 读取绑定群基本信息 |
| `im:chat.members:read` | 校验 Session owner、已启用共享成员与唯一当前 Bot |
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

### 1. 私聊临时 Chat

私聊 Bot 发送 `/chat` 可创建一个持久化的临时 Codex Session，并直接在私聊中继续对话：

```text
/chat 帮我分析这个问题
```

`/chat` 后面的正文是第一条 Prompt，不是标题。私聊默认使用 Bridge 启动时的 Codex 工作目录；在已有绑定群中使用时继承原 Session 的工作目录。发送 `/endchat` 结束临时上下文：群内随后返回固定绑定的原 Session，私聊中则可再次发送 `/chat` 新建上下文。已经提交的临时消息不会被取消，完成后仍会回复原飞书会话。临时 Chat、队列和返回位置会跨 Bridge 重启保留。

### 2. 创建绑定

启动并完成 Desktop relay 验证后，在目标 Codex 任务中使用 `$feishu-session-bind`，为当前任务创建或复用专属绑定群。初次安装不需要先建 Bot 私聊。

在已经存在的 Bot 私聊中，仍可选发送：

```text
/add
```

该可选向导会按编号选择 Codex Desktop Project（或“独立”）和 Session。Bridge 会创建私有群、校验成员、尽可能应用个人 Agent 标签并写入固定绑定。绑定群中的 `/add` 会引导回 Bot 私聊，避免把个人任务列表展示给群成员。

Project 列表只显示未归档的顶层用户任务，排除 guardian 等子 Agent 任务；尚无原生归属的用户任务只有在 cwd 唯一落入该 Project 根目录或 Git worktree 时才会被安全补充，Bridge 不修改 Codex 全局状态。选择任意已有 Project 后都可直接“新建任务”；Project 暂时为空时，向导还会提供“重新扫描”和“返回 Project 列表”。

绑定群只有一名人类用户时可直接发送文本、图片或附件，无需 `@Bot`；多人群只有 `@Bot`、回复 Bot 或斜杠命令会进入 Codex，其他消息保留为普通群聊。多人普通 Prompt 固定排入新 Turn，显式 `/steer <调整方向>` 才调整当前回答。图片作为 Codex 原生 `localImage` 视觉输入；PDF、Office 文档、压缩包、音视频和其他普通文件会保存到受控本机缓存，并按 Codex Desktop 自身持久化文件 Prompt 的格式提交（文件名、本地路径和 `My request for Codex`）。这让模型可以读取原文件，Desktop 可按原生文件消息呈现；Bridge 不再发送自定义 XML，也不把底层本机路径回显到飞书。普通文件可以连续上传，草稿按“Session + 发送者”隔离，直到同一发送者的第一条普通文字 Prompt 到达。Session Relay 不提供 `/new`、`/use` 或全局长期任务切换；每个群的长期绑定始终指向自己的 Session，临时 `/chat` 不会修改该绑定。

可选多用户模式由 Owner 在 Bridge 主机运行 macOS `./setup-project-root.sh` 或 Windows `.\setup-project-root.ps1`，设置唯一 Project 根目录和自己的一级目录，再在 Bot 私聊或已有绑定群用 `/members add <目录名> @成员` 显式登记。登记成功后，Bot 会主动私聊新成员并提示发送 `/add`；若应用可用范围或消息投递阻止主动私聊，Owner 会收到明确的手动兜底提示，成员登记不会回滚。每个用户只能 `/add` 自己目录中的 Project/Session；Owner 仍可看到自己目录和不属于任何成员的旧任务。把已登记成员加入绑定群即共享该 Session，但不会共享 Project 列表或目录。群内出现未登记/已停用成员时，Session 内容收发会安全停止。

### 3. 会话命令

这些命令由 Bridge 直接执行，不会作为 prompt 发送给模型：

| 命令 | 作用 |
| --- | --- |
| `/chat [首条 Prompt]` | 在当前飞书私聊或绑定群创建/继续独立的临时 Codex Chat |
| `/endchat` | 结束临时 Chat；群内返回原绑定任务，私聊等待下一次 `/chat` |
| `/status` | 查看连接、Turn、模型、Plan、Token、Goal、队列和待提交附件摘要 |
| `/stop` | 暂停活动 Goal（如有）并中止当前 Turn；不清空队列 |
| `/steer <调整方向>` | 显式调整当前 Turn；共享群仅 Session owner 或当前 Turn 初始发起者可用 |
| `/queue <Prompt>` | 把 Prompt 作为独立新 Turn 持久排队 |
| `/queue` / `remove` / `clear` | 查看、删除或清空待执行 Prompt |
| `/attachments` / `clear` | 查看或放弃当前 Session 暂存的待提交附件 |
| `/settings` | 查看当前 Session 的输入、公开进度和最终提醒设置 |
| `/settings input steer\|queue` | 设置普通消息是调整当前 Turn，还是排队新 Turn |
| `/settings progress on\|off` | 开关公开 commentary 进度 |
| `/settings mention on\|off` | 开关最终回答对初始 Turn 发起者的 `@` 提醒 |
| `/model` | 查看或修改模型、推理强度和 `standard\|fast` 速度 |
| `/plan on\|off` | 切换 App Server 原生 Plan 模式 |
| `/goal ...` | 创建、暂停、恢复、替换、设置预算或清除原生 Goal |
| `/delete` | 经二次确认解除当前群绑定；不删除群或 Codex Session |
| `/cancel` | 取消进行中的 `/add` 向导 |
| `/members ...` | Bridge Owner 登记、停用或查看多用户成员；路径只在主机本地设置 |

未知斜杠文本不会被 Bridge 吞掉。例如 `/review this change` 仍按当前 `queue|steer` 设置交给 Codex。完整参数和行为见 [Session Relay 参考](docs/SESSION_RELAY.md)。

### 4. 默认设置

新安装默认：

```text
queue + 公开进度开启 + 最终回答 @提醒开启
```

在绑定群运行 `/settings` 只修改当前 Session。在 Bot 私聊运行 `/settings` 修改后续新绑定的默认快照，不追改已有群。旧安装中没有设置记录的绑定继续保留旧安全默认，升级不会偷偷改变输入方式。

## 输出、文件与可靠性

- 飞书入站默认单文件不超过 30 MiB；单条消息或同一 Session 的整份暂存草稿最多 10 个资源、总计 60 MiB。暂存附件和已排队附件都会持久化，Bridge 重启后仍能继续。缓存默认保留 7 天，并受 1 GiB 总容量限制。
- 只有第一条普通文字 Prompt 或 `/queue <Prompt>` 会消费暂存附件；`/status`、`/model` 等 Bridge 命令不会。已有附件草稿时，后续纯图片消息也会加入草稿；没有草稿时，单独图片仍立即作为 Prompt 发送。
- 入站图片在 Codex 与最终 Prompt 回显中按图片展示；普通附件只回显安全文件名，不显示飞书 `file_key` 或本机绝对路径。
- 当前 `main` 的一个 Turn 使用一张可更新卡片；公开进度在原卡片刷新，完成后由最终答案原位替换，并显示完成时间、总用时和本轮真实 Token。随后完整最终答案会作为最新消息再次发送，避免原地更新的旧卡片留在聊天上方。
- 公开进度始终不 `@`；最终回答可按 Session 设置 `@` 初始 Turn 发起者，Desktop-only Turn 回退到 Session owner，私聊临时 Chat 不额外 `@`。
- 固定版支持本地图片与原生附件。当前 `main` 中，图片不超过 10 MiB 时内嵌；视频及其他文件不超过 30 MiB 时作为原生附件发送，且不暴露本机绝对路径。
- 当前 `main` 中，最终文本超过 `maxReplyChars` 时会写入当前用户的飞书云文档；创建失败则回退到普通文本投递。
- Bridge 启动时不会补发历史答案；若启动时绑定 Session 正在运行，会接管活动 Turn，并补齐断线期间刚完成的结果。
- 最终回答和附件先写入持久发件箱，使用确定性投递 ID 重试；发送失败不会重复运行 Codex。

## 安全边界

- 入站消息的 `chat_id` 必须精确匹配固定绑定，发送者必须是群内已启用 Bridge 用户。
- 发送任何可能包含任务内容的结果前，会重新核验 Session owner、所有人类成员与唯一当前 Bot；未登记/已停用成员、第三方 Bot 或无法完整核验时 fail closed。
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
.\launch-codex-desktop-with-relay.ps1
.\doctor.ps1 -RequireRunning -RequireDesktopRelay
```

严格 Doctor 通过后，完全退出并重新打开 ChatGPT/Codex Desktop，让新进程读取 relay pointer。正常停止请使用对应平台的 `stop-bridge.sh` 或 `stop-bridge.ps1`，不要单独结束 Bridge、supervisor 或 App Server 进程。

升级固定 release：

```powershell
.\update.ps1 -Version <目标 release tag>
```

保留公开 `origin`、从精确私有镜像获取测试 tag：

```powershell
.\update.ps1 -Version <目标 private release tag> -Remote private
```

两个平台的升级器都会拒绝脏工作树，保留本机配置、凭据、绑定、成员/个人 Project 目录状态、Session 设置、待提交附件与缓存、队列、输入账本和投递状态；失败时自动回滚。Windows 升级器还会在切换 tag 前锁定并备份当前 Desktop 直连/本地代理选择与 bootstrap，目标安装器不得重做中继迁移；无法证明活动 App Server 使用同一网络模式时会在修改 checkout 前停止，不会猜成直连。macOS 使用 `./update.sh --version <tag>`，且必须先完全退出 Desktop，再从独立 Terminal 执行；updater 会拒绝从活跃 Codex 任务中自更新。私有镜像可分别显式使用 Windows `-Remote private` 或 macOS `--remote private`，升级器不会改写 `origin`。不得跨平台混用。详见 [macOS 更新](docs/INSTALL_MACOS.md#更新固定版本) 与 [Windows 更新](docs/INSTALL.md#更新)。

## 文档

- [Session Relay 行为、命令与生命周期参考](docs/SESSION_RELAY.md)
- [macOS 安装与运维](docs/INSTALL_MACOS.md)
- [给 Codex 的 macOS 全新安装 Prompt](docs/INSTALL_MACOS_PROMPT.md)
- [给 Codex 的 Windows 全新安装 Prompt](docs/INSTALL_WINDOWS_PROMPT.md)
- [Windows 安装与升级](docs/INSTALL.md)
- [飞书应用、权限、事件、发布与 OAuth](docs/FEISHU_APP_SETUP.md)
- [Codex 安装代理协议](docs/INSTALL_AGENT.md)
- [Project Agent / 多人协作保留模式](docs/PROJECT_AGENT.md)
- Release Notes：[v0.1](docs/releases/v0.1.0-beta.1.md) · [v0.2](docs/releases/v0.2.0-beta.1.md) · [v0.3](docs/releases/v0.3.0-beta.1.md) · [v0.3.1](docs/releases/v0.3.1-beta.1.md) · [macOS v0.4 rc.1](docs/releases/v0.4.0-macos-rc.1.md) · [macOS v0.4 rc.2](docs/releases/v0.4.0-macos-rc.2.md) · [Windows v0.4 rc.1](docs/releases/v0.4.0-windows-rc.1.md)

## 开发与验证

```bash
npm ci
npm test
node --check ./session-relay.mjs
```

提交前还应运行 `git diff --check`。真实 `bridge.config.json`、Keychain/DPAPI 凭据、运行状态、日志和身份/会话标识不得提交到仓库。
