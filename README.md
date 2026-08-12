# Feishu ↔ Codex Project Bridge

这个本地桥接不使用 OpenAI API Key。它复用当前电脑上的 ChatGPT 登录态，通过 Codex CLI 继续本机 Codex 任务，再由飞书 Channel SDK 接收消息和回传结果。

当前版本把一个飞书机器人定义为一个 **Project Agent**：

```text
1 个飞书机器人
└─ 1 个受控 Codex Project
   ├─ 1 个 Git 仓库
   ├─ 多个独立 Git worktree / branch
   └─ 每个 worktree 下多个 Codex 任务（thread）
```

当前执行后端是 Codex。配置保留 `agent.executor.type` 边界，后续可以增加其他 Agent 执行器，但 Project、Git 和飞书权限策略不依赖具体模型后端。

这里的 **Bridge Project** 与 Codex Desktop 侧边栏里的 **Desktop Project** 是两个对象：前者负责仓库、worktree、分支和写入权限边界，后者只负责 Desktop 中的目录与任务分组。Bridge 可以验证本机 Desktop 是否已注册同一仓库，但当前 Codex 独立 App Server 的 `thread/start` 没有 `projectId` 参数，所以 `/new` 创建的任务不会自动进入 Desktop Project 分组；任务仍会按真实 `cwd` 写入本机 Codex 状态并受 Bridge Project 校验。

## Project 安全边界

- `/threads` 只显示 `cwd` 位于当前 Project 已注册 Git worktree 内、且任务记录分支与 worktree 当前分支一致的 Codex 任务。
- `/use` 会再次验证目标任务的 `cwd`、真实路径和分支绑定；不能切换到本机其他项目或已被外部切换分支的旧任务。
- 切换 Codex 任务不会执行 `git checkout`，也不会改变任何 worktree 的分支。
- `/new` 在当前 worktree 创建任务；没有当前任务时使用默认分支所在 worktree。
- `/new --branch <branch>` 创建或复用该分支的独立 worktree，再在其中创建 Codex 任务。
- `project.defaultBranch` 在 `protectDefaultBranch=true` 时强制使用 `read-only` 沙箱；要修改代码必须进入任务分支 worktree。
- 普通任务分支使用 `sandboxMode`。新安装建议使用 `workspace-write`；`danger-full-access` 仅适合明确需要访问 Project 外资源的受信环境。
- bridge 内的写入型消息目前全局串行，因此自然满足“同一 worktree 同时最多一个 bridge 回合”，但这不能阻止用户从桌面端另行并发启动同一目录的任务。
- bridge 不自动 force push、reset、clean、merge 或删除 worktree；`/branches` 也不会自动 fetch。
- 递归删除、覆盖重要数据、重置凭据或权限、强制推送、清空数据库等难以恢复的操作仍需再次确认。

## 安装与配置

需要 Windows、Node.js、已登录的 Codex CLI、飞书 CLI，以及启用了 Channel SDK 的飞书自建应用。

```powershell
npm install
Copy-Item .\bridge.config.example.json .\bridge.config.json
```

核心配置示例：

```json
{
  "schemaVersion": 2,
  "appId": "cli_xxx",
  "threadId": "",
  "workspace": "C:\\CodexBridgeRuntime",
  "agent": {
    "id": "cryouni-frontend-codex",
    "ownerOpenId": "ou_human",
    "botOpenId": "ou_bot",
    "allowedHumanOpenIds": ["ou_human"],
    "executor": { "type": "codex" }
  },
  "project": {
    "id": "cryouni-frontend",
    "name": "CryoUNI Frontend",
    "desktopProjectId": "paste-the-id-reported-by-codex-desktop",
    "desktopProjectName": "CryoUNI Frontend",
    "repoRoot": "G:\\Projects\\CryoUNI\\frontend",
    "worktreeRoot": "G:\\Worktrees\\cryouni-frontend",
    "allowedWorktreeRoots": [
      "G:\\Projects\\CryoUNI\\frontend",
      "G:\\Worktrees\\cryouni-frontend"
    ],
    "defaultBranch": "main",
    "protectDefaultBranch": true,
    "allowedRemotes": ["origin"]
  },
  "sandboxMode": "workspace-write"
}
```

字段含义：

- `workspace`：bridge 日志、去重记录和临时文件的本机运行根目录，不等于代码仓库。
- `project.repoRoot`：必须是 `git rev-parse --show-toplevel` 返回的仓库根目录。
- `project.worktreeRoot`：bridge 新建任务 worktree 的父目录。
- `project.allowedWorktreeRoots`：允许桥接访问的 worktree 路径边界；必须包含 `repoRoot` 和 `worktreeRoot`。
- `project.allowedRemotes`：允许用作新分支基线和显示远端 refs 的远端名称。
- `project.desktopProjectId`：可选；Codex Desktop 为已注册目录生成的 Project ID。配置后 `/project` 会读取 `~/.codex/.codex-global-state.json`，只读验证 ID 与 `repoRoot` 是否匹配。
- `project.desktopProjectName`：可选；Desktop 侧显示名称，仅用于状态回退，真实名称优先从本机 Desktop 状态读取。
- `threadId`：可留空。若填写或从旧选择文件迁移，启动时仍会校验该任务是否属于 Project；不属于时会改选最近的 Project 任务或等待 `/new`。
- `collaboration.enabled`：是否开放配置群中的多 Bot 路由。新安装应先保持 `false`，完成 Bot open_id、群 chat_id 和 Project allowlist 核对后再开启。
- `collaboration.groupChatIds`：可信协作群的精确 `chat_id` allowlist。群消息还必须真实提及本 Bot，`@所有人` 不会触发。
- `collaboration.trustedPeers`：可信 peer Bot 清单。每个启用的 peer 都必须配置唯一的 `agentId`、`botOpenId` 和非空 `allowedProjectIds`；peer 未获当前 `project.id` 授权时会被拒绝。
- `collaboration.autoAcceptPeerTasks` 当前保持 `false`；步骤 3 只开放 `/peer ping|status` 控制面，普通 peer 文本绝不会进入 Codex。

