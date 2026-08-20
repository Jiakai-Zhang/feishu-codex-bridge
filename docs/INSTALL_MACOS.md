# macOS 安装指南（Codex Session Relay Beta）

本移植把一个飞书群固定绑定到一个本机 Codex 任务，并让飞书与 ChatGPT/Codex Desktop 复用同一个 Codex App Server。macOS 运行层使用 Keychain 保存 Channel Secret，使用当前用户的 `launchd` LaunchAgent 启动 Bridge、App Server 和 Desktop relay watchdog。

> 当前 macOS 私有固定候选版为 `v0.4.0-macos-rc.8`。它保留 rc.7 的完整多用户、Session 权限和可见前台升级能力，并修复失败回滚到旧 checkout 后无法按原网络模式重开 Desktop 的兼容问题；安装阶段会进行一次幂等重试并保留安全诊断。Desktop 身份由 Bundle metadata、OpenAI 签名和规范可执行路径共同确认；Keychain、附件与 launchd relay 状态保持不变。macOS 平台实现位于 `src/runtime/platform/macos/`，共享业务代码与 Windows 使用同一领域目录。Codex App Server 的 WebSocket listener 仍是实验性能力，不建议当作无人值守的生产服务。

如果要把全新 Mac 的部署交给已登录的 Codex Desktop 执行，直接复制[给 Codex 的 macOS 全新安装 Prompt](INSTALL_MACOS_PROMPT.md)。
已有安装可复制[给 Codex 的 macOS 极简升级协议](UPGRADE_MACOS_PROMPT.md)入口；异常安全停点仍按本页更新规则执行。

## 1. 系统要求

- macOS 13 或更新版本，Apple Silicon 或 Intel；
- 已安装并登录 ChatGPT/Codex Desktop；
- Git；
- Node.js `>=22.13.0`。若 Desktop 自带可用的 Node，脚本会自动发现，无需全局安装；
- 可创建飞书企业自建应用的组织账号；应用可在安装过程中通过仓库脚本配置。

