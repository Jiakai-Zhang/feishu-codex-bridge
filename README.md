# Feishu ↔ Codex 本地桥接

这个本地桥接不使用 OpenAI API Key。它复用当前电脑上的 ChatGPT 登录态，通过官方 Codex CLI 恢复当前 Codex 任务，再由官方飞书 Channel SDK 接收消息和流式回复。

## 安全策略

- 只接受 `bridge.config.json` 中指定 `open_id` 发给机器人的单聊文本。
- 群消息、其他发送者和非文本消息全部忽略。
- 飞书触发的 Codex 运行使用 `danger-full-access`，可读写本机文件并执行命令。
- 递归删除、覆盖重要数据、重置凭据或权限、强制推送、清空数据库等难以恢复的操作仍需再次确认。
- 消息按顺序处理，并保存最近 1000 条已完成消息 ID，避免重复回复。
- 应用密钥和 ChatGPT 登录凭据均不复制到本目录。
- 普通消息使用飞书动态卡片显示 Codex 主动写给用户的具体过程说明（准备做什么、关键发现、下一步）以及经过脱敏的真实活动事件（分析、命令、文件修改、工具调用、搜索、计划更新）和处理时间；完成后在同一卡片中展示最终结果与简短过程摘要。
- 流式卡片完成后，机器人会额外发送一条带总耗时的“任务已完成”普通消息，以触发飞书的新消息提醒；会话静音设置仍由飞书客户端控制。
- 长时间运行的 Codex 回合不设桥接截止时间。前 8 分钟使用飞书原生流式卡片；随后结束 `streaming_mode`，改为更新同一条卡片，不会每 8 分钟新增续接卡片。执行期间每 30 秒在原卡片上刷新一次耗时心跳，不调用模型。
- 任务运行期间每 30 秒增量读取一次本地 rollout 的新增字节；若发现本轮 `task_complete` 已稳定 15 秒，即使 `codex exec resume` 在 Windows 上没有退出，也会回收最终答案、完成飞书卡片并清理该 CLI 的辅助进程。没有活动任务时不会轮询，也不会产生网络请求或 token 消耗。
- 收到 Codex 的 `turn.completed` 后会给 CLI 15 秒自行清理；若最终答案已经写好但子进程仍不退出，桥接只结束该次残留子进程并采用现有答案，避免卡片永久停留在“处理中”。
- 不传输模型内部思维链、reasoning 内容、完整命令或敏感路径。动态卡片里的“Codex 过程说明”来自 CLI 的 `agent_message` 公共消息，与桌面端 commentary 属于同类可审阅内容。

## 安装与配置

需要 Windows、Node.js、已登录的 Codex CLI、飞书 CLI，以及启用了 Channel SDK 的飞书自建应用。

```powershell
npm install
Copy-Item .\bridge.config.example.json .\bridge.config.json
```

编辑本地 `bridge.config.json`，填写飞书 App ID、允许发送者的 `open_id`、初始 Codex 任务 ID、工作目录和本机可执行文件路径。真实配置已被 `.gitignore` 排除。

然后运行 `setup-channel-secret.ps1`，安全输入 App Secret。该脚本使用 Windows DPAPI 加密保存，明文不会写入配置、日志或仓库；启动器只在内存中解密并传给 Channel SDK 子进程。

## 控制命令

在 PowerShell 中运行：

```powershell
& .\start-bridge.ps1
& .\status-bridge.ps1
& .\stop-bridge.ps1
```

运行日志和去重状态保存在项目的 `work\feishu-codex-bridge` 目录中。

## 使用方式

启动成功后，在飞书中私聊应用机器人。机器人会把文本发送到当前 Codex 任务，并把最终回复引用回复到原消息。

### 选择要继续的 Codex 任务

在飞书私聊中发送：

```text
/new
/new 项目规划
/threads
/use 2
/current
/status
/model
/capacity
/help
```

### 本地状态查询（不调用语言模型）

- `/status`：查看 Channel SDK 连接、桥接运行时间、当前任务阶段、最近进展和等待队列。该命令会绕过普通任务队列，因此长任务运行时也能立即查询。
- `/model`：读取当前所选 Codex 任务在本机状态数据库中记录的模型、推理强度、提供方和 CLI 版本。
- `/capacity`（别名 `/quota`）：读取当前任务 rollout 中最新的 `token_count`，显示最近一次上下文窗口的近似剩余 token，以及账户用量周期的剩余百分比与重置时间。
- `/current`：除任务标题和 ID 外，同时显示模型、推理强度和两类剩余容量的摘要。

这些命令只读取桥接内存、`state_5.sqlite` 和 rollout 文件，不会启动 `codex exec`，不会产生新的模型 token。容量是最近一次本地计数的快照；发送新消息、产生工具输出或触发上下文压缩后会发生变化。

### 飞书回传超时补偿

- Channel SDK 的所有 REST 请求设置为 20 秒超时，单次网络请求不会无限阻塞桥接。
- Codex 产生最终答案后，桥接会在更新卡片或发送回复之前写入 `work\feishu-codex-bridge\pending-deliveries.json`。
- 若卡片更新、最终回复或网络连接发生超时/重置，答案会保留在发件箱；桥接每分钟检查一次，并按指数退避重试。
- 后台补发使用原飞书消息 ID 派生的稳定 `uuid`，相同结果的重试具有幂等性；补发过程不会重新运行 Codex，也不会产生新的模型 token。
- `/status` 的“待补发结果”会显示当前发件箱数量。投递成功后才会移除记录并写入完成去重状态。

`/new` 会创建并自动切换到一个新的 Codex 任务；也可以使用 `/new 主题` 指定任务主题。创建过程只进行只读初始化，不会执行命令或修改文件。旧任务仍会保留，可通过 `/threads` 找回。

`/threads` 会列出最近 10 个本地 Codex 任务；`/use 2` 会把后续飞书消息切换到列表中的第 2 个任务。切换后，Codex 会继续该任务已有的完整聊天历史。这里只能选择本地 Codex 任务，不能切换到普通 ChatGPT 聊天。

当前任务正在桌面端运行时，请等它结束后再从飞书发新消息；同一任务不应同时运行两个回合。
