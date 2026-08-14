# Feishu ↔ Codex Bridge

这个 Windows 本地桥接不使用 OpenAI API Key。它复用当前电脑的 ChatGPT/Codex 登录态，通过飞书 Channel SDK 把成员消息送入本机 Codex，并把结果发回飞书。

> **v0.3.1-beta.1 / Codex 专用测试版**：当前正式支持的产品入口是 Windows 上的个人 Session Relay。它依赖 Codex App Server 的实验性 WebSocket 接口；保留的 Project Agent/多人协作代码不是本次发布合同。

## 安装

- 人工安装：[Windows 完整安装指南](docs/INSTALL.md)
- 飞书控制台：[自建应用、权限、事件、发布与 OAuth](docs/FEISHU_APP_SETUP.md)
- 交给 Codex 安装：[安装 Agent Prompt](docs/INSTALL_AGENT_PROMPT.md)

最短用法：

```text
请按照 https://github.com/ninmon/feishu-codex-bridge/releases/tag/v0.3.1-beta.1 帮我安装部署这个应用。
```

仓库根目录 `AGENTS.md` 会把安装代理引导到可验证的 `docs/INSTALL_AGENT.md` 流程，并在飞书应用发布、OAuth、App Secret 安全输入和 Codex Desktop 完整重启等人工节点停下来。安装脚本会固定依赖版本、生成本机配置、安装 `$feishu-session-bind` Skill，并用 `doctor.ps1` 验证结果。

