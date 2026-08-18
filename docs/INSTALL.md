# Windows 安装指南（Codex Session Relay Beta）

本版本把一个飞书群绑定到一个 Codex 任务。群内普通消息进入该任务，Codex 最终回答（包括从 Desktop 发起的回答）同步回群；支持可配置的 steer/queue 默认行为、可选公开进度、最终回答 @提醒、排队、停止、状态、模型、Plan 与 Goal。新安装默认使用 `queue + 公开进度开启 + 最终回答 @提醒开启`；公开进度只包含 Codex 标记为 commentary 的阶段说明，不包含隐藏思维链或 raw reasoning，并且始终不会 @。

> 当前仅支持 Windows + Codex Desktop。Bridge 依赖 Codex App Server 的实验性 WebSocket 接口，因此本版本按 Beta 发布，不建议作为无人值守的生产服务。

## 1. 安装依赖

需要：

- Windows 10/11
- 已安装并登录的 Codex Desktop
- Git
- Node.js 22.13 或更高版本（建议当前 LTS）
- PowerShell 5.1 或 PowerShell 7

如果由 Codex Desktop 在当前对话中执行安装，在运行任何命令前，先在输入框下方的权限菜单中将当前对话设为“完全访问（Full access）”并等待用户明确确认。按 [OpenAI Codex 沙盒说明](https://developers.openai.com/codex/sandboxing)，“替我审批（Approve for me）”只处理审批请求，不会改变当前沙盒边界；Windows PowerShell、DPAPI 检查、Scheduled Task、共享 App Server 与 Desktop relay 可能需要访问沙盒外的当前用户资源。不要修改 Codex 全局配置或 Windows 安全机制来代替当前对话权限。

缺少 Git 或 Node.js 时，可在管理员或普通 PowerShell 中使用 Windows Package Manager：

```powershell
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
```

安装后关闭并重新打开 PowerShell，再验证：

```powershell
git --version
node --version
npm --version
```

## 2. 下载测试版

在准备长期保留的目录中执行：

```powershell
git clone --branch v0.3.2-windows-rc.4 --depth 1 https://github.com/ninmon/feishu-codex-bridge.git
Set-Location .\feishu-codex-bridge
npm ci
.\lark-cli.ps1 --version
```

仓库锁定了兼容版本的飞书 CLI 和 Channel SDK；日常操作使用 `lark-cli.ps1`，无需全局安装飞书 CLI。

当前 Beta release 暂由贡献者 fork 托管，并通过上游草稿 PR 合并到 `Jiakai-Zhang/feishu-codex-bridge`；固定 tag 的内容与该 PR 的已验证提交一致。

## 3. 创建应用并立即保存 Secret

先只读取得当前 Windows 计算机名：

```powershell
[Environment]::MachineName
```

创建一个只用于本机 Bridge 的企业自建应用，应用展示名称必须与上述计算机名完全一致。即使同一个飞书账号使用多台电脑，每台电脑也必须有自己的应用和 Bot。在创建应用、添加模板权限/事件和可能的版本发布前，必须先取得用户批准。

```powershell
.\lark-cli.ps1 config init --new --brand feishu --lang zh_cn
```

在创建页把应用名称设为系统计算机名。`config init --name` 只会命名 CLI profile，不能设置飞书应用展示名称。浏览器登录、CAPTCHA/MFA 或管理员确认由用户本人完成。

Lark CLI 输出 verification URL 后，无论浏览器是否自动打开，都将该 URL 原样作为可点击备用链接交给用户。不输出 device code、原始 JSON、App ID、Secret 或 Token，不重跑会使已交付 URL 失效的命令。

应用创建后，在生成 `bridge.config.json` 之前就可以运行：

```powershell
.\setup-channel-secret.ps1
```

只在本机可见窗口的隐藏提示中粘贴 Channel App Secret。脚本使用当前 Windows 用户 DPAPI 加密，不会把明文写入命令参数、配置、仓库或日志。

## 4. 一次模板配置与 OAuth

```powershell
.\configure-feishu-app.ps1
```

该脚本通过私有 loopback 跳转打开飞书官方应用模板，一次确认 7 项应用/Bot 权限、4 项用户权限与 `im.message.receive_v1`，不在终端或浏览器启动进程参数中暴露 App ID。它会先输出一个最多两分钟有效、不含 App ID 的临时本机 URL，再尝试打开浏览器；自动打开失败时直接打开该 URL。Lark CLI 创建的新应用通常已默认启用 Bot、长连接和消息事件，不需要再逐页重复设置。完整清单与故障回退见 [飞书应用配置](FEISHU_APP_SETUP.md)。

若飞书要求可用范围、版本发布或管理员审批，可用范围只加入当前安装用户，由用户本人提交，并等待状态明确生效。然后完成 OAuth 与安全校验：

```powershell
.\lark-cli.ps1 auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only"
.\verify-feishu-app.ps1
```

OAuth 命令同样需要将当次 verification URL 原样交给用户，不输出 device code 或原始 JSON，不重新发起使原 URL 失效的授权。

只有验证器输出 `ok=true` 才继续。Windows 的 Lark CLI、安装器和 Doctor 会移除继承的 Desktop proxy 变量，使飞书身份和事件校验保持直连。

## 5. 生成本机配置

飞书应用安全验证通过后执行：

```powershell
.\install.ps1 -SkipDependencyInstall
```

脚本会：

- 验证 Node.js、Codex App Server 能力和锁定依赖；
- 从已验证的飞书 CLI 身份读取必要标识，但不在终端显示它们；
- 生成被 Git 忽略的 `bridge.config.json`；
- 安装用户级 `$feishu-session-bind` Skill；
- 设置 `FEISHU_CODEX_BRIDGE_HOME`。新安装此时**不会**设置 Codex Desktop 共享 App Server 地址。

已有本机配置时脚本默认保留，不会覆盖。只有确认要替换后才使用 `-ForceConfig`。

## 6. 启动、网络选择与验收

```powershell
.\start-bridge.ps1
.\doctor.ps1 -RequireRunning
```

在重启 Desktop 前必须询问用户是直连，还是需要一个无认证、带明确端口的本机 loopback 代理 URL。不带参数默认直连：

```powershell
.\launch-codex-desktop-with-relay.ps1
```

只在用户明确选择时使用：

```powershell
.\launch-codex-desktop-with-relay.ps1 -Proxy http://127.0.0.1:7897
```

先让用户完全退出 Desktop，再从仓库目录的独立 PowerShell 运行唯一选定的命令。启动器只将代理应用到 Desktop 和共享 App Server；Bridge、Channel、watchdog 与飞书 CLI 保持直连。它会验证 App Server 拥有权、Scheduled Task watchdog 和同一 activation 的新鲜 heartbeat；失败时撤销 Bridge-owned pointer，不继续打开 Desktop。

隔离的 `-Proxy` 模式需要能找到可直接启动的 Win32 Desktop 可执行文件。如果只安装了 packaged Desktop，启动器会安全停止，不会修改系统或用户全局代理；packaged Desktop 仍可使用默认直连模式。

Desktop 打开后运行：

```powershell
.\status-bridge.ps1
.\doctor.ps1 -RequireRunning -RequireDesktopRelay
```

然后进行验收：

1. 在目标 Codex 任务中使用 `$feishu-session-bind` 创建或复用只含当前用户与 Bot 的专属绑定群。初次安装不需要 Bot 私聊或 `/add`；`/add` 只是以后的可选入口。
2. 分别从绑定群和 Desktop 的同一任务发送 Prompt，确认两端都进入同一 Session，且最终回答返回群。
3. 让 Codex 最终回答引用一个不超过 30 MB 的本地文件，确认飞书收到可点击的原生附件。
4. 在绑定群连续上传两个小型普通附件，确认它们被暂存，`/status` 显示正确累计数，其他命令不会消费。再发送普通文字 Prompt，确认 Codex 在一次输入中能读取全部附件。
5. 没有附件草稿时单独发送一张图片，确认图片立即进入 Codex 原生视觉输入。再测试 `/attachments clear`，确认放弃草稿不会启动 Turn。
6. 最后再运行 `status-bridge.ps1` 与严格 Doctor。

## 日常命令

```powershell
.\status-bridge.ps1
.\stop-bridge.ps1
.\start-bridge.ps1
.\doctor.ps1 -RequireRunning
```

Bridge supervisor 会在进程意外退出后重启 Bridge。启用 Desktop relay 后，当前用户登录时启动 `FeishuCodexBridge-DesktopRelay-Watchdog`，随后每 3 秒检查共享 App Server。监听器消失时它先移除 Bridge 自己写入的 pointer，再尝试恢复；只有进程与监听器重新验证后才恢复 pointer。需要彻底撤销该集成时运行 `configure-codex-desktop-relay.ps1 -Disable`，再完整重启 Desktop；官方脚本不会删除用户自建守护。

## 更新

升级器只接受明确的 release tag。它会先拒绝任何未提交或未跟踪的改动，再优雅停止 Bridge，并在本机运行目录备份 `bridge.config.json`、DPAPI 密文、Session 设置、待提交附件草稿、队列、输入账本和投递状态。目标版本的依赖安装、安装脚本或健康检查失败时，会自动切回原提交、恢复备份并重新启动原版本；不会执行 `git reset`、`git clean` 或覆盖用户代码。

从 `v0.2.0-beta.1` 开始，后续升级使用：

```powershell
.\update.ps1 -Version <目标 release tag>
```

Bridge 若在升级前运行，成功后会自动重启并执行 `doctor.ps1 -RequireRunning`；原本停止则保持停止。升级前若 Desktop relay 已启用，`doctor.ps1 -RequireDesktopRelay` 也会成为升级成功条件。也可加 `-StartBridge` 要求升级完成后启动。恢复备份会保留在本机运行目录中，确认新版本稳定后再自行归档或删除。

### 从 v0.2 启动故障恢复并升级

`v0.2.0-beta.1` 会直接持久化 `CODEX_APP_SERVER_WS_URL`，系统重启后若 App Server 没有恢复，Codex Desktop 可能报 `connect ECONNREFUSED 127.0.0.1:<port>` 并无法进入主界面。这条恢复路径不依赖 Desktop，可以直接在旧安装目录的 PowerShell 中执行：

```powershell
.\configure-codex-desktop-relay.ps1 -Disable
.\update.ps1 -Version v0.3.2-windows-rc.4 -StartBridge
.\launch-codex-desktop-with-relay.ps1
.\doctor.ps1 -RequireRunning -RequireDesktopRelay
```

第一条命令先恢复 Desktop 的可启动性。升级后仍要先询问用户直连或本机代理；上例是直连，用户明确选择代理时将第三条改为 `launch-codex-desktop-with-relay.ps1 -Proxy <loopback URL>`。运行启动器前完全退出 Desktop；若升级器因脏工作树或其他预检停止，pointer 仍保持禁用，用户数据不会被清理或覆盖。

### 已有自建守护的升级

激活器会只读识别可能指向 Codex App Server/relay 的自建进程、计划任务和 Windows 服务，但不会停止、删除、重命名或覆盖它们。官方 watchdog 使用独立任务名和单实例锁，并复用由配置中同一 Codex 可执行文件提供的已验证监听器。升级后先运行严格 Doctor；确认官方 watchdog heartbeat 与监听器所有权均通过，再自行决定是否撤销旧守护。无法可靠识别的任意自定义脚本也不会被自动删除，因此升级不会以“清理冲突”为由修改用户的守护实现。

`v0.1.0-beta.1` 尚未内置升级器。第一次升级到本版本时，在旧安装目录中运行以下固定-tag 引导；下载的脚本位于系统临时目录，不会写入旧工作树：

```powershell
$version = 'v0.2.0-beta.1'
$updater = Join-Path ([IO.Path]::GetTempPath()) 'feishu-codex-bridge-update.ps1'
Invoke-WebRequest "https://raw.githubusercontent.com/ninmon/feishu-codex-bridge/$version/update.ps1" -OutFile $updater
& $updater -InstallRoot (Get-Location).Path -Version $version
```

升级后运行 `git describe --tags --exact-match`、`.\status-bridge.ps1` 和 `.\doctor.ps1 -RequireRunning` 验证版本与实时连接。此版本无需为 Bridge 代码更新强制重启 Codex Desktop；只有 release notes 明确要求、共享 App Server 地址变化或 Desktop 环境检查失败时才完整重启。
