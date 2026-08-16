# macOS 安装指南（Codex Session Relay Beta）

本移植把一个飞书群固定绑定到一个本机 Codex 任务，并让飞书与 ChatGPT/Codex Desktop 复用同一个 Codex App Server。macOS 运行层使用 Keychain 保存 Channel Secret，使用当前用户的 `launchd` LaunchAgent 启动 Bridge、App Server 和 Desktop relay watchdog。

> 当前 macOS 代码以 `7c8668e` 为上游基线；附件 PR #12 已包含在该基线中。macOS 平台实现位于 `src/runtime/platform/macos/`，共享业务代码与 Windows 使用同一领域目录。它尚不是上游固定 release。Codex App Server 的 WebSocket listener 仍是实验性能力，不建议当作无人值守的生产服务。

如果要把全新 Mac 的部署交给已登录的 Codex Desktop 执行，直接复制[给 Codex 的 macOS 全新安装 Prompt](INSTALL_MACOS_PROMPT.md)。

## 1. 系统要求

- macOS 13 或更新版本，Apple Silicon 或 Intel；
- 已安装并登录 ChatGPT/Codex Desktop；
- Git；
- Node.js `>=22.13.0`。若 Desktop 自带可用的 Node，脚本会自动发现，无需全局安装；
- 飞书企业自建应用，已启用 Bot 和长连接事件。

先执行只读预检：

```bash
uname -m
git --version
./macos-node.sh doctor
```

在还没有本机配置时，最后一条报告配置缺失是预期结果。

## 2. 安装锁定依赖

```bash
./bootstrap.sh
./lark-cli.sh --version
```

`bootstrap.sh` 使用发现到的 Node/npm 执行 `npm ci`，只安装 `package-lock.json` 锁定的飞书 CLI 和 Channel SDK，不依赖全局飞书 CLI。

## 3. 创建或绑定飞书应用

先只读检查现有本机身份：

```bash
./lark-cli.sh auth status --json --verify
```

完整 JSON 包含应用和用户标识，不要粘贴到聊天、Issue 或日志中。

如果需要创建新应用，先取得用户对这项外部变更的明确同意，再运行：

```bash
./lark-cli.sh config init --new --brand feishu --lang zh_cn
```

如果使用已有的专用应用：

```bash
./lark-cli.sh config init
```

两种情况下都由用户在本机可见终端或浏览器中完成 App Secret、CAPTCHA/MFA 和管理员审批；不要把凭据发到 Codex 聊天。

按[飞书自建应用配置](FEISHU_APP_SETUP.md)完成：

1. 启用 Bot；
2. 添加消息、群、资源、Feed 和文档权限；
3. 用长连接订阅 `im.message.receive_v1`；
4. 将当前用户加入可用范围，创建并发布应用版本。

用户身份还需授予：

```bash
./lark-cli.sh auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only"
```

授权后再运行 `auth status --json --verify`，只确认 Bot 和 User 均为 available/verified，且上述四个 scope 不再缺失。

## 4. 生成本机配置

```bash
./install.sh
```

安装器会：

- 发现 Node 和 ChatGPT/Codex Desktop 内的 `codex` 可执行文件；
- 从已验证的飞书 CLI 身份中读取必要标识，但不把它们输出到终端；
- 在仓库根目录生成被 Git 忽略、权限为 `0600` 的 `bridge.config.json`；
- 将实际后台运行所需的脚本、锁定依赖和私有配置副本安装到 `~/Library/Application Support/FeishuCodexBridge/installation`，避免 `launchd` 直接访问受 macOS 隐私保护的 Desktop/Documents 仓库目录；
- 安装 `$HOME/.agents/skills/feishu-session-bind`；
- 生成当前用户的 LaunchAgent，但在第一次显式启动前保持 Bridge、App Server 和 relay 禁用。

现有配置默认保留。不要在未审核本机数据的情况下使用 `--force-config`。

## 5. 将 Channel Secret 存入 Keychain

由用户在本机可见 Terminal 中运行：

```bash
./setup-channel-secret.sh
```

macOS `security` 会显示隐藏输入提示。用户只在这里粘贴 App Secret。密钥保存在当前用户 Keychain，不写入命令参数、配置、仓库或日志。

如果移动了仓库目录，Keychain service 标识会随安装路径改变，需要在新位置重新执行这一步。

## 6. 启动与 Desktop relay

```bash
./start-bridge.sh
./configure-codex-desktop-relay.sh
./doctor.sh --require-running --require-desktop-relay
```

`configure-codex-desktop-relay.sh` 只在确认 App Server 是本安装启动的进程、`/readyz` 健康检查通过、Bridge 已连接 Channel 后，才会通过 `launchctl setenv` 设置 `CODEX_APP_SERVER_WS_URL`。watchdog 每 3 秒验证一次；监听器失效或健康检查失败时先移除本安装拥有的 pointer，恢复成功后才重新设置。

