# 飞书自建应用配置

每台同时运行 Bridge 的电脑都必须使用一个独立的企业自建应用和 Bot，即使这些电脑由同一个飞书账号使用也不例外。飞书长连接的消息推送是集群模式，同一应用建立多个客户端时，只会由其中随机一个客户端收到事件；详见[飞书长连接注意事项](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)。不要与飞书 CLI 智能体或其他生产机器人共用 App ID。

macOS 和 Windows 都推荐使用仓库的一次模板确认流程；手工清单只用于模板页不可用或安全校验明确指出缺项时的故障回退。任何 App Secret、OAuth token、App ID、open ID 或 chat ID 都不得发到聊天、放入命令参数、日志、文档或 Git。

## A. 创建专用应用

先安装仓库锁定依赖：

```bash
./bootstrap.sh
./lark-cli.sh --version
```

Windows PowerShell 对应使用 `npm ci` 和 `./lark-cli.ps1`。

macOS 应先只读取得运行 Codex Desktop 的电脑名称：

```bash
/usr/sbin/scutil --get ComputerName
```

飞书应用展示名称必须与该结果完全一致，包括大小写、空格和字符。若结果为空，先由用户在 macOS“系统设置 > 通用 > 共享”中设置电脑名称。Windows 对应使用：

```powershell
[Environment]::MachineName
```

Windows 应用展示名称也必须与该结果完全一致。

创建应用是外部变更。Agent 必须先向用户说明应用名称以及后续还会添加的权限/事件，并取得明确批准。macOS 执行：

```bash
./lark-cli.sh config init --new --brand feishu --lang zh_cn
```

Windows PowerShell 执行：

```powershell
.\lark-cli.ps1 config init --new --brand feishu --lang zh_cn
```

用户使用实际部署 Bridge 的飞书组织账号完成浏览器认证、CAPTCHA/MFA 和应用创建。macOS 与 Windows 创建页中的“应用名称”都使用上面取得的系统电脑名称；如果创建流程没有名称输入框，创建后在“基础信息”中只修改这一项，并核对完全一致。

Lark CLI 会输出一次性 verification URL。不能假定浏览器一定会自动弹出；安装执行者应将 CLI 当次原样输出的 verification URL 作为可点击备用链接交给用户，然后暂停等待。只转交该 URL，不输出 device code、原始 JSON、App ID、Secret 或 Token，也不重跑会使原 URL 失效的命令。

`config init --name` 中的 `--name` 只会命名 Lark CLI 本地 profile，不会设置飞书应用展示名称，不得混用。若飞书不接受当前电脑名称，暂停让用户决定是否先修改系统电脑名称，不要自行加后缀。Agent 可以启动 CLI 和浏览器流程，但必须在需要用户认证时暂停，不得把认证临时凭据或应用身份数据复制到聊天。

如确有需要绑定一个已有的、只供本机使用的专用应用，可运行不带 `--new` 的 `config init`。全新 macOS 或 Windows 电脑的标准安装不使用这条分支。

## B. 推荐：一次模板确认

macOS 或 Windows 由 Codex Desktop 执行安装时，当前对话都必须先设为“完全访问（Full access）”。“替我审批（Approve for me）”不会解除沙盒边界；macOS 的 `security`/Keychain 子进程，或 Windows 的 PowerShell、DPAPI 检查、Scheduled Task 与 relay 配置可能因此无法访问当前用户资源，并造成 Secret 或连接状态假阴性。

应用创建完成后，先由用户在本机可见 Terminal 安全保存 Channel App Secret：

```bash
./setup-channel-secret.sh
```

该脚本可以在 `bridge.config.json` 生成前运行。用户只在 macOS `security` 的隐藏输入提示中粘贴 Secret；Bridge 将其保存到当前用户 Keychain。

Windows 也必须在创建应用后立即运行：

```powershell
.\setup-channel-secret.ps1
```

该脚本同样不依赖 `bridge.config.json`，并使用当前 Windows 用户 DPAPI 加密。

然后运行：

```bash
./configure-feishu-app.sh
```

脚本从本机 Lark CLI 配置读取应用身份，通过随机 loopback 地址把浏览器转到飞书官方应用模板确认页。App ID 不会出现在终端输出或浏览器启动进程参数中。macOS 和 Windows 脚本都会先输出一个最多两分钟有效、不含 App ID 的临时本机 URL，再尝试自动打开浏览器。如果浏览器没有弹出，必须明确让用户打开这个本机 URL，不要暴露它最终跳转的飞书目标 URL。用户只需在一个页面核对以下模板并确认。

Windows 对应运行：

```powershell
.\configure-feishu-app.ps1
```

Windows 脚本使用相同的随机 loopback 跳转与两分钟本机 URL 备用机制，也不在浏览器启动进程参数中暴露 App ID。

应用/Bot 权限：

