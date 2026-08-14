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
git clone --branch v0.3.0-beta.1 --depth 1 https://github.com/ninmon/feishu-codex-bridge.git
Set-Location .\feishu-codex-bridge
npm ci
```

仓库锁定了兼容版本的飞书 CLI 和 Channel SDK；日常操作使用 `lark-cli.ps1`，无需全局安装飞书 CLI。

当前 Beta release 暂由贡献者 fork 托管，并通过上游草稿 PR 合并到 `Jiakai-Zhang/feishu-codex-bridge`；固定 tag 的内容与该 PR 的已验证提交一致。

## 3. 创建并发布专用飞书应用

按照 [飞书应用配置](FEISHU_APP_SETUP.md) 完成以下事项：

1. 创建一个只用于本机 Codex Bridge 的企业自建应用。
2. 启用机器人，配置权限与 `im.message.receive_v1` 事件。
3. 创建并发布一个应用版本，将可用范围包含当前用户。
4. 完成飞书 CLI 的 Bot 身份配置和当前用户的 Feed 标签 OAuth 授权。

权限或事件变更后必须重新发布版本；仅在开发者后台保存草稿不会让线上机器人获得新能力。

## 4. 生成本机配置

飞书 CLI 的 Bot 与用户身份均已验证后执行：

```powershell
.\install.ps1
```

脚本会：

- 验证 Node.js、Codex App Server 能力和锁定依赖；
- 从已验证的飞书 CLI 身份读取必要标识，但不在终端显示它们；
- 生成被 Git 忽略的 `bridge.config.json`；
- 安装用户级 `$feishu-session-bind` Skill；
- 设置 `FEISHU_CODEX_BRIDGE_HOME`。新安装此时**不会**设置 Codex Desktop 共享 App Server 地址。

已有本机配置时脚本默认保留，不会覆盖。只有确认要替换后才使用 `-ForceConfig`。

## 5. 安全保存 App Secret

运行：

```powershell
.\setup-channel-secret.ps1
```

在独立窗口中粘贴 App Secret。输入不可见，脚本只写入由当前 Windows 用户 DPAPI 加密的数据，不把明文写入仓库、配置或日志。不要把 App Secret 发给 Codex 或粘贴到聊天中。

## 6. 启动与验证

```powershell
.\start-bridge.ps1
.\configure-codex-desktop-relay.ps1
.\doctor.ps1 -RequireRunning -RequireDesktopRelay
```

`configure-codex-desktop-relay.ps1` 会先确认共享 App Server 已监听，再安装当前用户登录恢复任务，最后才写入 `CODEX_APP_SERVER_WS_URL`。任何前置步骤失败都会保留 Desktop 的原启动方式。全部检查通过后，**完全退出并重新打开 Codex Desktop**。只关闭一个窗口不一定会结束后台进程；需要确保新进程读取新的环境变量。

然后进行验收：

1. 在飞书中私聊该应用机器人，发送 `/add`。
2. 按编号选择 Codex Project（或“独立”）和任务。
3. Bridge 自动创建 `{Project名}/{任务名}` 或 `独立/{任务名}` 群，并应用 `{主机名}-Codex` 标签。
4. 在只有你和 Bot 的新群中直接发普通消息，无需 `@Bot`；确认 Prompt 进入绑定任务且最终回答返回群。
5. 在 Codex Desktop 中发送一次 Prompt；确认其最终回答也返回同一群。
6. 让 Codex 最终回答引用一个不超过 30 MB 的本地文件；确认最终回答后出现可点击的群内原生附件。本地图片不超过 10 MB 时应直接内嵌，超过 10 MB 时应降级为附件。
7. 在绑定群发送 `/settings` 查看并修改当前 Session；使用 `/settings mention on|off` 控制最终回答是否 @你。公开进度始终不 @。在 CLI Bot 私聊发送 `/settings` 可修改后续新绑定的默认值。确认全新安装显示 `queue + 公开进度开启 + 最终回答提醒开启`。新绑定会复制创建当时的默认快照，已有群不会跟随全局默认变化。

也可以在目标 Codex 任务里说“帮我把这个任务绑定到飞书”，让 `$feishu-session-bind` Skill 创建或复用群。

## 日常命令

```powershell
.\status-bridge.ps1
.\stop-bridge.ps1
.\start-bridge.ps1
.\doctor.ps1 -RequireRunning
```

Bridge supervisor 会在进程意外退出后重启 Bridge。启用 Desktop relay 后，当前用户每次登录时，`FeishuCodexBridge-DesktopRelay` 任务会先恢复共享 App Server，再恢复 Bridge；若 App Server 无法恢复，它会移除 Bridge 自己写入的 Desktop relay pointer，使 Codex Desktop 回退到内置 App Server。需要彻底撤销该集成时运行 `configure-codex-desktop-relay.ps1 -Disable`，再完整重启 Desktop。

## 更新

升级器只接受明确的 release tag。它会先拒绝任何未提交或未跟踪的改动，再优雅停止 Bridge，并在本机运行目录备份 `bridge.config.json`、DPAPI 密文、Session 设置、队列、输入账本和投递状态。目标版本的依赖安装、安装脚本或健康检查失败时，会自动切回原提交、恢复备份并重新启动原版本；不会执行 `git reset`、`git clean` 或覆盖用户代码。

从 `v0.2.0-beta.1` 开始，后续升级使用：

```powershell
.\update.ps1 -Version <目标 release tag>
```

Bridge 若在升级前运行，成功后会自动重启并执行 `doctor.ps1 -RequireRunning`；原本停止则保持停止。也可加 `-StartBridge` 要求升级完成后启动。恢复备份会保留在本机运行目录中，确认新版本稳定后再自行归档或删除。

`v0.1.0-beta.1` 尚未内置升级器。第一次升级到本版本时，在旧安装目录中运行以下固定-tag 引导；下载的脚本位于系统临时目录，不会写入旧工作树：

```powershell
$version = 'v0.2.0-beta.1'
$updater = Join-Path ([IO.Path]::GetTempPath()) 'feishu-codex-bridge-update.ps1'
Invoke-WebRequest "https://raw.githubusercontent.com/ninmon/feishu-codex-bridge/$version/update.ps1" -OutFile $updater
& $updater -InstallRoot (Get-Location).Path -Version $version
```

升级后运行 `git describe --tags --exact-match`、`.\status-bridge.ps1` 和 `.\doctor.ps1 -RequireRunning` 验证版本与实时连接。此版本无需为 Bridge 代码更新强制重启 Codex Desktop；只有 release notes 明确要求、共享 App Server 地址变化或 Desktop 环境检查失败时才完整重启。
