# Project Agent / 多人协作保留模式

> **实验性保留代码，不属于当前 Beta 发布合同。** 当前安装和支持路径是 [个人 Session Relay](SESSION_RELAY.md)。本文件供继续开发 `mode=project-agent` 与多人协作协议时参考，不应当作现有安装指南。

## 设计目标

每位成员运行自己的飞书应用 Bot、Bridge 和 Codex。一个协作群严格绑定一个共同 GitHub 仓库，每位成员只把该群绑定到自己机器上的一个 Bridge Project：

```text
1 个飞书协作群
├─ 1 个规范化 GitHub 仓库（所有成员必须相同）
├─ 成员 A + Bot A + 本机 Bridge Project A
│  ├─ 多个 Git worktree / branch
│  └─ 每个 worktree 下多个 Codex 任务
└─ 成员 B + Bot B + 本机 Bridge Project B
   ├─ 多个 Git worktree / branch
   └─ 每个 worktree 下多个 Codex 任务
```

本机 Project ID、绝对路径和 Codex task ID 可以不同，也不作为跨机器身份。跨 Agent 授权只认：

- 同一个飞书群；
- 规范化 GitHub `owner/repository`；
- 受信成员与 Bot 身份；
- 经过验证的 Git remote、branch 和完整提交 SHA。

若要协作另一个 Project 或仓库，应创建另一个群，或先显式停用并重新绑定。同一个 Bridge Project 不能同时加入多个协作群。

当前 executor 是 Codex。`agent.executor.type` 只保留以后接入其他 Agent 的边界；任何 executor 都必须继续遵守 Project、Git、飞书身份与审批策略。

## 群内自然语言路由

`collaboration.groupHumanMessageMode` 支持：

- `owner`（推荐）：owner 的普通文本即使未 `@Bot`，也会进入 owner 自己的 Agent。
- `mention`：只有真实 `@` 当前 Bot 的群消息才进入 Agent。

其他成员未 `@` 时不会调用这个 Bot；每位成员的 Bridge 只把自己 owner 的普通消息交给自己的 Agent。`@所有人` 不触发。peer Bot 的协议事件必须真实 `@` 当前 Bot，并通过 `trustedPeers` 的 Bot 身份校验。

`owner` 模式要求应用接收群内普通消息，而不只是 `@Bot` 消息。Bot-to-Bot 还依赖 Channel SDK 的群内 Bot mention/include-bot 能力。

## Project 级协作 Skill

仓库跟踪 Project 级 Skill：

```text
.agents/skills/feishu-agent-collaboration/
├─ SKILL.md
├─ agents/openai.yaml
└─ scripts/delegate.mjs
```

Codex 从当前仓库范围加载它。不要把它安装成用户全局 Skill，也不要放入单数 `.agent/`；否则其他 Project 可能误用当前群绑定。

当用户明确说“把这部分交给 Alice 的 Agent 继续”或“让 Bob 审查并把结果接回当前对话”时，流程是：

1. 检查当前 branch、worktree、请求范围和 `git status`；
2. 只有用户授权交接且范围明确时，才创建聚焦提交；
3. Skill 把请求写入 Bridge 的持久收件箱；
4. Bridge 验证 Project、群、GitHub 仓库、remote、cwd、branch、完整 SHA、TTL 和 peer；
5. 只以非 force push 发布精确提交；
6. 接收端 fetch 指定 remote/branch，并要求 `FETCH_HEAD` 与事件 SHA 完全一致；
7. 已有干净分支只允许 fast-forward；脏工作树或分叉进入 blocked；
8. 接收端按 `manual`、`recommend` 或 `auto` 选择落点；
9. 执行 Agent 完成验证与聚焦提交，再以非 force push 发布结果；
10. `resultMode=notify` 只通知请求方，`resultMode=resume` 才会安全 fast-forward 并恢复原 Codex 对话。

默认使用 `receiveMode=recommend`、`resultMode=notify`。只有用户明确要求完全接管时才使用 `auto`；只有明确希望原对话自动续接结果时才使用 `resume`。

