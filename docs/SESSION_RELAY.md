# Session Relay 参考

本文描述当前正式支持的 Session Relay：一个飞书群固定绑定一个本机 Codex Session。默认仍是单用户；Owner 可选择在同一台 Bridge 上登记其他飞书用户，为每人划定独立 Project 目录，并通过群成员关系共享某个 Session。安装步骤见 [INSTALL.md](INSTALL.md)，飞书权限见 [FEISHU_APP_SETUP.md](FEISHU_APP_SETUP.md)。

> 当前 `main` 包含固定版 `v0.3.1-beta.1` 之后合并的 Bridge pointer 生命周期、单张持久流式卡片、长回答云文档和完整媒体转发。标有“当前 `main`”的行为在下一个固定 tag 发布前不属于 `v0.3.1-beta.1` 的发布保证。

## 绑定模型

```text
飞书群 A（Session owner + 已启用成员 + 当前 Bot） ──固定绑定──> Codex Session A
飞书群 B（Session owner + 已启用成员 + 当前 Bot） ──固定绑定──> Codex Session B
```

- 同一个飞书应用 Bot 可以加入多个绑定群。
- Bridge 按不可变的 `chat_id` 查找绑定，不依赖群名猜测目标。
- 每个 `chat_id` 与 `threadId` 在同一份配置中都必须唯一。
- 每个 Session 只有一个 owner 和一个规范绑定群；不能为同一 Session 重复建群。
- 把另一名已启用 Bridge 用户加入绑定群即共享该 Session；移出群即撤销。共享不授予对方 Project 列表或目录访问权。
- `nameSync=none` 是默认值：群名仅用于展示，不会反写 Codex Session 名称。
- Session 可以属于任意 Codex Desktop Project，也可以是 projectless 的“独立”任务。Bridge 不按 cwd 猜测 Project，也不修改 `.codex-global-state.json`。

## 消息如何进入 Session

群内只有一名人类用户时，可直接发送文本、图片或附件，无需 `@Bot`。有两名或更多人类用户时，只有 `@Bot`、回复 Bot 的消息和 Bridge 斜杠命令会进入 Session；其他消息按普通群聊忽略。Bridge 去除真实 Bot mention 和飞书内部资源 key 后，把内容作为该 Session 的输入：

- 图片使用 App Server 原生 `localImage` 输入，可与同一条富文本中的说明一起发送；
- PDF、Office 文档、压缩包、音视频和其他普通文件先流式下载到 Bridge 受控缓存，再按 Codex Desktop 自身持久化文件 Prompt 的格式加入输入：`Files mentioned by the user`、安全文件名、受控缓存绝对路径和 `My request for Codex`。模型因此可以直接读取原文件，Desktop 可按原生文件消息呈现；
- 纯普通文件消息不会立即启动 Codex，而是成为“当前 Session + 当前发送者”的附件草稿；不同协作者的暂存附件不会混合。可以连续上传多个文件，发送者的第一条普通文字 Prompt 会原子地取走自己的全部草稿附件并提交一次；
- 已有附件草稿时，后续纯图片消息也加入同一草稿；没有草稿时，单独图片仍按原行为立即成为 Prompt；同一条富文本中的文字和图片仍立即一起提交；
- `/status`、`/model` 等 Bridge 命令不会消费草稿；`/queue <Prompt>` 会取走草稿并显式排入独立新 Turn；
- 草稿、排队记录和附件元数据都会持久保存，Bridge 重启后不会丢失或退化成空 Prompt；同一 Session 的入站消息串行处理，避免连续上传与首条文字发生竞态；
- 默认限制为单文件 30 MiB，单条消息或整份草稿最多 10 个资源、总计 60 MiB；缓存默认保留 7 天且最多占用 1 GiB，可通过 `sessionRelay.inboundAttachments` 调整；
- 最终 Prompt 回显只显示图片或安全附件名，不显示飞书资源 key 与本机绝对路径。

稳定版 App Server 的通用 Turn 输入只有 `text`、`image` 和 `localImage`；实验 schema 中的 `mention` 用于 `app://` 应用调用，不是普通本地文件。Bridge 因此不会把普通文件作为裸 `mention` 发送，也不会再生成 `<feishu_bridge_local_attachments>`。旧 XML 解析仅为兼容已存在的历史 Turn。

每个 Session 可独立选择普通消息模式：

