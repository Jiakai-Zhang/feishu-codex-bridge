# Feishu ↔ Codex Project Bridge

这个 Windows 本地桥接不使用 OpenAI API Key。它复用当前电脑的 ChatGPT/Codex 登录态，通过飞书 Channel SDK 把成员消息送入本机 Codex，并把结果发回飞书。

## 协作模型

每位成员运行自己的飞书应用 Bot、Bridge 和 Codex；一个协作群严格绑定一个共同 GitHub 仓库，而每位成员只能把该群绑定到自己机器上的一个 Bridge Project：

```text
1 个飞书协作群
├─ 1 个规范化 GitHub 仓库（所有成员必须相同）
├─ 成员 A + Bot A + 本机 Bridge Project A
│  ├─ 多个 Git worktree / branch
│  └─ 每个 worktree 下多个 Codex 任务（对话）
└─ 成员 B + Bot B + 本机 Bridge Project B
   ├─ 多个 Git worktree / branch
   └─ 每个 worktree 下多个 Codex 任务（对话）
```

本机 `project.id`、绝对路径和 Codex task ID 可以不同，也不会作为跨机器身份。跨 Agent 授权只认同一个飞书群、规范化 GitHub `owner/repository`、受信成员/Bot 身份和经过验证的 Git 提交。

若要协作另一个 Project 或仓库，请创建另一个群，或先显式停用并重新绑定；同一 Bridge Project 不能同时加入多个协作群。

当前 executor 是 Codex。`agent.executor.type` 保留了以后接入其他 Agent 的边界，但任何 executor 都必须继续遵守 Project、Git、飞书身份和审批策略。

## 群里的自然语言如何到达 Agent

`collaboration.groupHumanMessageMode` 有两种模式：

- `owner`（推荐）：群里 owner 的普通文本即使没有 @Bot，也会进入 owner 自己的 Agent。Agent 根据自然语言和当前对话判断它是讨论、本地指令还是协作请求。
- `mention`：只有真实 @本 Bot 的群消息才进入 Agent。

其他成员未 @ 时不会调用这个 Bot；每个成员的 Bridge 都只把自己 owner 的普通消息送给自己的 Agent。`@所有人` 不触发。peer Bot 发出的协议事件必须真实 @本 Bot，并以飞书事件中的 Bot open_id 通过 `trustedPeers` 校验。

`owner` 模式要求飞书应用能够接收群内普通消息，而不只是“群内 @Bot 消息”。Bot-to-Bot 还需开启 Channel SDK 文档所述的 `im:message.group_at_msg` / `include_bot` 能力；权限不足时平台可能静默不投递。

## 自然语言协作流程

仓库根目录跟踪 Project 级 Skill：

```text
.agents/skills/feishu-agent-collaboration/
├─ SKILL.md
├─ agents/openai.yaml
└─ scripts/delegate.mjs
```

Codex 会从仓库范围加载它。不要把这项能力装成用户全局 Skill，也不要放进单数 `.agent/`；否则其他 Project 可能误用这个群绑定。

当用户在自己的 Agent 对话里说“把这部分交给 Alice 的 Agent 继续”“让 Bob 审查并把结果接回当前对话”时：

1. Agent 判断请求确实需要协作，并按 Skill 检查当前 branch 与 `git status`。
2. 只有用户已授权交接且改动范围明确时，Agent才创建聚焦提交；工作树仍脏时拒绝伪装成已 Git 同步。
3. Skill 将请求写入本机 Bridge 的持久收件箱。机器绑定保存在 Git common dir 的 `feishu-codex-bridge/collaboration.json`，所有 worktree 可见，但不进入 Git 提交。
4. Bridge 再次验证本机 Agent/Project、群、GitHub 仓库、remote、cwd、branch、完整 SHA、TTL 和 peer；随后使用非 force push 发布精确提交。
5. Bridge 在绑定群里同时 @对方成员和对方 Bot。人类可见消息包含任务摘要与 `branch@commit`，另有经过身份验证的机器事件供 Bot 消费。
6. 接收端只 fetch 指定 remote/branch，并要求 `FETCH_HEAD` 与事件中的完整 SHA 相同。已有干净分支只允许 fast-forward；脏工作树或分叉直接进入 blocked。
7. 接收端按 `manual`、`recommend` 或 `auto` 选择：继续已有对话、在已有 worktree 新建对话，或创建该分支 worktree 与新对话。
8. 执行 Agent 完成验证并提交聚焦改动。Bridge 要求 worktree 干净，再以非 force push 发布结果提交；协议只返回摘要和 Git，不返回对方本机路径/Project/task ID。
9. `resultMode=notify` 只通知请求方；`resultMode=resume` 会先安全 fast-forward 请求方的干净 worktree，再把结果送回原 Codex 对话继续判断。

