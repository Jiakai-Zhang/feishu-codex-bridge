# Windows Codex 安装代理协议

本文件供 Codex 在用户要求安装、部署或验收本仓库的 Windows Session Relay 时执行。给新电脑的可复制完整指令见 [Windows 全新安装 Prompt](INSTALL_WINDOWS_PROMPT.md)。目标是以可验证结果交付，不得把浏览器认证、应用发布、管理员审批、安全输入或 Desktop 重启伪装成已自动完成。

## 安全边界

- 先确认目标是 Windows，且用户明确授权安装本仓库。创建或修改飞书应用前，必须一次性说明应用名称、模板权限/事件和可能的发布/审批，再取得用户明确批准。
- 除人工认证停点中 Lark CLI 原样生成的一次性 verification URL，以及应用模板脚本生成的临时本机 loopback URL 外，不输出 App Secret、OAuth token、device code、App ID、open ID、chat ID、Codex task ID、`bridge.config.json` 内容或任务绝对路径。
- 不让用户把 App Secret 发进聊天。只启动 `setup-channel-secret.ps1` 的本机可见交互窗口。
- 不修改 `.codex-global-state.json` 或其他 Codex 全局状态来伪造 Project 归属。
- 不覆盖已有 `bridge.config.json`、用户环境变量或同名 Skill。只有说明冲突并获得用户明确同意后，才可使用 `-ForceConfig`。
- 浏览器登录、CAPTCHA/MFA、应用模板确认、管理员审批、应用发布、OAuth、Secret 安全输入与 Desktop 完整重启都是人工停点。每个停点后只用安全摘要进行只读验证。
- 只使用仓库 `.ps1` 入口，不手工复刻其凭据、配置、relay 或 watchdog 行为。

## 0. 固定版本与目标目录

新安装使用已发布的精确 Windows tag。当前默认目标为 `v0.3.2-windows-rc.1`：

```powershell
git clone --branch v0.3.2-windows-rc.1 --depth 1 https://github.com/ninmon/feishu-codex-bridge.git "$env:LOCALAPPDATA\FeishuCodexBridge\app"
Set-Location "$env:LOCALAPPDATA\FeishuCodexBridge\app"
git describe --tags --exact-match
```

克隆前必须先确认远程 tag 存在并解析到精确提交。tag 不存在时停止，不得改用 `main`、其他 tag 或本地散文件。若目录已存在，先只读检查 `git remote -v`、`git status --short`、精确 tag 和本机配置；不得 reset、clean、stash 或覆盖用户改动。

## 1. 依赖预检与锁定安装

只读检查 Windows 10/11、PowerShell 5.1/7、Git、Node.js/npm、ChatGPT/Codex Desktop 和 Codex App Server listener 能力。Node.js 必须不低于 22.13。缺少 Git 或 Node.js 时，先说明将发生的系统软件安装并取得批准，再使用官方 winget 包：

```powershell
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
```

重新打开 PowerShell 后执行：

```powershell
npm ci
.\lark-cli.ps1 --version
```

不得全局安装未锁定的 Lark CLI。

## 2. 创建专用飞书应用

全新电脑不复用其他机器或组织内现有的应用/Bot。使用以下只读命令取得系统计算机名：

```powershell
[Environment]::MachineName
```

飞书应用展示名称必须与该值完全一致。创建、模板权限/事件与可能的应用发布是一组外部变更；向用户说明完整范围并取得一次明确的“批准创建并配置”。

批准后运行：

```powershell
.\lark-cli.ps1 config init --new --brand feishu --lang zh_cn
```

用户使用实际部署 Bridge 的飞书组织账号完成浏览器认证、CAPTCHA/MFA 和应用创建，并在创建页将应用名称设为上述计算机名。`config init --name` 只会命名 CLI 本地 profile，不会设置应用展示名称。飞书拒绝该名称时暂停，由用户决定是否先修改 Windows 计算机名；不得自行加后缀。

CLI 输出 verification URL 后，无论浏览器是否自动打开，都将该 URL 原样作为可点击备用链接交给用户并暂停。不输出 device code、原始 JSON 或身份数据，不重跑会使已交付 URL 失效的命令。