- `queue`：新安装默认。Session 空闲时立即开始独立新 Turn；忙碌或原生 Goal 运行时写入持久 FIFO，等 Session 再次空闲后执行。
- `steer`：有活动 Turn 时调用 App Server 原生 `turn/steer`，把消息作为“调整方向”；只有确认 Session 已 idle 后才新建 Turn。

`/queue <Prompt>` 总是显式创建独立新 Turn，不受当前普通消息模式影响。多条队列不会合并；Bridge 或共享 App Server 重启后仍会恢复，并通过原飞书消息 ID 对账，避免重复启动。

多人群的普通 Prompt 固定按 `queue` 处理，避免不同成员的自然语言互相插入当前回答。需要调整活动回答时使用 `/steer <调整方向>`；只有 Session owner 或当前 Turn 的初始发起者可以执行。这个发起者身份会写入输入账本，Bridge 重启后仍可恢复授权。

Session Relay 不提供 `/new`、`/use` 或全局长期任务切换。每个群的长期绑定保持不变，但 `/chat [首条 Prompt]` 可以在当前群或 Bot 私聊中创建独立临时 Session；`/endchat` 结束后，群内返回原绑定 Session。除了精确识别的 Session、临时 Chat 与绑定管理命令，其他文本（包括未知的 `/xxx`）都按当前 `queue|steer` 设置交给 Codex。

## 临时 Chat 与 Bot 私聊

- `/chat`：创建一个临时 Codex Session；创建完成后，普通消息持续进入该 Session。
- `/chat <Prompt>`：创建临时 Session，并把后面的正文直接作为第一条 Prompt，不把它当作任务标题。
- `/endchat`：结束当前临时上下文。绑定群恢复原 Session；Bot 私聊等待下一次 `/chat`。
- 绑定群中的临时 Chat 继承原 Session 的 cwd；Bot 私聊使用 Bridge 启动时的 Codex 工作目录。
- 临时 Chat 状态持久化。Bridge 重启后仍能继续；`/endchat` 不取消已经提交的 Turn，其最终结果仍投递到原飞书会话。
- Bot 私聊接受所有已启用 Bridge 用户；普通成员可用 `/add` 管理自己目录内的 Session。临时 `/chat` 与全局默认设置仍仅限 Bridge Owner；私聊最终回答不发送多余的提醒。

## 跨客户端同步

- 飞书发起的 Turn 可以继续从 Codex Desktop 调整。
- Codex Desktop 发起的 Turn 也可以从飞书调整。
- 多端交替输入按 App Server 接受顺序形成一个输入事件流，不拆分、合并或覆盖。
- 一个 App Server Turn 是唯一的最终回答与幂等边界。
- 只要该 Turn 含飞书输入，最终答案回复其中最后一条飞书消息；完全没有飞书输入时，Bot 才在绑定群主动发送新消息。
- Bridge 启动时不补发历史答案。启动时若绑定 Session 正在运行，则接管活动 Turn；重连后会补齐断线期间刚完成的 Turn。

## 公开进度与最终回答

Bridge 只实时转发 App Server 明确标记为 `agentMessage.phase=commentary` 的公开阶段说明。以下内容始终不会发送到飞书：

- 隐藏思维链；
- `reasoning` 或 raw reasoning；
- 工具原始输出；
- 完整命令和敏感本机路径。

新安装默认开启公开进度与最终回答提醒。公开进度始终不 `@`；最终回答默认 `@` 本 Turn 的初始发起者，完全由 Desktop 发起时回退到 Session owner。提醒可由 Session owner 通过 `/settings mention off` 关闭。

当前 `main` 中，一个 Turn 只创建一张可更新卡片：

1. commentary 到达时，在原卡片追加公开进度并刷新“已处理”时长；
2. Turn 完成后，最终答案原位替换进度；
3. 卡片底部显示回答完成时间、整轮用时和本轮真实 Token；
4. 完整最终答案再作为最新消息持久投递，避免原地更新的卡片停留在聊天上方；需要提醒时，该最终消息 `@` 初始发起者；
5. 卡片更新失败时，仍使用同一套持久最终投递。

本轮 Token 使用 App Server 会话累计 usage 的差值计算，覆盖同一 Turn 中的多次模型调用。断线补发缺少 usage 快照时会显示“暂不可用”，不会按文本长度估算。

## 长回答、图片与附件输出

固定版 `v0.3.1-beta.1` 已支持本地图片与原生附件。当前 `main` 进一步统一了长回答和媒体投递：