## 创建协作群

1. 每位成员创建一个专用于 Codex 的飞书自建应用，启用 Bot 与长连接事件。
2. 每位成员通过自己的 `setup-channel-secret.ps1` 保存 DPAPI 加密 App Secret。
3. 创建一个包含所有协作成员及其 Bot 的飞书群。
4. 每位成员在本机配置同一个 `groupChatId` 和 `githubRepository`，但 `project.*` 指向各自 checkout/worktree 根。
5. 先保持 `collaboration.enabled=false`，运行配置与 remote 检查。
6. 核对所有成员/Bot 身份后再启用并重启 Bridge。
7. 分别验证 owner 普通消息、owner `@Bot`、Bot-to-Bot `@` 与 `/peer ping owner/repository`。

不要把 App Secret、GitHub token、DPAPI 密文、身份标识或本机任务路径复制到群、Skill、配置示例或仓库。

## 配置边界

协作配置的核心结构：

```json
{
  "schemaVersion": 3,
  "mode": "project-agent",
  "appId": "<APP_ID>",
  "workspace": "C:\\CodexBridgeRuntime",
  "agent": {
    "id": "alice-codex",
    "displayName": "Alice Codex",
    "ownerOpenId": "<OWNER_OPEN_ID>",
    "botOpenId": "<BOT_OPEN_ID>",
    "allowedHumanOpenIds": ["<OWNER_OPEN_ID>"],
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
    "groupChatId": "<GROUP_CHAT_ID>",
    "githubRepository": "example/shared-repository",
    "remote": "origin",
    "groupHumanMessageMode": "owner",
    "receiveMode": "recommend",
    "approverOpenIds": ["<OWNER_OPEN_ID>"],
    "trustedPeers": [
      {
        "agentId": "bob-codex",
        "displayName": "Bob Codex",
        "humanOpenId": "<PEER_OPEN_ID>",
        "humanDisplayName": "Bob",
        "botOpenId": "<PEER_BOT_OPEN_ID>",
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

- `workspace`：日志、去重、发件箱与临时文件的本机运行根，不是代码仓库。
- `project.repoRoot`：必须等于 `git rev-parse --show-toplevel`。
- `project.worktreeRoot`：新任务 worktree 的父目录。
- `project.allowedWorktreeRoots`：允许访问的真实路径边界。
- `project.allowedRemotes`：Project 允许的 Git remote。
- `project.desktopProjectId`：可选，只读核对 Codex Desktop 分组；不作为执行安全边界。
- `collaboration.groupChatId`：唯一绑定群，不能配置第二个群。
- `collaboration.githubRepository`：唯一共享 GitHub 仓库，HTTPS/SSH remote 规范化后比较。
- `collaboration.trustedPeers`：每个 peer 的 Agent、人类和 Bot 身份都必须唯一。
- `collaboration.receiveMode`：接收端自动化上限；发送方不能强迫接收方更自动。
- `collaboration.approverOpenIds`：可选择落点、接单、拒绝与审批结果的人类。
- `collaboration.taskLeaseMs`：本机 `(project.id, branch)` 租约，防止同一分支并发执行。

## 显式命令

自然语言与 Project Skill 是主要入口；命令仅作为显式备用控制面：

```text
/project
/branches
/worktrees
/new [主题]
/chat [主题]
/endchat
/threads [branch]
/use <序号>
/current
/status
/model
/capacity
/team
/team-tasks
/delegate <Agent> <branch> <任务>
/team-options <任务>
/team-accept ...
/team-reject ...
/team-approve ...
/knowledge list
/audit 20
/metrics
/help
```

- `/delegate` 要求命令分支与当前 Codex 任务分支一致，worktree 干净且可安全 push。
- `/team-options` 列出同分支的可继续对话、已有 worktree 新对话和新 worktree 选项。
- `/team-tasks` 只显示任务方向、角色、仓库、分支、提交和状态，不显示完整 prompt。
- `/peer ping` 与 `/peer status` 是不调用模型的仓库绑定控制面。
- `/team-approve` 把“执行完成”和“请求方确认”分开。

### 临时异步 Chat

- `/chat` 或 `/chat 主题` 创建临时 Codex Chat，并记住原任务。
- 临时 Chat 与原任务使用不同执行队列；原任务运行时仍可创建 Chat。
- `/endchat`（别名 `/end`）立即把后续消息路由回原任务，不取消已提交到临时 Chat 的回合。
- 临时 Chat 会留在 Codex 任务列表；返回位置持久化，Bridge 重启后仍可恢复。
- 临时模式中 `/new` 和 `/use` 会要求先 `/endchat`，避免覆盖返回位置。

## Git 与 Project 安全边界

- `/threads` 与 `/use` 验证任务 cwd、真实路径、注册 worktree 与记录分支，不能跳到其他 Project。
- 切换 Codex 任务不会执行 `git checkout`。
- `/new --branch` 使用独立 worktree；受保护默认分支强制 `read-only`。
- 协作发出前要求完整 SHA 与干净 worktree；Bridge 不把脏改动伪装成已同步 Git。
- push 永不使用 `--force`；接收端只接受精确 fetch 与 fast-forward。
- 分叉、脏工作树、范围外 worktree、锁定/游离 HEAD、错误 remote 或默认分支写入都会阻塞。
- 协议不传递本机绝对路径、远端 Project ID 或远端 Codex task ID。
- reset、clean、递归删除、force push、覆盖凭据或权限等难恢复操作不属于自动协作合同。

Bridge Project 与 Codex Desktop Project 是不同对象：前者负责执行和安全，后者只负责 Desktop 目录/任务分组。独立 App Server 的 `thread/start` 不接受 Desktop `projectId`，因此 `/new` 不会自动进入 Desktop Project 分组，但仍按真实 cwd 受 Bridge Project 校验。

## Agent 协议与可靠性

Agent 协议 v2 包含事件/任务标识、唯一群、规范化 GitHub 仓库、发送/接收 Agent、requester/executor、TTL、hop 和有界 payload：

- `task.request`：标题、prompt、接收模式、结果模式与 `{remote, branch, commit}`。
- `task.accepted` / `task.progress`：落点类型与进度，不暴露远端本机路径或对话标识。
- `task.result`：摘要与结果 Git，不返回远端 thread ID。
- `task.blocked` / `task.rejected` / `task.approved`：阻塞、拒绝与请求方确认。

`team-tasks.json` 持久化状态并按事件标识去重。Bot-to-Bot 事件先写入 `pending-agent-events.json`，发送失败后指数退避。Codex 最终回答先写入 `pending-deliveries.json`，网络失败不会重新运行 Codex。

`audit.jsonl` 使用递增序号和 SHA-256 前向哈希链，只记录任务标识、分支、提交和错误码等元数据，不记录 prompt 正文、结果正文、凭据或完整路径。

## 共享 Team Hub

可选 Team Hub 只保存稳定知识，不保存实时任务状态：

```text
<teamHub.path>/projects/<project.id>/
├─ knowledge/<id>.md + <id>.meta.json
├─ summaries/<id>.md + <id>.meta.json
└─ references/<id>.md + <id>.meta.json
```

metadata 保存类别、标题、repository IDs、作者、时间和 SHA-256 revision。更新使用乐观锁，并发或外部修改不会被静默覆盖。每个 Codex 回合按 `knowledge → summaries → references` 注入有界上下文，并明确以当前仓库与运行态的可验证事实为准。Bridge 不自动为 Team Hub commit、pull 或 push。

## 开发验证

```powershell
npm test
node --check .\channel-bridge.mjs
```

测试覆盖配置边界、群路由、协议身份、任务状态机、Skill 收件箱、精确 Git push/fetch/fast-forward、落点选择、审计链、可靠发件箱和 Project/worktree 校验。