## 3. 应用创建后立即安全保存 Secret

`setup-channel-secret.ps1` 在没有 `bridge.config.json` 时使用标准 Windows runtime workspace，因此可以紧跟应用创建执行。打开本机可见的独立 PowerShell 窗口：

```powershell
Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PWD 'setup-channel-secret.ps1'))
```

用户只在该窗口的隐藏输入提示中粘贴 Channel App Secret。脚本使用当前 Windows 用户 DPAPI 加密；Agent 不读取明文，不在命令参数、聊天、配置或日志中处理 Secret。暂停到用户确认窗口显示 DPAPI 保存成功。

## 4. 一次模板配置与 OAuth

运行：

```powershell
.\configure-feishu-app.ps1
```

脚本从本机 Lark CLI 已验证 profile 取得应用身份，通过随机 loopback 跳转打开飞书官方模板确认页，不会在终端输出或在浏览器启动进程参数中携带 App ID。脚本先输出一个最多两分钟有效、不含 App ID 的临时本机 URL，再尝试打开浏览器；自动打开失败时明确让用户打开该 URL。用户在一页确认 7 项应用/Bot 权限、4 项用户权限与 `im.message.receive_v1`；完整清单见 [飞书应用配置](FEISHU_APP_SETUP.md)。

Lark CLI 创建的新应用通常已默认启用 Bot、长连接和 `im.message.receive_v1`。标准流程不要再让用户逐页重复设置这些项。若飞书要求可用范围、版本发布或管理员审批，可用范围只加入当前安装用户，由用户本人提交，并在状态明确生效前暂停。

然后完成当前用户 OAuth 与安全验证：

```powershell
.\lark-cli.ps1 auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only"
.\verify-feishu-app.ps1
```

OAuth 命令也必须将当次 verification URL 原样作为可点击备用链接交给用户，不输出 device code 或原始 JSON，不重新发起使原 URL 失效的授权。

`lark-cli.ps1`、Windows 安装器和 Doctor 会为飞书 CLI 子进程移除 HTTP/HTTPS/ALL proxy 变量，避免 Desktop 代理造成飞书身份或事件校验假阴性。`verify-feishu-app.ps1` 只输出安全摘要；只有 `ok=true` 且应用、Bot、用户、四项 OAuth scope、消息事件发布与所需权限全部通过才能继续。不得将原始 `auth status` 或 event dry-run JSON 粘贴到聊天、Issue 或日志。

## 5. 生成配置并安装 Skill

```powershell
.\install.ps1 -SkipDependencyInstall
```

安装器会验证 Node.js 和 Codex listener，从已验证 Lark CLI 身份中读取必要标识而不输出，生成被 Git 忽略的 `bridge.config.json`，安装 `$HOME\.agents\skills\feishu-session-bind`，并设置 `FEISHU_CODEX_BRIDGE_HOME`。新安装不得在 Bridge 与共享 App Server 验证成功前持久化 `CODEX_APP_SERVER_WS_URL`。

不得手工编辑或输出 `bridge.config.json`。已有配置默认保留；只有在已说明冲突并取得用户明确同意后才可使用 `-ForceConfig`。

## 6. 启动、直连/代理选择与 Desktop 重启

先启动 Bridge 并运行启动前检查：

```powershell
.\start-bridge.ps1
.\doctor.ps1 -RequireRunning
```

在进行 Desktop relay 激活前，必须明确询问用户：

> 这台 Windows 电脑上 Codex 访问服务是直连，还是需要本机代理？不需要代理请回复“直连”；需要代理请提供一个无认证、带明确端口的 loopback URL，例如 `http://127.0.0.1:7897`。

不得根据环境变量、Clash 状态或网络检测替用户推断。默认不使用代理；仅用户明确提供无认证、带端口的 `127.0.0.1`/`localhost`/`[::1]` URL 时才启用。

在仓库目录为用户打开独立 PowerShell，让用户完全退出 ChatGPT/Codex Desktop，然后只运行选定的一条命令。直连：

```powershell
.\launch-codex-desktop-with-relay.ps1
```

明确使用本机代理：

```powershell
.\launch-codex-desktop-with-relay.ps1 -Proxy http://127.0.0.1:7897
```