如果由 Codex Desktop 在当前对话中执行安装，在运行任何命令前，先在输入框下方的权限菜单中将当前对话设为“完全访问（Full access）”。按 [OpenAI Codex 沙盒说明](https://developers.openai.com/codex/sandboxing)，该模式取消当前 Agent 的文件系统与网络沙盒边界。Bridge 还需要从当前 macOS 用户的 Keychain 读取 Channel Secret；实际部署中，沙盒对话内的 `security` 子进程可能无法读取已存在的项目，并造成 Doctor 假阴性。不要修改 Codex 全局配置来代替这个当前对话权限。

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

## 3. 创建并配置飞书应用

全新 Mac 使用一个新的专用应用。应用展示名称必须与运行 Codex Desktop 的当前 Mac 系统电脑名称完全一致。先只读取得名称：

```bash
/usr/sbin/scutil --get ComputerName
```

保留名称的精确大小写、空格和字符。若结果为空，先由用户在 macOS“系统设置 > 通用 > 共享”中设置。创建应用、添加权限/事件以及发布版本都属于外部变更；由 Agent 执行安装时，必须先向用户说明完整变更范围和应用名称，并取得一次明确批准。

批准后运行：

```bash
./lark-cli.sh config init --new --brand feishu --lang zh_cn
```

用户使用实际部署 Bridge 的飞书组织账号完成浏览器认证、CAPTCHA/MFA 和应用创建，并在创建页把“应用名称”设为上面取得的系统电脑名称。若创建流程没有名称输入框，创建后只需在“基础信息”修改这一项，确认完全一致再继续。

Lark CLI 会输出一次性 verification URL。无论系统是否自动弹出浏览器，安装执行者都应把这个 URL 原样作为可点击备用链接交给用户，然后等待认证完成。只转交 verification URL，不输出 device code、原始 JSON、App ID、Secret 或 Token；不要重跑命令使已交付的 URL 失效。

`config init --name` 设置的是 Lark CLI 本地 profile 名称，不是飞书应用展示名称，不得用它代替页面中的应用名称。若飞书拒绝当前电脑名称，暂停让用户决定是否先修改 macOS 电脑名称，不要自行追加后缀。认证临时凭据、App ID 与身份标识不得粘贴到聊天、命令参数或日志。

应用创建完成后，立即由用户在本机可见 Terminal 中运行：

```bash
./setup-channel-secret.sh
```

`setup-channel-secret.sh` 不依赖 `bridge.config.json`，因此可以在安装器生成配置前执行。macOS `security` 会显示隐藏输入提示；用户只在这里粘贴 Channel App Secret。密钥保存在当前用户 Keychain，不写入命令参数、配置、仓库或日志。如果之后移动仓库目录，需要在新位置重新运行该脚本。

然后运行一次应用模板配置：

```bash
./configure-feishu-app.sh
```

该脚本从本机已验证的 Lark CLI 配置读取应用身份，通过随机 loopback 跳转打开飞书官方模板确认页，不会把 App ID 打印到终端或传给 `open` 的进程参数。脚本会在尝试自动打开浏览器前，先输出一个最多两分钟有效、不含 App ID 的临时本机 URL。如果浏览器未弹出，直接在同一台 Mac 上打开这个 URL；超时后重跑脚本获取新链接。不要输出最终飞书目标 URL。用户在一个页面核对并确认 Bridge 所需的 7 项应用/Bot 权限、4 项用户权限和 `im.message.receive_v1`；完整清单与手工故障回退见[飞书自建应用配置](FEISHU_APP_SETUP.md)。

Lark CLI 创建的新应用通常已默认启用机器人能力、长连接和 `im.message.receive_v1`。正常流程不要再逐页重复设置这些默认项。若飞书要求可用范围、版本发布或管理员审批，将可用范围限制为当前安装用户，由用户本人提交，并等待状态明确生效。

再完成当前用户 OAuth：

```bash
./lark-cli.sh auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only"
./verify-feishu-app.sh
```

浏览器授权由用户本人确认。`verify-feishu-app.sh` 只输出安全状态摘要，不输出 App ID、open ID 或原始 CLI 数据。所有 macOS 飞书 CLI 入口都会从子进程环境中移除 Desktop 的 HTTP/HTTPS/ALL proxy 变量，确保身份和事件校验继续走飞书直连，不会因为当前 Codex 任务继承了 Desktop 代理而产生假阴性。只有 `ok=true`，且应用、Bot、用户身份、四项用户 scope、消息事件发布状态和事件所需权限全部通过，才能继续。若校验失败，只修复摘要指出的项目；不要把 `auth status --json --verify` 或 event dry-run 的完整 JSON 粘贴到聊天、Issue 或日志。

OAuth 命令同样会输出 verification URL。自动打开失败时，使用 CLI 当次输出的原样 URL，不输出 device code 或原始 JSON，不重新发起授权使原 URL 失效。

## 4. 生成本机配置

第 2 节已完成锁定依赖安装，因此运行：

```bash
./install.sh --skip-dependency-install
```

安装器会：

- 发现 Node 和 ChatGPT/Codex Desktop 内的 `codex` 可执行文件；
- 从已验证的飞书 CLI 身份中读取必要标识，但不把它们输出到终端；
- 在仓库根目录生成被 Git 忽略、权限为 `0600` 的 `bridge.config.json`；
- 将实际后台运行所需的脚本、锁定依赖和私有配置副本安装到 `~/Library/Application Support/FeishuCodexBridge/installation`，避免 `launchd` 直接访问受 macOS 隐私保护的 Desktop/Documents 仓库目录；
- 安装 `$HOME/.agents/skills/feishu-session-bind`；
- 生成当前用户的 LaunchAgent，但在第一次显式启动前保持 Bridge、App Server 和 relay 禁用。

现有配置默认保留。不要在未审核本机数据的情况下使用 `--force-config`，也不要手工编辑或输出 `bridge.config.json`。

## 5. 可选多用户 Project 目录

未执行本节时，Bridge 继续保持 Owner-only，与旧 macOS 安装完全兼容。只有明确要在这台 Mac 上登记多个飞书用户时，才由 Bridge Owner 在本机可见的交互式 Terminal 中运行：

```bash
./setup-project-root.sh
```

该脚本不接受路径参数，会在 stdin 中交互询问一个绝对 Project 根目录和 Owner 的一级目录名。不得把绝对路径放入聊天、命令参数、日志、文档或 Git。一旦启用，自动流程不会把该根目录或已分配的成员目录改指到其他位置。

如果在首次启动前完成设置，可直接继续下一节。已运行的安装则需用官方入口停止并重新启动 Bridge，才会载入新权限状态。随后 Owner 可在 Bot 私聊或已绑定群发送一张飞书用户名片，并按 Bot 提示回复该成员的一级目录名；也可继续使用 `/members add <一级目录名> @成员`。新成员目录必须不存在或为空，飞书应用可用范围也必须包含该成员；发送名片不会自动邀请成员入群。

## 6. 启动与 Desktop relay

```bash
./start-bridge.sh
./configure-codex-desktop-relay.sh
./doctor.sh --require-running --require-desktop-relay
```

`configure-codex-desktop-relay.sh` 只在确认 App Server 是本安装启动的进程、`/readyz` 健康检查通过、Bridge 已连接 Channel 后，才会通过 `launchctl setenv` 设置 `CODEX_APP_SERVER_WS_URL`。watchdog 每 3 秒验证一次；监听器失效或健康检查失败时先移除本安装拥有的 pointer，恢复成功后才重新设置。

在重启 Desktop 前，安装执行者必须明确询问用户：

> 这台 Mac 上 Codex 访问服务是直连，还是需要本机代理？不需要代理请回复“直连”；需要代理请提供一个无认证、带明确端口的 loopback URL，例如 `http://127.0.0.1:7897`。

不得根据当前网络、Clash 是否运行或旧配置替用户推断。用户选择直连时使用：

```bash
./launch-codex-desktop-with-relay.sh
```

不带参数会清除保存的 Desktop 代理并验证共享 App Server 为直连；`--no-proxy` 仅作为兼容别名保留。

用户明确选择代理时使用：

```bash
./launch-codex-desktop-with-relay.sh --proxy http://127.0.0.1:7897
```

`--proxy` 只接受带明确端口、无认证的 loopback URL。代理环境只应用到 Desktop 与共享 Codex App Server；Feishu Bridge、Channel、watchdog 以及 Doctor 使用的飞书 CLI 校验仍使用直连。

代理状态发生变化时，启动器会保存选择、重启共享 App Server、等待其继承目标代理，再重新注册 relay watchdog。launchd 卸载必须确认旧注册已真正消失；新 watchdog 必须保持加载并发布新鲜的 `ready` 心跳。首次注册未驻留时，启动器会自动执行第二轮完整注册与 `kickstart`，两轮都失败才停止，且不会继续打开 Desktop。

选定命令后，先在仓库目录打开独立 Terminal，再由用户完全退出 ChatGPT/Codex Desktop，并从该 Terminal 运行唯一选定的启动命令。macOS 上从 Dock 或自动恢复启动的 GUI 进程不一定会继承 relay 环境；安装脚本不会强制结束 Desktop 进程。

Desktop 重新打开后运行：

```bash
./doctor.sh --require-running --require-desktop-relay --require-desktop-attached
```

## 7. 真实验收

1. 在当前 Codex 任务中使用安装后的 `$feishu-session-bind`，为本任务创建或复用只有当前用户与 Bot 的专属绑定群；
2. 以该 skill 返回的绑定群作为初次绑定结果，不要求用户先创建 Bot 私聊或发送 `/add`；`/add` 只是以后在已存在的 Bot 私聊或绑定群中的可选入口；
3. 在绑定群发一条 Prompt，确认 Codex Desktop 中的同一任务收到并执行，最终答案返回群；
4. 在 Desktop 的同一任务再发一条 Prompt，确认最终答案也返回飞书群；
5. 从飞书上传一张小图和一个普通小文件，确认 Codex 能读取；让 Codex 最终回答引用一个本地文件，确认飞书收到原生附件；
6. 再运行 `./status-bridge.sh` 和 `./doctor.sh --require-running --require-desktop-relay --require-desktop-attached`，确认 Channel、App Server、watchdog、Desktop pointer 与 Desktop attachment 仍全部正常。

如果已启用多用户 Project 目录，还必须验收：Owner 与一名已登记成员的 `/add` 列表互不泄露；成员只能在自己目录内新建 Project/任务；把成员加入绑定群后可共享该 Session，但不获得 Owner Project 列表；多人群的普通 Prompt 需 `@Bot` 或回复 Bot 且固定 queue，`/steer` 只允许 Session owner 或当前 Turn 初始发起者执行；两名成员的附件草稿互不混合。

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

多用户目录和成员的完整行为见 [Session Relay 参考](SESSION_RELAY.md#多用户目录与成员登记)。

## 更新固定版本

健康安装应使用可见的前台编排入口；它只接受明确的语义化 release tag：

```bash
./update.sh --foreground --version <目标 release tag>
```

默认从 `origin` 获取 tag。若现有安装保留公开 `origin`，并另行配置了精确私有镜像远端，则使用：

```bash
git remote get-url private
./update.sh --foreground --version <目标 private release tag> --remote private
```

`--remote` 只接受 `origin` 或 `private`；选中远端必须精确匹配受维护的公开仓库或 `ninmon/feishu-codex-bridge-private`，升级器不会改写 remote。私有仓库访问由已登录的 GitHub CLI/Git credential helper 提供，不得把访问 Token 写进 URL、命令参数或聊天。全新 v0.4 macOS 私有安装的 `origin` 已指向私有仓库，仍可省略 `--remote`。

前台入口会从精确目标 tag 提取目标 runtime，在独立、可见的 Terminal 中先执行严格 Doctor、工作树/tag 和网络模式预检。只有入口明确输出 `Foreground upgrade is ready` 后，用户才按 `⌘Q` 完全退出 Desktop；不要自行重开。升级器等待经 Bundle ID、OpenAI Team ID 与规范可执行路径共同验证的 Desktop 及其内嵌 App Server 自然退出，不按进程名广泛结束应用。完成事务升级和第一轮严格 Doctor 后，目标 tag 的前台 runtime 会再次验证原持久网络选择、活动 App Server 和 relay，再直接重开已锁定的 Desktop；这个恢复路径不依赖更新成功或回滚后的仓库启动器是否认识新参数，最后再完成包含 attachment 的严格 Doctor。

`./update.sh --version <tag>` 仍是底层事务入口，用于备份、checkout、安装、回滚和同版本自愈；它必须在 Desktop 已完全退出的独立 Terminal 中运行，并拒绝活跃 Codex 任务。正常 Codex 升级不应绕过前台入口直接调用它。公开仓库、上游仓库和受维护的私有发行仓库均使用相同的固定 tag 校验与安全更新流程。

升级器会验证选定 remote 与目标 tag，拒绝任何已跟踪或未跟踪的工作树改动，优雅停止正在运行的 Bridge，并在本机 runtime 中创建权限受限的恢复备份。备份包括配置、绑定请求、Session 设置、临时 Chat、多用户 Session access 状态、队列、输入账本、投递状态、长回答/流式卡状态、附件草稿与入站附件缓存。Keychain Secret 留在原有安全存储中，不会读取或重新索取。

目标版本的依赖安装、安装器或 Doctor 失败时，脚本会切回原提交、恢复备份、重新生成 LaunchAgent，并恢复升级前的 Bridge/relay 运行状态。安装器是事务且幂等的；单次失败会自动重试一次，两次都失败才进入回滚，并在可见 Terminal 和私有状态中留下脱敏后的失败类别。relay 已启用时，即使 Bridge 在同版本修复前停止，也会恢复 Bridge、relay 与 watchdog。Desktop 已退出后的前台失败还会尝试按原网络模式重开 Desktop。不会执行 `git reset`、`git clean` 或 `git stash`。目标 tag 必须已包含 macOS 前台升级契约；Windows updater 不得在 macOS 上使用。