默认使用 `receiveMode=recommend`、`resultMode=notify`。只有用户明确希望对方完全接管时才用 `auto`；只有明确希望原对话自动续接结果时才用 `resume`。

## 创建协作群

1. 每位成员创建一个专用于该 Codex 的飞书自建应用，启用 Bot 与长连接事件接收，并分别用 DPAPI 安全启动器保存 App Secret。
2. 创建一个飞书群，把所有协作成员及其 Bot 加入同一个群。
3. 获取群 `chat_id`、每个人类成员的 `open_id` 和每个 Bot 的 `open_id`。
4. 每位成员把同一个 `groupChatId` 和同一个 `githubRepository` 写入自己的本地 `bridge.config.json`；`project.*` 指向各自本机的 checkout/worktree 根。
5. 先保持 `collaboration.enabled=false`，运行配置测试并核对 remote；确认每个 Bot 的成员/Bot 对以后再启用并重启 Bridge。
6. 在群内分别测试 owner 普通消息、owner @Bot、Bot-to-Bot @ 和 `/peer ping owner/repository`。

不要把 App Secret、GitHub token 或 DPAPI 密文复制到群、Skill、配置示例或仓库。真实 `bridge.config.json`、`.agent/` 与运行收件箱均被 `.gitignore` 排除。

## 安装与配置

需要 Windows、Node.js、已登录的 Codex CLI、飞书 CLI，以及启用了 Channel SDK 的飞书自建应用。

```powershell
npm install
Copy-Item .\bridge.config.example.json .\bridge.config.json
```

协作配置核心示例：

```json
{
  "schemaVersion": 3,
  "appId": "cli_xxx",
  "workspace": "C:\\CodexBridgeRuntime",
  "agent": {
    "id": "alice-codex",
    "displayName": "Alice Codex",
    "ownerOpenId": "ou_alice",
    "botOpenId": "ou_alice_bot",
    "allowedHumanOpenIds": ["ou_alice"],
    "executor": { "type": "codex" }
  },
  "project": {
    "id": "alice-local-project",
    "name": "Shared Repository",
    "repoRoot": "G:\\Projects\\shared-repository",
    "worktreeRoot": "G:\\Worktrees\\shared-repository",
    "allowedWorktreeRoots": [
      "G:\\Projects\\shared-repository",
      "G:\\Worktrees\\shared-repository"
    ],
    "defaultBranch": "main",
    "protectDefaultBranch": true,
    "allowedRemotes": ["origin"]
  },
  "collaboration": {
    "enabled": true,
    "groupChatId": "oc_shared_group",
    "githubRepository": "example/shared-repository",
    "remote": "origin",
    "groupHumanMessageMode": "owner",
    "receiveMode": "recommend",
    "approverOpenIds": ["ou_alice"],
    "trustedPeers": [
      {
        "agentId": "bob-codex",
        "displayName": "Bob Codex",
        "humanOpenId": "ou_bob",
        "humanDisplayName": "Bob",
        "botOpenId": "ou_bob_bot",
        "enabled": true
      }
    ],
    "maxHops": 2,
    "eventTtlMs": 900000,
    "taskLeaseMs": 43200000
  },
  "sandboxMode": "workspace-write"
}
```

关键字段：

- `workspace`：日志、去重、发件箱和临时文件的本机运行根；不是代码仓库。
- `project.repoRoot`：必须等于 `git rev-parse --show-toplevel`。
- `project.worktreeRoot`：新任务 worktree 的父目录。
- `project.allowedWorktreeRoots`：允许访问的 worktree 路径边界；包含 `repoRoot` 和 `worktreeRoot`。
- `project.allowedRemotes`：Project 允许的 Git remote；`collaboration.remote` 必须是其成员。
- `project.desktopProjectId`：可选，只读核对 Codex Desktop 的侧边栏分组。Bridge Project 才是执行/安全边界。
- `collaboration.groupChatId`：唯一绑定群。启用时必填，不能配置第二个群。
- `collaboration.githubRepository`：唯一共享 GitHub `owner/repository`；HTTPS/SSH remote 都会规范化后比较。
- `collaboration.trustedPeers`：每个 peer 必须有唯一的 `agentId`、`humanOpenId` 和 `botOpenId`。
- `collaboration.receiveMode`：本机最高自动化级别。发送方不能强迫接收方比本机策略更自动；`manual > recommend > auto` 取更严格者。
- `collaboration.approverOpenIds`：可选择落点、接单、拒绝和审批结果的人类；必须是 `agent.allowedHumanOpenIds` 的子集。
- `collaboration.taskLeaseMs`：本机 `(project.id, branch)` 协作租约，防止 Bridge 同时执行同一分支。

随后运行 `setup-channel-secret.ps1` 隐藏输入 App Secret。脚本使用 Windows DPAPI 加密保存；明文不会写入配置、日志或仓库，启动器只在内存中解密并传给子进程。

## 启动与停止