真实 `bridge.config.json` 已被 `.gitignore` 排除。

随后运行 `setup-channel-secret.ps1`，隐藏输入 App Secret。脚本使用 Windows DPAPI 加密保存；明文不会写入配置、日志或仓库，启动器只在内存中解密并传给 Channel SDK 子进程。

## 启动与停止

```powershell
& .\start-bridge.ps1
& .\status-bridge.ps1
& .\stop-bridge.ps1
```

运行日志、投递发件箱和去重状态位于 `<workspace>\work\feishu-codex-bridge`。

## 飞书命令

```text
/project
/branches
/worktrees
/threads
/threads branch task/LOGIN-123
/use 2
/current
/new 修复登录问题
/new --branch task/LOGIN-123 修复登录问题
/status
/model
/capacity
/team
/help
```

### Project 与 Git

- `/project`：分别显示 Bridge Project 的执行边界和 Codex Desktop Project 的只读注册状态，避免把二者混为一个对象。
- `/branches`：列出本地分支与允许远端中的本地 refs 快照，并标出哪个分支已有 worktree。该命令不联网、不 fetch。
- `/worktrees`：列出允许范围内的 Git worktree、HEAD、分支和其中的 Codex 任务数；范围外 worktree 只显示数量，不允许访问。

### Codex 任务

- `/threads`：只列出当前 Project 最近 20 个任务。
- `/threads branch <branch>`：按 worktree 当前真实分支过滤，而不是只信任任务数据库里可能过期的 `git_branch` 字段。
- `/use 2`：切换到最近一次 `/threads` 返回列表中的第 2 项；列表缓存 30 分钟。完整任务 ID 同样必须通过 Project 校验。
- `/new <主题>`：通过 Codex App Server 在当前 worktree 中创建并命名空白任务，不启动模型回合、不消耗 token；若当前是受保护默认分支，新任务只能读和分析。
- 当前 Desktop 版本不会自动把独立 App Server 创建的任务归入 Desktop Project；`/new` 的回复会明确提示这一点。这不影响 `/threads`、`/use` 或 cwd/worktree 安全校验。
- `/new --branch <branch> <主题>`：若分支已有允许范围内 worktree，则复用；否则在 `worktreeRoot` 下创建新 worktree。新本地分支优先基于同名允许远端分支，其次基于 `<allowedRemote>/<defaultBranch>`，最后基于本地默认分支。
- `/current`：显示当前任务、Project、worktree、分支、实际沙箱、模型与容量摘要。

### 本地状态查询

- `/status`：查看 Channel 连接、Project、当前分支、实际沙箱、运行阶段、队列和待补发结果。
- `/model`：读取本机 Codex 状态数据库中的模型、推理强度、提供方和 CLI 版本。
- `/capacity`（别名 `/quota`）：读取当前任务 rollout 中最新的 token 与账户周期快照。
- `/team`：显示本地 Agent/Bot、可信群、可调用成员、peer Bot 及其 Project allowlist；不会调用 Codex。

这些查询不启动 Codex，不产生模型 token。

## 长任务与投递可靠性

- 普通消息使用飞书动态卡片展示 Codex 主动写给用户的公开过程说明，以及经过脱敏的活动事件；不会传输隐藏思维链、完整命令或敏感路径。
- 前 8 分钟使用飞书原生流式卡片，之后更新同一条普通卡片；每 30 秒刷新耗时心跳。
- bridge 增量读取本地 rollout。发现稳定完成后，即使 Windows 上的 `codex exec resume` 未退出，也会回收最终答案并结束残留辅助进程。
- 最终答案在飞书投递前写入 `pending-deliveries.json`。网络失败会按指数退避补发，使用稳定幂等键，不会重新运行 Codex。
- 最近 1000 条已完成飞书消息 ID 会持久化，避免重复执行。

## 多 Bot 群路由

启用 `collaboration.enabled` 后，每个成员仍由自己的 Bot 和本机 Codex 服务。Bridge 对群消息按以下顺序 fail closed：

1. 群 `chat_id` 必须在 `groupChatIds` 中，并且消息真实提及当前 Bot；`@所有人` 不触发。
2. 人类发送者必须位于当前 Bot 的 `agent.allowedHumanOpenIds` 中。这样同一个群里的不同成员只调用被分配给自己的 Bot。
3. Bot 发送者必须以飞书事件中的真实 open_id 命中 `trustedPeers`，不能是本 Bot，也不能是未知或已禁用 Bot。
4. peer 的 `allowedProjectIds` 必须包含当前 `project.id`，否则即使 Bot 身份可信也不能跨 Project 调用。
5. SDK loop guard 会限制短时间内的 Bot 提及；Bridge 的控制面回复不包含 Bot mention，因此不会形成回复回声。

本阶段 peer 只能发送 `/peer ping <projectId> [requestId]` 或 `/peer status <projectId> [requestId]`。响应是确定性的本地状态，不调用模型、不写仓库，也不自动接单。后续 Agent 任务协议会在此身份和 Project 路由边界之上增加 TTL、事件去重、人工接单和任务状态机。