启动器把选定网络模式应用到 Desktop 和共享 Codex App Server；飞书 Bridge、Channel、watchdog 和飞书 CLI 保持直连。代理状态变化时，脚本只重启由本安装验证拥有的 App Server，重新注册 Scheduled Task watchdog，等待同一 activation 的新鲜 `ready` heartbeat；任一步失败都移除 Bridge-owned pointer，使 Desktop fail open。

只有能找到可直接启动的 Win32 Desktop 可执行文件时，才能把 `-Proxy` 隔离到 Desktop 进程。若本机只有 packaged Desktop，代理模式必须安全停止；不得自动改系统或用户全局代理。直连模式仍可使用 packaged Desktop。

必须在用户完全退出和重启 Desktop 时暂停。不得从正在使用共享 App Server 的当前 Codex 回合中强制结束 Desktop。

Desktop 重新打开后执行：

```powershell
.\status-bridge.ps1
.\doctor.ps1 -RequireRunning -RequireDesktopRelay
```

## 7. 真实绑定与附件验收

1. 在当前 Codex 任务中使用安装后的 `$feishu-session-bind`，创建或复用只有当前用户与 Bot 的专属绑定群。初次安装不要求用户先创建 Bot 私聊或发送 `/add`；`/add` 只是以后的可选手工入口。
2. 从绑定群发一条 Prompt，确认 Desktop 中同一任务收到并执行，最终回答返回群。
3. 从 Desktop 的同一任务发一条 Prompt，确认最终回答返回飞书群。
4. 从飞书发送一张小图和一个普通小文件，确认 Codex 能实际读取。让 Codex 最终回答引用一个不超过 30 MB 的本地文件，确认飞书收到原生附件且不额外 `@owner`。
5. 在绑定群连续发送两个小型普通附件，确认它们进入持久暂存区，`/status` 能看到累计数，其他 Bridge 命令不会消费。再发一条普通文本 Prompt，确认所有附件在一次输入中进入 Codex。没有草稿时单独发图，确认图片立即进入原生视觉输入。
6. 上传一个测试附件后运行 `/attachments clear`，确认草稿被放弃且没有启动 Codex Turn。
7. 再次运行 `status-bridge.ps1` 与严格 Doctor。

只有 Doctor、真实双向消息与附件验收全部通过才能报告安装成功。报告只列出精确版本、Bridge connected 状态、绑定数和仍需注意的 RC 限制，不列出身份标识或任务路径。

## 8. 升级已有安装

用户明确要求升级时，先只读检查安装目录的 `git remote -v`、`git status --short`、当前精确 tag、`status-bridge.ps1` 和 `doctor.ps1`。不创建或修改飞书应用，不重新索取 App Secret。工作树有任何已跟踪或未跟踪改动时停止；不得 reset、clean、stash 或覆盖。

使用当前 release 自带升级器和明确 tag：

```powershell
.\update.ps1 -Version <目标 release tag>
```

升级器负责停止/恢复 Bridge、创建本机恢复备份、切换精确 tag、执行 `npm ci`、保留本机配置、DPAPI 密文、绑定、Session 设置、队列、账本、附件缓存和投递状态，失败时回滚。升级前 Desktop relay 已启用时，`doctor.ps1 -RequireDesktopRelay` 是成功条件。

若旧 `v0.2.0-beta.1` 因无监听的 `CODEX_APP_SERVER_WS_URL` 使 Desktop 报 `ECONNREFUSED`，先确认端口确实没有监听，再使用旧版 `configure-codex-desktop-relay.ps1 -Disable` 恢复 fail-open，然后升级并重新激活 watchdog。升级前只读检查可能指向 App Server/relay/watchdog 的自建进程、计划任务或 Windows 服务；不得停止、删除、改名或覆盖。

目标版本若新增 Desktop 网络模式记录，升级后必须先询问用户直连或本机代理，不得从旧环境自动推断。Bridge 连接后，让用户完全退出 Desktop，用 `launch-codex-desktop-with-relay.ps1` 或明确的 `-Proxy` 形式记录选择并重新打开。该步可能重启由本安装验证拥有的共享 App Server。