```powershell
& .\start-bridge.ps1
& .\status-bridge.ps1
& .\stop-bridge.ps1
```

运行状态位于 `<workspace>\work\feishu-codex-bridge`。启动时 Bridge 会核对真实 Git remote；启用协作但 remote 不是绑定 GitHub 仓库时 fail closed。

## 飞书命令

```text
/project
/branches
/worktrees
/threads
/threads branch task/LOGIN-123
/use 2
/new --branch task/LOGIN-123 修复登录问题
/current
/status
/model
/capacity
/team
/team-tasks
/delegate bob-codex task/LOGIN-123 修复登录问题并运行测试
/team-options task:...
/team-accept task:... auto
/team-accept task:... thread:<本机Codex任务ID>
/team-accept task:... new-thread
/team-accept task:... new-worktree
/team-reject task:... 超出范围
/team-approve task:... 已审阅
/knowledge list
/audit 20
/metrics
/help
```

自然语言 + Project Skill 是主要协作入口；`/delegate` 是显式备用入口，而且要求命令分支与当前选中的 Codex 任务分支一致、worktree 干净并可安全推送。

- `/team-options`：列出当前机器上该分支可继续的对话、已有 worktree 新对话和新 worktree 选项。
- `/team-accept ... auto`：使用当前推荐；`thread:<id>` 只接受本机 Project 中同一分支的任务。
- `/team-tasks`：显示方向、requester/executor、仓库、分支、提交和状态，不显示完整提示词。
- `/peer ping <owner/repository> [requestId]`、`/peer status ...`：无模型、无写入的仓库绑定控制面。
- `/team-approve`：将“执行完成”和“请求方确认”分开。

## Project 与 Git 安全边界

- `/threads` 和 `/use` 验证任务 cwd、真实路径、注册 worktree 与记录分支；不能跳到本机其他 Project。
- 切换 Codex 任务不会执行 `git checkout`。
- `/new --branch` 一条可写分支对应一个独立 worktree；受保护默认分支强制 `read-only`。
- 协作发出前要求完整 SHA 和干净 worktree。Bridge 不会替 Agent提交脏改动。
- push 永不使用 `--force`；接收端只接受精确 fetch 和 fast-forward。分叉、脏工作树、范围外 worktree、锁定/游离 HEAD、错误 remote 或默认分支写入均阻塞。
- 协议不传递本机绝对路径、远端 Project ID 或远端 Codex task ID。
- 递归删除、重置、clean、force push、覆盖重要数据、修改凭据/权限等难以恢复的操作不属于自动协作合同。

Bridge Project 与 Codex Desktop Project 是两个对象：前者负责执行和安全，后者只负责 Desktop 目录/任务分组。当前独立 Codex App Server 的 `thread/start` 不接受 `projectId`，所以 `/new` 不会自动进入 Desktop Project 分组，但仍按真实 cwd 保存在本机并受 Bridge Project 校验。

## Agent 事件与可靠性

Agent 协议 v2 包含事件/任务 ID、唯一群、规范化 GitHub 仓库、发送/接收 Agent、requester/executor、TTL、hop 和有界 payload：

- `task.request`：标题、提示词、接收模式、结果模式和 `{remote, branch, commit}`。
- `task.accepted` / `task.progress`：接收端本地落点类型和进度；不暴露 task ID/path。
- `task.result`：摘要和结果 Git；没有远端 thread ID。
- `task.blocked` / `task.rejected` / `task.approved`：阻塞、拒绝和请求方确认。

`team-tasks.json` 持久化状态并按 `eventId` 去重。Bot-to-Bot 事件在发送前写入 `pending-agent-events.json`，失败后指数退避；Codex 最终回复先写入 `pending-deliveries.json`，网络失败不会重新运行 Codex。`audit.jsonl` 使用递增序号和 SHA-256 前向哈希链，记录 ID、分支、提交和错误码等元数据，不记录提示词正文、结果正文、凭据或完整路径。

## 共享 Team Hub

可选 Team Hub 保存稳定知识，不保存实时任务状态：

```text
<teamHub.path>/projects/<project.id>/
├─ knowledge/<id>.md + <id>.meta.json
├─ summaries/<id>.md + <id>.meta.json
└─ references/<id>.md + <id>.meta.json
```

metadata 保存类别、ID、标题、repository IDs、作者、时间和 SHA-256 revision。更新使用乐观锁，外部或并发修改不会被静默覆盖。每个 Codex 回合在 `maxContextChars` 内按 `knowledge → summaries → references` 注入，并明确以当前仓库/运行态的可验证事实为准。Bridge 不自动为 Team Hub commit、pull 或 push。

## 测试

```powershell
npm test
node --check .\channel-bridge.mjs
```

测试覆盖配置边界、群路由、协议身份、任务状态机、Skill 收件箱、精确 Git push/fetch/fast-forward、落点选择、审计链、可靠发件箱和 Project/worktree 校验。
