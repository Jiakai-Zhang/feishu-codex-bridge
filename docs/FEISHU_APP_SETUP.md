# 飞书自建应用配置

每台电脑建议使用一个专用于 Codex Bridge 的企业自建应用。不要与飞书 CLI 智能体或其他生产机器人共用 App ID；这样权限、消息入口、故障和审计边界最清楚。

## A. 创建或绑定应用

### 推荐：由飞书 CLI 创建专用应用

先安装仓库依赖：

```powershell
npm ci
```

经用户确认后执行：

```powershell
.\lark-cli.ps1 config init --new --brand feishu --lang zh_cn
```

命令会等待用户在浏览器完成应用创建。由 Agent 操作时，应在后台运行并把验证网址与二维码交给用户，不得伪造完成状态。

### 使用已有专用应用

在可见的本机 PowerShell 中运行：

```powershell
.\lark-cli.ps1 config init
```

按交互提示绑定已有应用。App Secret 只能在该本机交互流程中输入，不得发送到聊天、写入命令行参数或提交到 Git。

## B. 开发者后台配置

打开[飞书开放平台开发者后台](https://open.feishu.cn/app)，进入刚创建的应用。

### 1. 启用机器人

在“应用能力 > 机器人”中启用机器人，并设置容易识别的名称与头像。Bridge 将使用这个机器人发送群消息。

### 2. 添加应用权限

在“权限管理”中为应用添加：

- `im:message`：发送消息，并以 Bot 身份下载 owner 消息中的图片与附件；
- `im:message.p2p_msg`：接收与机器人的单聊消息，用于 `/add`；
- `im:message.group_msg`：接收群内普通消息，使仅含用户与 Bot 的绑定群无需 `@Bot`；
- `im:chat:readonly`：读取群基本信息；
- `im:chat.members:read`：验证群内只有绑定用户与 Bot；
- `im:chat:create`：创建专属绑定群；
- `im:resource`：把 Codex 输出中的图片与文件上传回飞书；
- `docx:document:create`：以当前用户身份创建长回答云文档；
- `docx:document:write_only`：把完整 Markdown 回答写入新文档。

如果后台提示管理员审批，等待企业管理员批准后再继续。Bot 权限必须在开发者后台添加并重新发布应用；反复执行用户 OAuth 不能补上 Bot 权限。

`im:message` 已满足“获取消息中的资源文件”接口的权限要求，无需为入站附件额外添加 `im:message:readonly`。如果应用选择只读权限模型，也可以用 `im:message:readonly` 满足下载接口，但 Bridge 发送回复仍需要 `im:message`。保密消息、开启防泄密模式的群，以及飞书接口不支持的表情包/合并转发子消息资源不会被下载。

### 3. 配置事件

在“事件与回调”中选择长连接接收事件，并订阅：

- `im.message.receive_v1`（接收消息）

### 4. 发布版本

在“版本管理与发布”中创建版本，将可用范围包含当前安装用户，提交并发布。权限或事件每次变化后都要创建并发布新版本；未发布的草稿不会作用于线上机器人。

## C. 验证 Bot 身份

```powershell
.\lark-cli.ps1 auth status --json --verify
```

只检查结果中的 Bot 是否 `available=true` 且 `verified=true`。不要把完整 JSON（其中含应用和用户标识）粘贴到聊天或 Issue。

## D. 授权当前用户使用 Feed 标签和长回答文档

群标签和长回答云文档都由用户身份调用，因此需要单独授予：

- `im:feed_group_v1:read`
- `im:feed_group_v1:write`
- `docx:document:create`
- `docx:document:write_only`

人工直接操作时可运行：

```powershell
.\lark-cli.ps1 auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only"
```

Agent 应使用可暂停的设备授权流程：

```powershell
.\lark-cli.ps1 auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only" --no-wait --json
.\lark-cli.ps1 auth qrcode "<verification URL>" --output feishu-oauth.png
```

Agent 把验证网址和生成的二维码显示给用户后结束当前回合。用户确认授权后，Agent 再用上一步返回的短期 device code 完成轮询：

```powershell
.\lark-cli.ps1 auth login --device-code "<device code>" --json
```

二维码图片与 device code 都是临时安装产物，不得提交到 Git。最后再次运行 `auth status --json --verify`，确认用户身份可用，并运行仓库的 `doctor.ps1` 检查 Feed 与文档 scope。

## E. App Secret 的第二份用途

飞书 CLI 配置完成后，Channel Bridge 仍需通过 `setup-channel-secret.ps1` 保存自己的 DPAPI 加密副本。必须由用户在可见窗口中输入；不要从飞书 CLI 配置、进程、日志或系统凭据中提取明文。
