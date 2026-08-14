# Codex 安装代理协议

本文件供 Codex 在用户说“按照这个仓库帮我安装部署”时执行。目标是把当前 release 安装成 Windows 本机 Codex Session Relay，并以可验证结果交付；不能把浏览器授权、应用发布、管理员审批、安全输入或 Desktop 重启假装成已自动完成。

## 安全边界

- 先确认目标是 Windows，且用户明确授权安装本仓库；外部创建或修改飞书应用前再次取得用户确认。
- 不输出 App Secret、OAuth token、device code、App ID、open ID、chat ID、Codex task ID、`bridge.config.json` 内容或任务绝对 cwd。
- 不让用户把 App Secret 发进聊天。只启动 `setup-channel-secret.ps1` 的可见交互窗口。
- 不修改 `.codex-global-state.json` 或其他 Codex 全局状态来伪造 Project 归属。
- 不覆盖已有 `bridge.config.json`、环境变量或同名 Skill，除非已说明冲突并获得用户明确同意；只有此时才使用 `-ForceConfig`。
- 每个需人工完成的阶段都应暂停并等待用户确认，再做只读验证。

## 0. 固定版本与目标目录

如果当前目录不是本仓库，默认安装到：

```text
%LOCALAPPDATA%\FeishuCodexBridge\app
```

Beta 版本必须使用明确的 release tag `v0.3.1-beta.1`，不要从未知分支复制文件：

```powershell
git clone --branch v0.3.1-beta.1 --depth 1 https://github.com/ninmon/feishu-codex-bridge.git "$env:LOCALAPPDATA\FeishuCodexBridge\app"
Set-Location "$env:LOCALAPPDATA\FeishuCodexBridge\app"
git describe --tags --exact-match
```

若目录已存在，先只读检查 `git remote -v`、`git status --short`、当前 tag 和本机配置。不要清理或重置用户改动。

## 1. 依赖预检与安装

检查：

```powershell
git --version
node --version
npm --version
```

Node.js 必须不低于 22.13。缺少 Git 或 Node.js 时，说明将发生的软件安装并取得同意，然后使用：

```powershell
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
```

重新打开 shell 后执行：

```powershell
npm ci
.\lark-cli.ps1 --version
```

不要全局安装未锁定版本来替代仓库依赖。

## 2. 飞书应用

先用只读命令判断是否已有匹配且可用的专用应用：

```powershell
.\lark-cli.ps1 auth status --json --verify
```

不得把完整 JSON 转发给用户，只总结 Bot/User 是否可用、是否验证成功、是否缺 Feed 或长回答文档 scope。

如果没有应用，询问用户是否允许飞书 CLI 创建一个专用于当前电脑 Codex Bridge 的企业自建应用。确认后，后台启动：

```powershell
.\lark-cli.ps1 config init --new --brand feishu --lang zh_cn
```

从增量输出取得验证 URL，用仓库 CLI 生成相对路径二维码并显示 URL 与图片：

```powershell
.\lark-cli.ps1 auth qrcode "<verification URL>" --output feishu-app-setup.png
```

然后暂停，等待用户完成浏览器页面。遇到 CAPTCHA、MFA 或管理员审批时始终由用户处理。

若用户选择已有专用应用，让用户在可见 PowerShell 中运行 `lark-cli.ps1 config init` 并自行输入凭据；Agent 不接触 App Secret。

接着要求用户按照 `docs/FEISHU_APP_SETUP.md` 在开发者后台启用 Bot、添加权限、订阅 `im.message.receive_v1`、设置可用范围并发布版本。用户说“已发布”后，用 `auth status --json --verify` 验证 Bot；不能仅凭口头确认判定完成。

## 3. 用户 Feed 与长回答文档 OAuth

若 `im:feed_group_v1:read`、`im:feed_group_v1:write`、`docx:document:create` 或 `docx:document:write_only` 缺失：

1. 执行 `auth login --scope ... --no-wait --json`。
2. 保存返回的短期 device code，不在回复中显示。
3. 用 `auth qrcode` 生成 PNG，向用户显示验证 URL 与二维码并暂停。
4. 用户确认后，用 `auth login --device-code ... --json` 完成授权。
5. 再次运行 `auth status --json --verify`，只报告验证结论。

## 4. 生成配置并安装 Skill

Bot 和 User 身份均验证成功后执行：

```powershell
.\install.ps1
```

脚本应自动发现必要标识，安装 `$HOME\.agents\skills\feishu-session-bind`，并设置 `FEISHU_CODEX_BRIDGE_HOME`。新安装不得在 Bridge 和共享 App Server 验证成功前设置 `CODEX_APP_SERVER_WS_URL`。若失败，先报告具体检查项；不要打印配置或身份字段。