- 最终文字超过 `maxReplyChars` 时，把去除本机路径和渲染器元数据后的完整 Markdown 写入当前用户的飞书云文档，并在原回复中发送链接。
- 文档创建结果按 `threadId + turnId` 持久化；重试复用已有文档，不重复创建。
- 文档创建失败时自动退回普通文本投递。
- 本地图片不超过 10 MiB 时内嵌；超过内嵌上限但不超过 30 MiB 时降级为原生附件。
- 视频和其他本地文件不超过 30 MiB 时，在最终回答后按原顺序发送为原生附件。
- `::visualize` 指向的本地 HTML 也作为附件发送。
- 生产路径不限制媒体条目数；重复路径只投递一次。
- 超限、空文件、符号链接或排队后发生变化的文件不会上传，原文件仍保留在 Codex Session 中。
- 飞书消息不会包含本机绝对路径；附件消息也不会额外 `@` 任何人。

文档能力需要 Bridge 当前 OAuth 用户的 `docx:document:create` 与 `docx:document:write_only`。把 Codex 媒体上传回飞书需要应用权限 `im:resource`；下载已授权群成员的消息资源由现有 `im:message` 权限覆盖。

## Session 命令

### `/status`

查看 Bridge 连接、Session idle/active 状态、当前 Turn、等待标志、队列、待提交附件、模型、推理强度、速度、Plan、Token 和 Goal 摘要。命令只读取本机状态，不调用模型，也不会消费暂存附件。

### `/stop`

按当前精确活动 Turn 调用 `turn/interrupt`。若原生 Goal 正在运行，会先暂停 Goal，再中止当前 Turn，防止自动续跑。已有 `/queue` 项目保持不变。

### `/steer`

```text
/steer <调整方向>
```

显式调用原生 `turn/steer`；当前没有活动 Turn 时会开始一个新 Turn。在共享群中，只有 Session owner 或当前 Turn 的初始发起者可以调整/中止该 Turn。

### `/queue`

```text
/queue
/queue <Prompt>
/queue -- <Prompt>
/queue remove <序号>
/queue clear
```

- `/queue`：查看待执行项。
- `/queue <Prompt>`：排入独立新 Turn。
- Prompt 恰好以 `status`、`clear` 或 `remove` 开头时，使用 `/queue -- <Prompt>`。
- `/queue remove <序号>`：删除一条。
- `/queue clear`：清空所有待执行项，不中止当前 Turn。

若当前 Session 有暂存附件，`/queue <Prompt>` 会把这些附件和该 Prompt 一起排入同一个独立新 Turn；单独的 `/queue`、`remove` 或 `clear` 不消费附件草稿。

### `/attachments`

```text
/attachments
/attachments clear
```

- `/attachments`：查看当前 Session 已暂存的附件数量和安全文件名。
- `/attachments clear`：放弃尚未提交的全部附件，不影响正在运行的 Turn 或已有 Prompt 队列。
- 附件消息可以连续上传；发送第一条普通文字 Prompt 后，Bridge 才把该发送者的整份草稿一次性交给 Codex。

### `/settings`

```text
/settings
/settings input steer|queue
/settings progress on|off
/settings mention on|off
/settings reset
```

群内命令只修改当前 Session。兼容旧的 `/settings thinking on|off` 写法，但界面会明确称为“公开进度（非隐藏思维链）”。

在 Bot 私聊使用相同命令时，修改的是后续新绑定的全局默认快照：

- 新安装默认 `queue + 公开进度开启 + 最终回答提醒开启`；
- 新绑定在创建时复制当时的默认值；
- 修改全局默认不会追改已有群；
- 旧部署中没有设置记录的已有绑定继续保留旧安全默认 `steer + 公开进度关闭`。

### `/model`

```text
/model
/model <编号或模型>
/model effort <强度>
/model speed standard|fast
/model reset
```

模型目录从当前账号的 App Server 动态读取，不硬编码。Bridge 不会把当前模型不支持的推理强度或速度组合写入 Session。修改只影响后续 Turn，不改写正在运行的当前回答。

### `/plan`

```text
/plan
/plan on
/plan off
```

查看或切换 App Server 原生 Plan collaboration mode。Plan 与 Goal 是独立状态；活动 Goal 必须先暂停才能进入 Plan。

### `/goal`

```text
/goal
/goal start <目标>
/goal pause
/goal resume
/goal replace <目标>
/goal budget <tokens|none>
/goal clear
```

