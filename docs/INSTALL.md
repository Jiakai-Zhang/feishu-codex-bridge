# Windows 安装指南（Codex Session Relay Beta）

本版本把一个飞书群绑定到一个 Codex 任务。群内普通消息进入该任务，Codex 最终回答（包括从 Desktop 发起的回答）同步回群；支持调整方向、排队、停止、状态、模型、Plan 与 Goal。

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
git clone --branch v0.1.0-beta.1 --depth 1 https://github.com/ninmon/feishu-codex-bridge.git
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
- 设置 `FEISHU_CODEX_BRIDGE_HOME` 与 Codex Desktop 共享 App Server 地址。

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
.\doctor.ps1 -RequireRunning
```

全部检查通过后，**完全退出并重新打开 Codex Desktop**。只关闭一个窗口不一定会结束后台进程；需要确保新进程读取 `CODEX_APP_SERVER_WS_URL`。

然后进行验收：

1. 在飞书中私聊该应用机器人，发送 `/add`。
2. 按编号选择 Codex Project（或“独立”）和任务。
3. Bridge 自动创建 `{Project名}/{任务名}` 或 `独立/{任务名}` 群，并应用 `{主机名}-Codex` 标签。
4. 在只有你和 Bot 的新群中直接发普通消息，无需 `@Bot`；确认 Prompt 进入绑定任务且最终回答返回群。
5. 在 Codex Desktop 中发送一次 Prompt；确认其最终回答也返回同一群。

也可以在目标 Codex 任务里说“帮我把这个任务绑定到飞书”，让 `$feishu-session-bind` Skill 创建或复用群。

## 日常命令

```powershell
.\status-bridge.ps1
.\stop-bridge.ps1
.\start-bridge.ps1
.\doctor.ps1 -RequireRunning
```

Bridge supervisor 会在进程意外退出后重启 Bridge；Windows 注销或重启后仍需再次运行 `start-bridge.ps1`。

## 更新

Beta 期间优先切换到明确的 release tag，不要直接覆盖本机配置：

```powershell
git fetch --tags origin
git checkout v0.1.0-beta.1
npm ci
.\install.ps1
.\doctor.ps1
```

升级完成后按提示完整重启 Codex Desktop。
