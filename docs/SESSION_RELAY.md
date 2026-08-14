# Session Relay 参考

本文描述当前正式支持的个人 Session Relay：一个飞书群固定绑定一个本机 Codex Session。安装步骤见 [INSTALL.md](INSTALL.md)，飞书权限见 [FEISHU_APP_SETUP.md](FEISHU_APP_SETUP.md)。

> 当前 `main` 包含固定版 `v0.3.1-beta.1` 之后合并的 Bridge pointer 生命周期、单张持久流式卡片、长回答云文档和完整媒体转发。标有“当前 `main`”的行为在下一个固定 tag 发布前不属于 `v0.3.1-beta.1` 的发布保证。

## 绑定模型

```text
飞书群 A（仅 owner + 当前 Bot） ──固定绑定──> Codex Session A
飞书群 B（仅 owner + 当前 Bot） ──固定绑定──> Codex Session B
```

- 同一个飞书应用 Bot 可以加入多个绑定群。
- Bridge 按不可变的 `chat_id` 查找绑定，不依赖群名猜测目标。
- 每个 `chat_id` 与 `threadId` 在同一份配置中都必须唯一。
- `nameSync=none` 是默认值：群名仅用于展示，不会反写 Codex Session 名称。
- Session 可以属于任意 Codex Desktop Project，也可以是 projectless 的“独立”任务。Bridge 不按 cwd 猜测 Project，也不修改 `.codex-global-state.json`。

## 消息如何进入 Session

owner 在绑定群发送普通文本，无需 `@Bot`。Bridge 去除真实 Bot mention 后，把文本作为该 Session 的输入。

每个 Session 可独立选择普通消息模式：

- `queue`：新安装默认。Session 空闲时立即开始独立新 Turn；忙碌或原生 Goal 运行时写入持久 FIFO，等 Session 再次空闲后执行。
- `steer`：有活动 Turn 时调用 App Server 原生 `turn/steer`，把消息作为“调整方向”；只有确认 Session 已 idle 后才新建 Turn。

`/queue <Prompt>` 总是显式创建独立新 Turn，不受当前普通消息模式影响。多条队列不会合并；Bridge 或共享 App Server 重启后仍会恢复，并通过原飞书消息 ID 对账，避免重复启动。

Session Relay 不提供 `/new`、`/use` 或全局“当前任务”切换。除了精确识别的 Session 与绑定管理命令，其他文本（包括未知的 `/xxx`）都按当前 `queue|steer` 设置交给 Codex。

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

新安装默认开启公开进度与最终回答 `@owner` 提醒。公开进度始终不 `@`，最终提醒可通过 `/settings mention off` 关闭。

当前 `main` 中，一个 Turn 只创建一张可更新卡片：

1. commentary 到达时，在原卡片追加公开进度并刷新“已处理”时长；
2. Turn 完成后，最终答案原位替换进度；
3. 卡片底部显示回答完成时间、整轮用时和本轮真实 Token；
4. 需要提醒时，再发送一次简短 `@owner` 完成通知；
5. 卡片更新失败时，才回退为普通进度消息或持久最终投递。

本轮 Token 使用 App Server 会话累计 usage 的差值计算，覆盖同一 Turn 中的多次模型调用。断线补发缺少 usage 快照时会显示“暂不可用”，不会按文本长度估算。

## 长回答、图片与附件

固定版 `v0.3.1-beta.1` 已支持本地图片与原生附件。当前 `main` 进一步统一了长回答和媒体投递：

- 最终文字超过 `maxReplyChars` 时，把去除本机路径和渲染器元数据后的完整 Markdown 写入当前用户的飞书云文档，并在原回复中发送链接。
- 文档创建结果按 `threadId + turnId` 持久化；重试复用已有文档，不重复创建。
- 文档创建失败时自动退回普通文本投递。
- 本地图片不超过 10 MiB 时内嵌；超过内嵌上限但不超过 30 MiB 时降级为原生附件。
- 视频和其他本地文件不超过 30 MiB 时，在最终回答后按原顺序发送为原生附件。
- `::visualize` 指向的本地 HTML 也作为附件发送。
- 生产路径不限制媒体条目数；重复路径只投递一次。
- 超限、空文件、符号链接或排队后发生变化的文件不会上传，原文件仍保留在 Codex Session 中。
- 飞书消息不会包含本机绝对路径；附件消息也不会额外提醒 owner。

文档能力需要用户 OAuth `docx:document:create` 与 `docx:document:write_only`。媒体上传需要应用权限 `im:resource`。

## Session 命令

### `/status`

查看 Bridge 连接、Session idle/active 状态、当前 Turn、等待标志、队列、模型、推理强度、速度、Plan、Token 和 Goal 摘要。命令只读取本机状态，不调用模型。