Goal 自动续跑产生的每轮最终结果会以“Goal 进展”发送回群，完成后显示“Goal 已完成”。

### 共享群命令权限

- 所有已启用且仍在群内的成员：`/status`、查看/清理自己的 `/attachments`、查看队列、`/queue <Prompt>`。
- 当前 Turn 初始发起者：额外允许 `/steer` 与 `/stop`。
- Session owner：允许全部 Session 命令，包括模型、Plan、Goal、设置、队列删除/清空和 `/delete`。
- `/members` 与 Bot 私聊中的全局 `/settings` 只允许 Bridge Owner。

### `/delete`

`/delete` 先预览解除绑定的影响。5 分钟内发送 `/delete confirm` 才执行，`/delete cancel` 取消。

解除绑定会在适用时移除 Agent 标签并自动重载 Bridge，但不会删除飞书群，也不会删除或归档 Codex Session。只有 Session owner 能执行；Session 正在回答、运行 Goal 或仍有队列时拒绝解除。

## 创建绑定

向 Bot 私聊发送 `/add`。为避免在共享群泄露个人任务列表，绑定群中的 `/add` 会引导用户回到 Bot 私聊。向导 15 分钟有效：

1. 选择 Codex Desktop Project，或选择“独立”；
2. 选择未归档且符合原生 Project 归属的 Session；
3. 已配置个人目录后还可选择“新建 Project”，Bridge 只在当前用户目录下创建新目录和首个任务；
4. “独立”下也可创建 projectless Session；普通成员固定使用自己的目录，不能从飞书提交任意绝对 cwd。未启用多用户目录的旧 Owner 流程仍会本地校验输入的绝对 cwd；
5. Bridge 创建私有群、校验群成员、应用 Feed 标签、复制默认设置、持久化绑定并发送欢迎消息；
6. supervisor 在成功后自动重载 Bridge。

可随时发送 `/cancel`。已绑定 Session 不会重复建群。新群名称为 `{Project名}/{Session名}` 或 `独立/{Session名}`，名称按飞书限制清理和截断。

Owner 自己的绑定仍要求 Feed 标签成功后才持久化。Feed 标签属于 OAuth 用户的个人视图；普通成员作为群 owner 时，Owner OAuth 可能看不到该群，因此 Bridge 会尽力应用标签但不会让个人标签限制阻塞安全绑定，并在欢迎消息中如实说明。无论标签是否可用，成员/Bot 校验、设置快照与本机绑定写入都必须成功。

也可以在目标 Codex Session 中调用 `$feishu-session-bind`。Skill 只把当前环境提供的 Session 标识交给 Bridge，不接受手填 Session ID，也不会读取或输出 App Secret。

## 多用户目录与成员登记

多用户是显式启用的兼容扩展。旧安装不运行下列设置时继续保持 Owner-only。

macOS：

```bash
./setup-project-root.sh
```

Windows：

```powershell
.\setup-project-root.ps1
```

该本机交互脚本由 Bridge Owner 设置一个全局 Project 根目录和 Owner 自己的一级目录。绝对路径只经 stdin 进入本机配置器，不出现在飞书命令、进程参数、仓库或 Bot 回复中。已启用的根目录不能通过自动流程改指向别处。

Owner 可在 Bot 私聊查看成员，在 Bot 私聊或已有绑定群中用 mention 登记/停用成员：

```text
/members
/members add <一级目录名> @成员
/members remove @成员
```

- 新成员目录必须不存在或为空；Bridge 不接管非空目录，也不改分配过的目录名。
- 在实际绑定群中登记很实用：Owner 先把新人加入群，再发送 `/members add ... @成员`。登记成功并自动重载后，该成员才获得这个 Session 的使用权。
- 群内存在未登记或已停用的人时，所有 Session 内容收发 fail closed；Owner 仍可执行成员登记命令完成恢复。
- 停用成员不删除文件。成员仍拥有绑定 Session 时拒绝停用；应先解除这些绑定。停用后也应把成员移出共享群。
- Owner `/add` 只看到 Owner 目录内的任务，以及不属于任何成员目录的旧 Project/独立任务；普通成员只看到自己目录内的任务。共享别人的 Session 不会让它出现在自己的 `/add` Project 列表中。
- 飞书应用的可用范围必须包含新成员；否则其消息不会到达 Bot。

## 安全门禁