严格 Doctor 通过后，由用户完全退出 ChatGPT/Codex Desktop，再从终端执行：

```bash
./launch-codex-desktop-with-relay.sh
./doctor.sh --require-running --require-desktop-relay --require-desktop-attached
```

macOS 上从 Dock 或自动恢复启动的 GUI 进程不一定会继承后设置的 `launchctl` 环境。该入口使用系统 `open --env` 把经验证的本机 relay 地址直接注入 Desktop，且拒绝在 Desktop 尚未完全退出时启动第二个实例。安装脚本不会强制结束 Desktop 进程。

启动器默认使用直连：

```bash
./launch-codex-desktop-with-relay.sh
```

即使上一次使用了代理，不带参数的启动也会清除保存的 Desktop 代理，验证共享 App Server 不再带 HTTP/HTTPS/ALL proxy 环境，再以直连方式打开 Desktop。`--no-proxy` 仍作为兼容别名保留，但已不需要使用。

只有需要代理时才显式添加 `--proxy`：

```bash
./launch-codex-desktop-with-relay.sh --proxy http://127.0.0.1:7897
```

`--proxy` 只接受带明确端口、无认证的 loopback URL。代理环境只会应用到 Desktop 与共享 Codex App Server；Feishu Bridge、Channel 和 watchdog 仍使用直连。首次应用、代理变更或切回直连时，入口会在 Desktop 已完全退出的前提下重载共享 App Server，验证新进程的代理状态后才打开 Desktop。

## 7. 真实验收

1. 在飞书中私聊 Bot 发送 `/add`，选择 Project/“独立”与现有 Codex 任务；
2. 确认 Bridge 自动创建只有当前用户和 Bot 的绑定群；
3. 在绑定群发一条 Prompt，确认 Codex Desktop 中的同一任务收到并执行，最终答案返回群；
4. 在 Desktop 的同一任务再发一条 Prompt，确认最终答案也返回飞书群；
5. 从飞书上传一张小图和一个普通小文件，确认 Codex 能读取；让 Codex 最终回答引用一个本地文件，确认飞书收到原生附件；
6. 再运行 `./status-bridge.sh` 和严格 Doctor，确认 Channel、App Server、watchdog 和 Desktop pointer 仍全部正常。

只有上述实测完成才算部署成功。

## 日常运维

```bash
./status-bridge.sh
./doctor.sh --require-running
./stop-bridge.sh
./start-bridge.sh
```

`./stop-bridge.sh` 持久禁用 Bridge 和 Desktop relay，但保留共享 App Server。如果也要停止 App Server：

```bash
./stop-bridge.sh --all
```

完全撤销 Desktop relay：

```bash
./configure-codex-desktop-relay.sh --disable
```

然后完全重启 Desktop。再次执行 `start-bridge.sh` 会恢复被官方脚本禁用的 LaunchAgent。

LaunchAgent 位于 `$HOME/Library/LaunchAgents`，标签为：

- `com.feishu-codex-bridge.environment`
- `com.feishu-codex-bridge.app-server`
- `com.feishu-codex-bridge.bridge`
- `com.feishu-codex-bridge.desktop-relay`

运行日志位于配置 workspace 的 `work/feishu-codex-bridge` 与 `$HOME/Library/Logs/FeishuCodexBridge`。日志可能包含本机运行信息，不要整份粘贴到公开渠道。

## 更新固定版本

macOS 升级器只接受明确的语义化 release tag：

```bash
./update.sh --version <目标 release tag>
```

运行更新前必须完全退出 ChatGPT/Codex Desktop，并从独立的 macOS Terminal 执行上述命令。不得从正在使用该共享 App Server 的 Codex 任务中执行自更新。升级器会在停止任何服务之前检查这两项条件，检测到活跃 Codex 任务、Desktop 进程或 Desktop 内嵌 App Server 时会直接拒绝更新。

升级器会验证 origin 与目标 tag，拒绝任何已跟踪或未跟踪的工作树改动，优雅停止正在运行的 Bridge，并在本机 runtime 中创建权限受限的恢复备份。备份包括配置、绑定请求、Session 设置、队列、输入账本、投递状态、长回答/流式卡状态、附件草稿与入站附件缓存。Keychain Secret 留在原有安全存储中，不会读取或重新索取。

目标版本的依赖安装、安装器或 Doctor 失败时，脚本会切回原提交、恢复备份、重新生成 LaunchAgent，并恢复升级前的 Bridge/relay 运行状态。不会执行 `git reset`、`git clean` 或 `git stash`。目标 tag 必须已包含 macOS 脚本；Windows `update.ps1` 不得在 macOS 上使用。