## 5. 安全录入 App Secret

启动用户可见的交互窗口：

```powershell
Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"$PWD\setup-channel-secret.ps1")
```

告诉用户只在该窗口粘贴 App Secret。暂停到用户确认窗口显示 DPAPI 保存成功，再运行 `doctor.ps1` 验证“存在且当前用户可解密”；不读取明文。

## 6. 启动、Desktop 重启与验收

```powershell
.\start-bridge.ps1
.\configure-codex-desktop-relay.ps1
.\doctor.ps1 -RequireRunning -RequireDesktopRelay
```

必须确认 `configure-codex-desktop-relay.ps1` 的顺序检查全部成功：共享 App Server 已验证、连续 watchdog 任务已安装、pointer 已写入且相同 activation 的 ready heartbeat 已到达。若任一步骤失败，脚本必须撤销 Bridge-owned pointer，使 Desktop 保持 fail-open；不得手工补写环境变量。

若检查通过，要求用户完全退出并重新打开 Codex Desktop，使它连接 Bridge 启动的同一个本机 App Server。此步骤需要用户授权；不要强制结束用户进程。说明连续 watchdog 会在 Windows 登录后常驻，每 3 秒检查一次；监听器消失时先移除 Bridge 拥有的 pointer，再尝试恢复 App Server，验证成功后才恢复 pointer。

Desktop 重启后再执行一次：

```powershell
.\status-bridge.ps1
.\doctor.ps1 -RequireRunning -RequireDesktopRelay
```

最后引导用户完成两项真实验收：

1. 飞书私聊 Bot 发送 `/add`，选择 Project/“独立”和现有任务；若测试 Project 为空，确认向导提供重新扫描、返回列表和新建任务。随后确认自动建群、命名、绑定并应用 `{主机名}-Codex` 标签。
2. 分别从飞书群和 Codex Desktop 发送 Prompt；确认两端进入同一任务，最终回答均返回群。
3. 让最终回答引用一个不超过 30 MB 的本地文件；确认最终回答后出现可点击的群内原生附件，且附件消息不额外 @owner。

只有上述验证成功才报告部署完成。报告中列出版本、Bridge connected 状态、绑定数量和仍需注意的 Beta 限制，不列出任何身份标识或绝对任务路径。

## 7. 升级已有安装

用户明确要求升级时，先只读检查安装目录的 `git remote -v`、`git status --short`、当前精确 tag、`status-bridge.ps1` 和 `doctor.ps1`。不要创建或修改飞书应用，也不要重新索取 App Secret。若工作树有改动，停止并请用户先保存；不得 reset、clean、stash 或覆盖。

若当前为 `v0.2.0-beta.1` 且 Codex Desktop 报 `ECONNREFUSED 127.0.0.1:<port>`，先确认该端口确实没有监听。随后运行旧版自带的 `configure-codex-desktop-relay.ps1 -Disable` 解除会阻塞 Desktop 的 pointer，再继续固定 tag 升级；升级成功并启动 Bridge 后，必须运行新版 `configure-codex-desktop-relay.ps1` 重新激活连续 watchdog。不要要求用户先把已故障的 Desktop 启动起来。

升级前同时只读检查是否存在名称或命令行中指向 Codex App Server、relay、watchdog/guardian 的自建进程、计划任务或 Windows 服务。不得停止、删除、改名或覆盖它们。新版激活器也会给出不含名称和命令行的类别提示，并与自建守护并存；只有新版严格 Doctor 通过后，才建议用户另行审阅是否撤销旧守护。

已有 `update.ps1` 时，只运行固定目标版本：

```powershell
.\update.ps1 -Version <目标 release tag>
```

若从不含升级器的 `v0.1.0-beta.1` 首次升级到 `v0.2.0-beta.1`，按照 `docs/INSTALL.md#更新` 从该固定 tag 的 raw URL 下载 `update.ps1` 到系统临时目录，并用 `-InstallRoot` 指向现有安装目录。不要从 `main` 或未固定分支下载脚本。

升级器负责停止/恢复 Bridge、创建本机恢复备份、切换 tag、运行 `npm ci`、保留原配置和 DPAPI 密文、更新 Skill，并在失败时回滚。若升级前 Desktop relay 已启用，升级器必须把 `doctor.ps1 -RequireDesktopRelay` 作为成功条件。成功后核对 `git describe --tags --exact-match`、`status-bridge.ps1` 与 `doctor.ps1 -RequireRunning -RequireDesktopRelay`；只报告版本和检查结论，不输出恢复目录、配置、身份标识或任务路径。pointer 未变化且 Desktop 已正常运行时无需仅因代码升级而重启；若升级前为恢复启动而执行了 `-Disable`，重新激活后必须让用户完整重启一次 Desktop。