- `im:message`：发送消息，并以 Bot 身份下载已授权成员消息中的图片与附件；
- `im:message.p2p_msg:readonly`：接收已启用用户与机器人的单聊消息，用于 `/chat`、`/add`、成员设置与后续私聊；
- `im:message.group_msg`：接收群内普通消息，使单人绑定群无需 `@Bot`；多人群由 Bridge 再要求 `@Bot`/回复 Bot/斜杠命令；
- `im:chat:readonly`：读取群基本信息；
- `im:chat.members:read`：验证 Session owner、所有已启用共享成员和唯一当前 Bot；
- `im:chat:create`：创建专属绑定群；
- `im:resource`：把 Codex 输出中的图片与文件上传回飞书。

用户权限：

- `im:feed_group_v1:read`：读取当前用户的消息标签；
- `im:feed_group_v1:write`：创建 Agent 标签并把绑定群加入标签；
- `docx:document:create`：以当前用户身份创建长回答云文档；
- `docx:document:write_only`：把完整 Markdown 回答写入新文档。

上述 OAuth 是 Bridge 主机当前授权用户（通常为 Bridge Owner）的个人身份。Feed 标签也是个人视图：由普通成员作为 owner 的私有群可能不在 Owner OAuth 的可见范围，因此标签只能尽力应用，不能作为该成员 Session 绑定的授权依据；授权始终由本机成员登记、固定 `chat_id` 和实时群成员校验决定。长回答文档同样由该 OAuth 用户创建后把链接发到绑定群。

长连接事件：

- `im.message.receive_v1`（接收消息）。

Lark CLI 当前创建的新应用通常已默认启用 Bot、长连接和该消息事件。标准流程不要求用户再逐页重复设置；模板仍声明事件，并由后续校验确认实际生效状态。

如果飞书确认页或组织策略要求设置可用范围、创建/发布版本或管理员审批：

1. 可用范围只加入实际使用本机 Bridge 的 Owner 与显式登记成员；新成员未进入可用范围时，其消息不会到达 Bot；
2. 由用户本人核对模板变更并提交；
3. 显示待审核时暂停，等待管理员批准和版本状态明确生效。

权限或事件不能只停留在草稿。反复执行用户 OAuth 也不能补上尚未配置、发布或获批的应用权限。

## C. 用户 OAuth 与安全校验

Feed 标签和长回答云文档由当前用户身份调用，需要单独授权：

```bash
./lark-cli.sh auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only"
```

用户本人在浏览器确认后运行：

```bash
./verify-feishu-app.sh
```

验证器只输出以下安全状态，不输出应用或用户身份：

Windows 使用完全对应的入口：

```powershell
.\lark-cli.ps1 auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only"
.\verify-feishu-app.ps1
```

- 应用配置存在；
- Bot 身份 available/verified；
- 用户身份 available/verified；
- 四项用户 OAuth scope 完整；
- `im.message.receive_v1` 已发布；
- 消息事件所需应用权限已生效。

只有 `ok=true` 才能继续安装。不要把 `auth status --json --verify` 或 `event consume ... --dry-run` 的原始 JSON 粘贴到聊天、Issue 或日志。模板中其他群、Feed、文档和附件能力最终还必须通过真实绑定及双向附件验收。

## D. 手工故障回退

只有 macOS 的 `verify-feishu-app.sh` 或 Windows 的 `verify-feishu-app.ps1` 指出缺项，或飞书模板页不可用时，才进入开发者后台逐项检查。不要在校验通过后重复这些步骤。

### 1. Bot

在“应用能力 > 机器人”确认机器人已启用，并设置容易识别的名称与头像。新应用通常已经满足本项。

### 2. 权限

在“权限管理”核对 B 节列出的 7 项应用/Bot 权限与 4 项用户权限。缺少哪一项只补哪一项。

`im:message` 已满足“获取消息中的资源文件”接口的权限要求，无需为入站附件额外添加 `im:message:readonly`。如果应用选择只读权限模型，也可以用 `im:message:readonly` 满足下载接口，但 Bridge 发送回复仍需要 `im:message`。保密消息、开启防泄密模式的群，以及飞书接口不支持的表情包/合并转发子消息资源不会被下载。

### 3. 长连接事件

在“事件与回调”确认使用长连接接收事件，且已订阅 `im.message.receive_v1`。新应用通常已经满足本项。

### 4. 发布与审批

在“版本管理与发布”确认当前用户位于可用范围，相关权限和事件已经发布。若组织要求审批，等待管理员批准。

Windows 完成故障回退后，必须运行：

```powershell
.\verify-feishu-app.ps1
```

只使用安全摘要，不要复制原始 JSON。随后继续 Windows 安装协议中的 Doctor 与真实消息/附件测试。

## E. Channel Secret

Lark CLI 的本机应用配置不能代替 Channel Bridge 自己的安全凭据。macOS 已在 B 节通过 `setup-channel-secret.sh` 存入 Keychain；Windows 已在 B 节通过 `setup-channel-secret.ps1` 使用 DPAPI 保存。两个脚本都可在生成 `bridge.config.json` 前执行。

Secret 必须由用户在本机可见的隐藏提示中输入。不要从飞书 CLI 配置、进程、日志或系统凭据中提取明文，也不要要求用户在聊天中发送。