- 入站 Prompt 先验证不可变 `chat_id`，发送者必须是当前群内已启用 Bridge 用户。
- 任何可能包含任务信息的出站消息，在发送前都用 Bot 身份重新读取完整群成员。
- Session owner 必须仍在群内且处于启用状态；所有其他人类成员也必须已启用。群内只能有当前 Bridge Bot，不能加入第三方 Bot。
- 未登记/已停用成员、Session 被归档或成员无法完整核验时，敏感入站和出站内容全部 fail closed。
- `im.message.receive_v1` 与 `im:message.group_msg` 都必须发布；只有群内 `@Bot` 权限时，平台不会投递普通未 @ 消息。
- 默认沙盒是 `workspace-write`。`danger-full-access` 会扩大远程消息可触发的本机写入范围，只应在完全可信的个人环境中使用。

## 持久状态与投递

- 用户目录/成员状态、每个 Session 的设置、按发送者隔离的附件草稿、Prompt FIFO、输入账本、临时 Chat 状态和最终投递状态保存在本机运行目录。
- 所有最终答案先写入持久发件箱，再调用飞书发送。
- 最终答案使用按 Turn 派生的确定性投递 ID；网络重试不会重复运行 Codex。
- 主动发送最终结果前仍会重新校验群成员。
- 断线期间的公开进度不补发，最终答案仍会补发。

## 共享 App Server 与 Desktop relay

Session Relay 和 Codex Desktop 必须连接同一个本机 App Server。独立 App Server 对 Session 实行单 writer 锁；两个 App Server 进程不能分别接续同一 Session。

首次启用：

1. `start-bridge.sh`/`.ps1` 启动或复用经过 PID、可执行文件和 loopback 健康检查验证的 App Server，再启动 Bridge supervisor；macOS 使用 `/readyz`，不把“端口可连接”误判为服务就绪；
2. Bridge connected 后运行 `configure-codex-desktop-relay.sh`/`.ps1`；
3. 激活器验证监听器，安装并启动连续 watchdog，再设置 `CODEX_APP_SERVER_WS_URL`；
4. 对应平台的严格 `doctor` 验证 pointer、watchdog、heartbeat、监听器所有权和 Bridge；
5. 完全退出并重新打开 Codex Desktop，让新进程读取环境变量。

watchdog 默认每 3 秒检查监听器。监听器消失或健康检查失败时先移除 Bridge 拥有的 pointer，再尝试恢复 App Server；只有进程、命令行与健康状态重新验证后才恢复 pointer。它会检测但不会停止或删除用户自建 guardian、计划任务或服务。

当前 `main` 中，Bridge 启动时只有在连接成功后才设置 pointer；正常停止或 supervisor 最终退出时暂停 watchdog 并移除 pointer。停止 Bridge 不会立即结束仍供 Desktop 使用的共享 App Server。

彻底撤销：

```powershell
.\configure-codex-desktop-relay.ps1 -Disable
```

macOS 使用：

```bash
./configure-codex-desktop-relay.sh --disable
```

随后完全重启 Codex Desktop。稳定 bootstrap 只清理由本地 activation state 精确记录的 URL，不会删除其他软件的 loopback pointer。

## 最小配置

`bridge.config.json` 是被 Git 忽略的本机文件：

```json
{
  "schemaVersion": 4,
  "mode": "session-relay",
  "appId": "<APP_ID>",
  "workspace": "C:\\path\\to\\bridge-runtime-root",
  "agent": {
    "ownerOpenId": "<OWNER_OPEN_ID>"
  },
  "sessionRelay": {
    "nameSync": "none",
    "appServerUrl": "ws://127.0.0.1:47321/rpc",
    "displayTimeZone": "Asia/Shanghai",
    "promptPreviewChars": 4000,
    "inboundAttachments": {
      "enabled": true,
      "maxItems": 10,
      "maxFileBytes": 31457280,
      "maxTotalBytes": 62914560,
      "retentionHours": 168,
      "maxCacheBytes": 1073741824
    },
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

`bindings: []` 是合法的首次启动状态；未绑定群会被拒绝，但 owner 仍可在 Bot 私聊发送 `/add` 完成第一个绑定。可选的多用户根目录、成员和 Bridge 创建的 Project 保存在运行目录的私有 `session-relay-access.json`，不写入仓库或 `bridge.config.json`。完整示例与超时、重试和长度参数见 [`bridge.config.example.json`](../bridge.config.example.json)。