已有 `v0.2.0-beta.1` 或更高版本安装后，升级到指定 release 只需运行 `update.ps1 -Version <tag>`。升级器拒绝脏工作树和未知远端，升级前会在本机运行目录备份配置、DPAPI 密文、Session 设置、队列和投递状态；安装或健康检查失败时自动切回原提交并恢复状态。`v0.1.0-beta.1` 首次迁移到内置升级器的引导命令见 [Windows 完整安装指南](docs/INSTALL.md#更新)。

## 当前产品形态：个人 Session Relay

推荐模式是 `mode=session-relay`。一个飞书群绑定一个本机 Codex 任务（Session），任务可以属于任意 Codex Project，也可以不属于 Project：

```text
飞书群 A（仅 owner + 当前 Bot） ──固定绑定──> Codex Session A
飞书群 B（仅 owner + 当前 Bot） ──固定绑定──> Codex Session B
```

同一个飞书应用 Bot 可以加入多个群；Bridge 永远按不可变的 `chat_id` 查找绑定，不靠群名猜测目标。每个 `chat_id` 和 `threadId` 在一份配置中都必须唯一。

Session Relay 的行为合同：

- owner 在绑定群里发送普通文本，无需 `@Bot`；文本去除真实 Bot mention 后原样作为该 Session 的 prompt。
- 不提供 `/use`、`/new` 或全局“当前任务”切换。Bridge 只拦截下文列出的 Session 控制命令和 `/add`、`/cancel`、`/delete` 绑定管理命令；其他内容（包括未知的 `/xxx`）仍原样作为普通 prompt。
- 每个 Session 的普通消息方式可在 `steer` 与 `queue` 之间选择；**新安装默认 `queue`**。`queue` 会在空闲时立即开始独立新 Turn，忙碌时进入持久 FIFO，等待当前 Turn 和原生 Goal 结束。切换为 `steer` 后，活动 turn 中的新消息会使用控制器已订阅到的 `activeTurnId`，直接调用 App Server 原生 `turn/steer` 成为“调整方向”；若与上一轮完成恰好竞态，Bridge 只有确认已 idle 后才新建 turn，并在飞书明确提示边界变化。
- 使用 `/queue <Prompt>` 可显式绕过 `turn/steer`：消息写入每个 Session 独立的本机持久 FIFO，当前任务恢复 idle 且原生 Goal 不再运行后，才用原飞书消息 ID 启动一个独立的新 turn。多条队列不合并；Bridge/共享 App Server 断线或重启后仍会恢复，并以 client ID 对账避免重复启动。若 Codex Desktop 抢先开始新 turn，排队项继续等待，不会误变成调整方向。
- Bridge 始终同步绑定任务的所有 Codex 最终答案；**新安装默认开启公开进度与最终回答 @提醒**。Bridge 只实时转发 App Server 明确标记为 `agentMessage.phase=commentary` 的公开阶段说明，每个 Turn 按 `Codex 公开进度 #1/#2…` 编号，卡片底部只显示时间戳，且公开进度始终不 @。隐藏思维链、`reasoning`/raw reasoning、工具原始输出始终禁止转发；可用 `/settings progress off` 关闭公开进度，用 `/settings mention off` 关闭当前 Session 的最终回答 @提醒。断线期间的公开进度不补发，最终答案仍走持久发件箱。一个 App Server turn 是唯一的最终回复与幂等边界，初始 Prompt 和后续任意多次调整都按 App Server 接受顺序组成输入事件流。只要该 turn 含有飞书输入，最终答案就回复其中最后一条飞书消息；完全没有飞书输入时，Bot 才在绑定群主动新发富文本。两种最终回复底部都显示回答完成时间、整轮用时和本轮真实 Token；本轮 Token 由 App Server 的会话累计 usage 差值计算，覆盖一次 turn 内的多次模型调用。断线补发缺少 usage 快照时明确显示“暂不可用”，不做文本长度估算。
- 跨客户端调整是对称的：飞书开始后可从 Codex 调整，Codex 开始后也可从飞书调整；多端交替输入不会拆分、合并或覆盖事件。含多条输入的飞书富文本按“初始 Prompt · 飞书/Codex”“调整方向 N · 飞书/Codex”展示完整时间线。单条飞书 Prompt 仍使用紧凑回复。Bridge 在线收到调整事件时会显示每次调整时间；断线重连后的 App Server 快照不含单条调整时间，因此只保留可确认的初始发送时间。
- Desktop 主动同步使用飞书 `post` 的 `md` 元素：两个分区标题以 Markdown heading 显示，Prompt 与最终回答放入 blockquote，并用分割线区隔。飞书控制最终字体，Bridge 不指定自定义字体族。
- Codex Prompt 中的本地图片不会显示文件名或本机绝对路径，而是直接上传为同一条富文本内的图片；多张图片按输入顺序逐张显示。其他附件/音频仍会在 Prompt 引用块中显示类型和文件名。Codex Desktop 自动注入的 `Files mentioned by the user` / `My request` 包装不会显示在飞书中。图片上传失败时仍发送文本摘要和最终回答。
- Codex 最终回答中的本地图片与文件链接不会把本机绝对路径发到群里。图片不超过 10 MB 时继续内嵌；超过图片上限、内嵌上传失败或属于其他本地附件时，只要文件不超过 30 MB，就在最终回答之后按原顺序发送为群内原生附件。`::visualize` 指向的本地 HTML 也作为附件发送。最终回答与附件共同进入持久发件箱，附件不额外 @owner，失败重试不会重新运行 Codex；超过飞书 30 MB 文件上限时只给出明确提示，原文件仍保留在 Codex 任务中。
- Bridge 通过 App Server `userMessage.clientId` 区分来源：由飞书提交的每条消息都使用原始 `om_...` 消息 ID，其余原生客户端在第一阶段统一显示为“Codex”，不展示内部 client ID。所有最终答案使用 `threadId + turnId` 的确定性投递 ID，因此混合来源或多次调整也只会投递一次。Bridge 启动时不补发历史答案；若启动时任务正处于运行中，会接管该活动 turn，监听断线重连后也会补齐断线期间刚完成的 turn。
- 所有最终答案先进入持久发件箱，再用确定性消息 UUID 回复或主动发送；飞书发送失败不会重新执行 Codex。主动发送前仍会重新核验群内严格只有绑定 owner 和当前 Bot，避免成员变化后泄漏任务内容。
- 入站 Prompt 先由不可变的 `chat_id` 与精确 owner `sender_id` 鉴权，因此不为每次 steer 增加群成员网络往返；静态“调整方向已加入”确认也不含任务内容。任何最终回答、命令结果等可能携带任务信息的出站消息，仍会在发送前用 Bot 身份重新读取群成员，必须严格等于“绑定 owner 一人 + 当前 Bot 一个”。加入第三个人、第三方 Bot、Session 被归档或成员无法完整核验时，敏感出站内容全部 fail closed。
- `nameSync=none` 是默认值：绑定只认不可变的 `chat_id ↔ threadId`，群名仅作为展示名称，Bridge 不会修改 Codex 任务名。新群仍按 `{Project名}/{Session名}` 或 `独立/{Session名}` 命名。旧部署如确实需要“群名反写任务名”，可显式选择 `group-to-session`；`require-match` 仅保留给群名与任务名完全相同的旧绑定。
- Session Relay 与 Codex Desktop 必须连接同一个本机 App Server。独立 App Server 进程对任务实行单 writer 锁，两个进程不能分别接续同一任务；共享 `ws://127.0.0.1:<port>/rpc` 后可由多个客户端安全排队访问。

### 群内 Session 控制命令

这些命令由 Bridge 直接调用原生 App Server 接口，不会作为 prompt 送给模型：

- `/status`：查看连接、idle/active 状态、当前 Turn、等待标志、模型、推理强度、速度、Plan 模式、Token 与 Goal 摘要。
- `/stop`：按精确活动 Turn ID 调用 `turn/interrupt`。若原生 Goal 正在运行，会先暂停 Goal 再中止当前 turn，防止自动续跑。
- `/queue <Prompt>`：将 Prompt 作为独立新 Turn 排队；`/queue` 查看，`/queue remove <序号>` 删除一条，`/queue clear` 清空待执行项。Prompt 恰好以 `status`、`clear` 或 `remove` 开头时，可写成 `/queue -- <Prompt>`。`/stop` 只中止当前 Turn，保留的队列会继续执行。
- `/settings`：查看该 Session 的 Bridge 偏好；`/settings input steer|queue` 设置普通消息默认行为，`/settings progress on|off` 设置是否回传公开阶段说明，`/settings mention on|off` 设置最终回答是否 @owner，`/settings reset` 复制当前“新绑定默认设置”。兼容 `/settings thinking on|off` 输入，但界面会明确显示为“公开进度（非隐藏思维链）”。设置按 Codex `threadId` 本机持久化并立即生效。
- `/model`：动态列出当前账号实际可用的模型、推理强度和速度；支持 `/model <编号或模型>`、`/model effort <强度>`、`/model speed standard|fast`、`/model reset`。Bridge 不硬编码模型目录，也不会把不受当前模型支持的组合写入任务。
- `/plan`、`/plan on`、`/plan off`：查看或切换 App Server 原生 Plan collaboration mode。Plan 与 Goal 是独立轴；活动 Goal 必须先暂停才能进入 Plan。
- `/goal`：查看原生 Goal；支持 `/goal start <目标>`、`pause`、`resume`、`replace <目标>`、`budget <tokens|none>` 与 `clear`。Goal 自动续跑产生的每轮最终结果会以“Goal 进展”富文本发回群，完成后显示“Goal 已完成”。
- `/delete`：预览解除当前群与 Session 的固定绑定；5 分钟内发送 `/delete confirm` 才会执行，`/delete cancel` 取消。解除时同步移除 Agent 标签并自动重载 Bridge，但不会删除飞书群，也不会删除或归档 Codex 任务。任务仍在回答、运行 Goal 或存在待执行队列时会拒绝解除；队列需先用 `/queue remove <序号>` 或 `/queue clear` 处理。

`/model` 和 `/plan` 修改的是该 Codex 任务的后续 turn 设置；若当前回答正在运行，当前轮不会被偷偷改写。`/settings` 修改的是 Bridge 对该 Session 的本机路由和显示偏好。`/add`、`/cancel` 与 `/delete` 属于绑定管理命令；只有这些和上述精确 Session 命令名会被 Bridge 拦截，例如 `/review this change` 仍会作为普通消息，按当前 `steer|queue` 设置交给 Codex。

### 新绑定群的全局默认设置

在与 CLI Bot 的**私聊**中发送 `/settings`，操作的是后续新绑定的默认值；命令为 `/settings input steer|queue`、`/settings progress on|off`、`/settings mention on|off` 和 `/settings reset`。每次成功创建绑定时，Bridge 会把当时的全局默认复制为该 Codex Session 的独立设置：

- 新安装的内置默认值是 `queue + 公开进度开启 + 最终回答 @提醒开启`。
- 后续修改全局默认不会改变任何已有绑定群。
- 群内 `/settings` 只修改当前 Session；群内 `/settings reset` 会复制当时的全局默认。
- 旧部署中尚无 Session 设置记录的已有群继续保持安全默认 `steer + 公开进度关闭`，不会因升级被全局值改写。

### 创建并绑定新的 Session 群

向 Bot 私聊发送 `/add`（也可以在任一现有绑定群中发送），Bridge 会启动一个 15 分钟有效的编号向导：

1. 选择 Codex Desktop 的原生 Project，或选择 **独立**。
2. Project 下只列出当前确实归属于该 Desktop Project 的未归档任务；独立下只列出 Desktop 标记为 projectless 的任务。Bridge 不按 cwd 猜测 Project，也不修改 `.codex-global-state.json`。
3. 选择已有任务。选择独立时还可选“新建独立任务”，依次输入任务名和本机已存在的绝对工作目录。
4. Bridge 自动创建私有群、核验群内严格只有 owner 和当前 Bot、应用 Agent 标签、复制当时的新绑定默认设置、写入固定绑定并发送欢迎消息，随后自动重载。

可随时发送 `/cancel` 取消。任务已绑定时不会重复建群；列表会标出“已绑定”。新群名称为 `{Project名}/{Session名}`，独立任务使用 `独立/{Session名}`。名称组件中的 `/` 会被安全替换，整体按飞书 60 字符上限截断。

自动创建采用严格顺序：先确认 Agent 标签可用，再创建群；只有成员/Bot 校验和标签写入都成功后，才把 `chat_id ↔ threadId` 持久化到本机配置。如果群已经创建但后续校验或标签接口失败，该群不会被 Bridge 当成可用绑定，错误会在发起 `/add` 的会话中明确显示。

也可以直接在目标 Codex 任务里调用全局 Skill `$feishu-session-bind`，或自然语言说“帮我绑定当前 Session 到飞书群”。Skill 使用当前任务的 `CODEX_THREAD_ID` 写入本机 Bridge 收件箱，并复用与 `/add` 完全相同的建群、校验、标签和绑定入口；不会接收手填任务 ID，也不会读取或输出 App Secret。

最小配置如下；`bridge.config.json` 是本机文件并已被 Git 忽略：

```json
{
  "schemaVersion": 4,
  "mode": "session-relay",
  "appId": "cli_xxx",
  "workspace": "C:\\CodexBridgeRuntime",
  "agent": {
    "ownerOpenId": "ou_owner"
  },
  "sessionRelay": {
    "nameSync": "none",
    "appServerUrl": "ws://127.0.0.1:47321/rpc",
    "displayTimeZone": "Asia/Shanghai",
    "promptPreviewChars": 4000,
    "feedGroup": {
      "enabled": true,
      "agentName": "Codex"
    },
    "bindings": []
  },
  "nodeExecutable": "C:\\Program Files\\nodejs\\node.exe",
  "larkCliEntry": ".\\node_modules\\@larksuite\\cli\\scripts\\run.js",
  "codexExecutable": "C:\\path\\to\\codex.exe",
  "sandboxMode": "workspace-write"
}
```

`bindings: []` 是合法的首次启动状态；此时所有未绑定群均被拒绝，但 owner 仍可通过 Bot 私聊发送 `/add` 完成第一个绑定。

`sessionRelay.feedGroup.enabled=true` 时，Bridge 会使用当前 Windows 主机名和
`agentName` 生成个人飞书标签，例如 `DESKTOP-V4BD0R3-Codex`。Bridge 只会把已经通过
Session Relay 群成员与 Bot 安全校验的绑定群加入该标签；`/add` 和 `$feishu-session-bind`
都复用同一个标签入口。已有绑定群的后台标签重试失败不会中断消息桥接；新建群则必须先成功
应用标签，才会写入绑定。

Feed 标签是当前授权用户侧的会话分组，不是全体群成员共享的群属性。接口只能使用
`user_access_token`，因此除了在开发者后台发布 `im:feed_group_v1:read` 与
`im:feed_group_v1:write`，当前用户还必须通过同一飞书应用重新执行增量 OAuth 授权。

首次启用共享 App Server：

1. 运行 `start-bridge.ps1`；它会先暂停旧 pointer，通过独立的 `start-app-server.ps1` 启动或复用经过 PID、可执行文件和回环端口校验的 Codex App Server，再启动隐藏的 Bridge supervisor。Bridge 确认连接后才恢复 pointer。
2. Bridge 显示 connected 后运行 `configure-codex-desktop-relay.ps1`。脚本会再次验证 App Server，安装并立即启动当前用户的连续 watchdog，再把同一回环地址写入 `CODEX_APP_SERVER_WS_URL`；只有 watchdog 的 ready heartbeat 到达后才算激活成功。前置步骤失败时会撤销 pointer，让 Desktop 保持 fail-open。
3. 运行 `doctor.ps1 -RequireRunning -RequireDesktopRelay`，确认 Desktop relay pointer、连续 watchdog、新鲜 heartbeat、共享监听器所有权和 Bridge 全部通过。
4. 完全退出并重新打开 Codex Desktop。环境变量只在新进程中生效；正在运行的 Desktop 不会被热切换。
5. 若要撤销，运行 `configure-codex-desktop-relay.ps1 -Disable`，再完全重启 Codex Desktop。撤销会先阻止 watchdog 回写并移除 Desktop 依赖，再移除官方任务；任何自建守护都不会被脚本删除。

共享服务只监听 loopback；配置加载器拒绝非本机 WebSocket 地址。停止 Bridge 时会移除 Desktop relay pointer，并把连续 watchdog 切换为 paused；watchdog 不再恢复 App Server 或 Bridge。为避免中断仍在运行的 Desktop，停止 Bridge 不会立即终止共享 App Server；完整退出并重开 Desktop 后会回到自身 App Server。官方任务 `FeishuCodexBridge-DesktopRelay-Watchdog` 不依赖飞书 App Secret：Bridge 运行时它每 3 秒检查监听器；监听器消失时先移除 Bridge 自己的 Desktop relay pointer，再尝试恢复 App Server，只有 PID、可执行文件、命令行和端口重新验证后才恢复 pointer。稳定 bootstrap 只会清理由本地 activation state 精确记录的 URL，不会删除其他软件的 loopback pointer。激活时若发现可能的自建守护进程、计划任务或服务，只记录兼容提示并保留它们；官方 watchdog 会复用已经通过验证的同一 App Server，用户可在严格 Doctor 通过后自行决定是否撤销旧守护。日志和 heartbeat 保存在 `%LOCALAPPDATA%\FeishuCodexBridge\bootstrap`。

Bridge supervisor 是 `/add`、`/delete` 后自动重载的进程边界：Bridge 先确认 supervisor PID 仍存活，再写入 `restart.request` 并优雅退出；supervisor 等旧进程完全结束后才启动替代进程。若 supervisor 不可用，Bridge 会拒绝自停并保留现有群的服务，避免一次新增绑定使所有旧群同时离线。`status-bridge.ps1` 会同时显示 Bridge、supervisor 和共享 App Server 状态；正常停止使用 `stop-bridge.ps1`，不要直接结束其中任一进程。正常停止或 supervisor 最终退出时会自动暂停 watchdog 并移除 pointer。

为了实现“群里不 @ 也能收到”，飞书应用必须订阅 `im.message.receive_v1`，并申请、发布敏感权限 `im:message.group_msg`。安全门禁还需要 `im:chat:readonly` 与 `im:chat.members:read`；自动建群还需要 Bot 权限 `im:chat:create`，现有 Bot 回复权限也必须保留。只有 `im:message.group_at_msg` 时，平台不会把普通未 @ 消息投递给 Bridge，这与群里是否只有两名成员无关。Bot 私聊 `/add` 还需要应用能够接收用户发给 Bot 的单聊消息事件。

仓库仍保留 `mode=project-agent` 的 Project/worktree/多 Bot 协作实现，便于以后继续演进；两种入口互不共享“当前 Session”。下文的 Project 与多用户章节描述的是该保留模式。

## Project Agent 协作模型（保留模式）

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

## 保留模式：手工安装与配置

以下内容仅用于继续开发尚未发布的 Project Agent/多人协作模式。安装当前 Codex Session Relay Beta 请使用文首安装指南和 `install.ps1`。

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
/new
/new 项目规划
/chat
/chat 临时问题
/endchat
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

### 临时异步 Chat

- `/chat` 或 `/chat 主题`：创建临时 Codex Chat，并记住当前原任务。
- 临时 Chat 与原任务使用不同的执行队列，因此原任务正在运行时也可以创建 Chat、继续提问；同一个任务中的多条消息仍按顺序处理。
- `/endchat`（别名 `/end`）：立即把后续消息路由回原任务及其完整历史，不会取消已经提交到临时 Chat 的回合；这些回合完成后仍会更新自己的飞书卡片。
- 临时 Chat 会保留在 Codex 任务列表中，但 `/new` 和 `/use` 在临时模式中会要求先执行 `/endchat`，避免意外覆盖返回位置。
- 临时 Chat 的返回位置会持久化；桥接重启后仍可使用 `/endchat` 回到原任务。

`/threads` 仍只列出当前 Bridge Project 内通过 cwd/worktree 校验的 Codex 任务；`/use 2` 会把后续飞书消息切换到列表中的第 2 个任务。切换后，Codex 会继续该任务已有的完整聊天历史。

### Agent 协议

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