### `/stop`

按当前精确活动 Turn 调用 `turn/interrupt`。若原生 Goal 正在运行，会先暂停 Goal，再中止当前 Turn，防止自动续跑。已有 `/queue` 项目保持不变。

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

### `/delete`

`/delete` 先预览解除绑定的影响。5 分钟内发送 `/delete confirm` 才执行，`/delete cancel` 取消。

解除绑定会移除 Agent 标签并自动重载 Bridge，但不会删除飞书群，也不会删除或归档 Codex Session。Session 正在回答、运行 Goal 或仍有队列时拒绝解除。

## 创建绑定

向 Bot 私聊发送 `/add`，也可以在任一已有绑定群中发送。向导 15 分钟有效：

1. 选择 Codex Desktop Project，或选择“独立”；
2. 选择未归档且符合原生 Project 归属的 Session；
3. “独立”下还可创建 projectless Session，并输入名称与本机已存在的绝对工作目录；
4. Bridge 创建私有群、校验群成员、应用 Feed 标签、复制默认设置、持久化绑定并发送欢迎消息；
5. supervisor 在成功后自动重载 Bridge。

可随时发送 `/cancel`。已绑定 Session 不会重复建群。新群名称为 `{Project名}/{Session名}` 或 `独立/{Session名}`，名称按飞书限制清理和截断。

绑定持久化采用严格顺序：先确认标签入口，再创建群；只有成员/Bot 校验和标签写入都成功，才记录 `chat_id ↔ threadId`。中途失败的群不会被当成可用绑定。

也可以在目标 Codex Session 中调用 `$feishu-session-bind`。Skill 只把当前环境提供的 Session 标识交给 Bridge，不接受手填 Session ID，也不会读取或输出 App Secret。

## 安全门禁

- 入站 Prompt 先验证不可变 `chat_id` 与精确 owner `sender_id`。
- 任何可能包含任务信息的出站消息，在发送前都用 Bot 身份重新读取完整群成员。
- 群成员必须严格等于“绑定 owner 一人 + 当前 Bot 一个”。
- 加入第三个人、第三方 Bot、Session 被归档或成员无法完整核验时，敏感出站内容全部 fail closed。
- `im.message.receive_v1` 与 `im:message.group_msg` 都必须发布；只有群内 `@Bot` 权限时，平台不会投递普通未 @ 消息。
- 默认沙盒是 `workspace-write`。`danger-full-access` 会扩大远程消息可触发的本机写入范围，只应在完全可信的个人环境中使用。

## 持久状态与投递

- 每个 Session 的设置、Prompt FIFO、输入账本和最终投递状态保存在本机运行目录。
- 所有最终答案先写入持久发件箱，再调用飞书发送。
- 最终答案使用按 Turn 派生的确定性投递 ID；网络重试不会重复运行 Codex。
- 主动发送最终结果前仍会重新校验群成员。
- 断线期间的公开进度不补发，最终答案仍会补发。

## 共享 App Server 与 Desktop relay

Session Relay 和 Codex Desktop 必须连接同一个本机 App Server。独立 App Server 对 Session 实行单 writer 锁；两个 App Server 进程不能分别接续同一 Session。

首次启用：

1. `start-bridge.ps1` 启动或复用经过 PID、可执行文件和 loopback 端口验证的 App Server，再启动 Bridge supervisor；
2. Bridge connected 后运行 `configure-codex-desktop-relay.ps1`；
3. 激活器验证监听器，安装并启动连续 watchdog，再设置 `CODEX_APP_SERVER_WS_URL`；
4. `doctor.ps1 -RequireRunning -RequireDesktopRelay` 验证 pointer、watchdog、heartbeat、监听器所有权和 Bridge；
5. 完全退出并重新打开 Codex Desktop，让新进程读取环境变量。

watchdog 默认每 3 秒检查监听器。监听器消失时先移除 Bridge 拥有的 pointer，再尝试恢复 App Server；只有进程、命令行与端口重新验证后才恢复 pointer。它会检测但不会停止或删除用户自建 guardian、计划任务或服务。

当前 `main` 中，Bridge 启动时只有在连接成功后才设置 pointer；正常停止或 supervisor 最终退出时暂停 watchdog 并移除 pointer。停止 Bridge 不会立即结束仍供 Desktop 使用的共享 App Server。

彻底撤销：

```powershell
.\configure-codex-desktop-relay.ps1 -Disable
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

`bindings: []` 是合法的首次启动状态；未绑定群会被拒绝，但 owner 仍可在 Bot 私聊发送 `/add` 完成第一个绑定。完整示例与超时、重试和长度参数见 [`bridge.config.example.json`](../bridge.config.example.json)。
