# 给 Codex 的 Windows 全新安装 Prompt

本 Prompt 适用于一台已安装并登录 ChatGPT/Codex Desktop 的全新 Windows 电脑。新流程在飞书 CLI 创建专用应用后立即用 Windows DPAPI 安全保存 Channel App Secret，再由仓库脚本打开飞书官方应用模板，一次性声明 Bridge 所需权限和消息事件。Lark CLI 认证始终提供可点击 verification URL，应用模板脚本会在尝试打开浏览器前输出不含 App ID 的临时本机备用 URL。用户不再需要逐页重复启用默认已有的机器人、长连接和消息事件。

本文为 `v0.3.2-windows-rc.1` 的固定安装协议；只能在该 tag 已公开发布并能解析到精确提交后使用。后续 RC 不会自动改变本文中的安装目标；使用其他版本时必须先更新并重新验证整份协议。

## 通过本链接调用安装代理

当用户引用本文件 URL，要求 Codex 安装或部署 Bridge 时，Codex 必须：

1. 完整读取本文件直到末尾，不得只读取开头或提供摘要；
2. 将下方“可复制 Prompt”中的全部内容视为用户的完整执行指令，不要求用户再次复制或重复确认这些规则；
3. 从只读预检开始，在不需要用户操作时自主连续执行；
4. 先简要说明即将执行的第一步，然后立即开始。

浏览器认证、外部变更批准、管理员审批、应用发布、OAuth、Secret 安全输入与 Desktop 完整重启等人工停点，以“可复制 Prompt”中的具体规则为准。

## 使用方法

把下方整段内容复制到新 Windows 电脑上的一个新 Codex 任务中。用户仍需本人完成飞书浏览器认证、应用模板确认、可能出现的管理员审批与版本发布、用户 OAuth、App Secret 隐藏输入，以及 ChatGPT/Codex Desktop 的完整退出和重启。

## 可复制 Prompt

```text
请在这台全新 Windows 电脑上安装并完整验收 Feishu Codex Bridge。

固定安装目标：
- 仓库：https://github.com/ninmon/feishu-codex-bridge.git
- tag：v0.3.2-windows-rc.1

已知条件：
- 这是一台独立的新 Windows 电脑，不迁移、复用或停止其他机器上的 Bridge。
- ChatGPT/Codex Desktop 已安装并登录。
- 这台电脑必须创建一个新的专用飞书企业自建应用和 Bot，不复用组织内现有应用。
- 飞书应用展示名称必须与运行 Codex Desktop 的这台 Windows 电脑的系统计算机名完全一致。
- 即使两台电脑使用同一个飞书账号，每台电脑也分别使用自己的应用和 Bot。

工作规则：

1. 先做只读预检，确认：
   - Windows 10 或 11；
   - Git 可用；
   - Node.js >= 22.13.0 且 npm 可用；
   - PowerShell 5.1 或 PowerShell 7 可用；
   - ChatGPT/Codex Desktop 已安装，Codex 可执行文件支持 App Server listener；
   - 使用 [Environment]::MachineName 只读取得当前 Windows 计算机名，并在本次安装中保留其精确大小写和字符；
   - 可访问 GitHub、npm 和飞书开放平台。

   如果缺少 Git 或 Node.js，先说明将安装哪个软件并取得用户批准，再使用 winget 的官方包。如果计算机名为空，先让用户在 Windows 设置中修复，不得自行生成应用名。

2. 让用户确认仓库的最终存放位置；如果用户没有特殊要求，建议使用 %LOCALAPPDATA%\FeishuCodexBridge\app。然后克隆仓库并检出精确 tag v0.3.2-windows-rc.1。
   - 先确认远程 tag 存在并解析到一个精确提交；tag 不存在时立即停止，不得退回分支或其他版本；
   - 目标目录已存在或包含文件时停下，不得覆盖；
   - 不得使用 git reset、git clean 或 git stash；
   - 不要在聊天中回显仓库绝对路径。

3. 进入仓库后，在做任何安装变更前完整阅读：
   - AGENTS.md
   - docs/INSTALL_AGENT.md
   - docs/FEISHU_APP_SETUP.md

   以这些文件作为安装协议。只使用仓库提供的 .ps1 入口，不要手工复刻脚本行为。

4. 安装仓库锁定的本地工具：
   - 运行 npm ci；
   - 运行 .\lark-cli.ps1 --version 确认本地 Lark CLI 可用。

   不要全局安装 Lark CLI，不要用未锁定的版本代替 package-lock.json。

5. 这是全新独立部署，不要询问是否替换旧电脑，也不检查或停止其他电脑上的 Bridge。不迁移或复用其他机器的配置、绑定、队列或运行状态。

6. 创建应用前，向用户一次性说明并取得明确批准。批准范围包括：
   - 创建一个新的专用企业自建应用，应用展示名称精确使用第 1 步取得的 Windows 计算机名；
   - 用官方应用模板添加 7 项应用/Bot 权限、4 项用户权限和 im.message.receive_v1；
   - 在飞书要求时提交应用版本并等待管理员审批。

   用户明确回复“批准创建并配置”后，运行：
   .\lark-cli.ps1 config init --new --brand feishu --lang zh_cn

   让用户使用实际部署 Bridge 的飞书组织账号完成应用创建。在创建页面把“应用名称”设置为第 1 步取得的计算机名；如果创建流程没有名称输入框，创建后只进入一次“基础信息”修改应用名称，确认完全一致后再继续。

   CLI 输出 verification URL 后，无论浏览器是否自动打开，都要立即把 CLI 原样输出的该 URL 作为可点击的备用链接交给用户，然后暂停等待用户完成。只能转交该一次性 verification URL；不得同时输出 device code、原始 JSON、App ID、App Secret、Token 或其他身份数据。不得因为自动打开失败就重跑命令，以免让已交给用户的 URL 失效。

   config init 的 --name 参数表示 Lark CLI 本地 profile 名称，不是飞书应用展示名称，不得用 --name 尝试设置应用名。若飞书拒绝当前计算机名，不得擅自添加 Codex、Bridge、序号或其他后缀；暂停让用户决定是否先修改 Windows 计算机名。

   不要把 URL 之外的临时凭据、App ID、App Secret 或任何身份标识粘贴到聊天或命令参数。浏览器登录、CAPTCHA/MFA 或管理员确认时必须暂停，由用户本人操作。

7. 应用创建完成后，立即为用户打开一个本机可见的 PowerShell 安全输入窗口，只运行 setup-channel-secret.ps1。
   - 这是创建应用后的第一项配置，不必等待 bridge.config.json 生成；
   - 用户只在脚本的隐藏输入提示中粘贴 Channel App Secret；
   - Secret 由当前 Windows 用户的 DPAPI 加密，不得在聊天中索取、读取或回显，不得将其放入命令参数、配置、日志、文档或 Git；
   - 脚本明确显示 DPAPI 保存成功后再继续。

8. 运行：
   .\configure-feishu-app.ps1

   该脚本应先输出一个最多两分钟有效的临时本机 loopback 备用 URL，再尝试自动打开浏览器。这个本机 URL 不包含 App ID，可以显式交给用户点击；不得输出它最终跳转的飞书目标 URL。如果没有自动弹出浏览器，立即明确告诉用户点击该本机备用 URL，不得只说“请在浏览器中完成”。让用户在同一个确认页核对并确认完整模板：

   应用/Bot 权限（7 项）：
   - im:message
   - im:message.p2p_msg:readonly
   - im:message.group_msg
   - im:chat:readonly
   - im:chat.members:read
   - im:chat:create
   - im:resource

   用户权限（4 项）：
   - im:feed_group_v1:read
   - im:feed_group_v1:write
   - docx:document:create
   - docx:document:write_only

   事件（1 项）：
   - im.message.receive_v1

   新应用通常已默认启用机器人能力、长连接和 im.message.receive_v1。不要再要求用户逐页打开“机器人”和“事件与回调”重复设置；模板仍声明所需事件，后续脚本会验证实际状态。只有校验明确失败时，才按 docs/FEISHU_APP_SETUP.md 的故障回退步骤修复对应项目。

   如果确认页或组织策略要求创建/发布版本、设置可用范围或管理员审批：可用范围只包含实际使用 Bridge 的当前用户；由用户本人核对并提交；在状态明确为已发布/已生效前暂停等待。

9. 完成当前用户 OAuth：
   .\lark-cli.ps1 auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only"

   浏览器授权必须由用户本人确认。与第 6 步相同，CLI 一旦输出 verification URL，必须将该 URL 原样作为可点击备用链接交给用户并暂停；不输出 device code 或原始 JSON，不重跑令已交付 URL 失效的登录命令。授权完成后运行：
   .\verify-feishu-app.ps1

   验证器只输出不含身份标识的安全摘要。Windows 飞书 CLI、安装器和 Doctor 必须从子进程环境中移除 HTTP/HTTPS/ALL proxy 变量，确保飞书身份和事件校验直连，不得要求用户临时修改已保存的 Desktop 代理。只有输出 ok=true，且应用、Bot、用户身份、四项用户 OAuth scope、消息事件发布状态和事件所需权限全部通过，才能继续。不得把原始 auth status 或 event dry-run JSON 粘贴到聊天、Issue 或日志。

10. 运行：
    .\install.ps1 -SkipDependencyInstall

    - 不要使用 -ForceConfig，除非先说明原因并获得用户批准；
    - 不得手工编辑 bridge.config.json；
    - 不得输出本机配置、身份标识或本机任务路径。

11. 启动 Bridge 并执行启动前 Doctor：
    - .\start-bridge.ps1
    - .\doctor.ps1 -RequireRunning

    如果检查失败，先诊断具体检查项。不得通过删除配置、凭据或重建应用绕过问题。

12. 在给出 Desktop 启动命令前，必须明确询问并等待用户回答：

    “这台 Windows 电脑上 Codex 访问服务是直连，还是需要本机代理？不需要代理请回复‘直连’；需要代理请提供一个无认证、带明确端口的 loopback URL，例如 http://127.0.0.1:7897。不要提供用户名、密码或远程代理地址。”

    - 不得根据系统环境、Clash 是否运行、旧配置或网络探测替用户推断；
    - 用户回答直连时，唯一启动命令是：
      .\launch-codex-desktop-with-relay.ps1
    - 用户明确选择代理时，先验证 URL 为无认证且带明确端口的 127.0.0.1/localhost/[::1] 地址，再使用：
      .\launch-codex-desktop-with-relay.ps1 -Proxy <用户确认的本机代理 URL>
    - 不带 -Proxy 默认为直连；-NoProxy 只是兼容别名；
    - 代理只应用于 Desktop 与共享 Codex App Server；飞书 Bridge、Channel、watchdog 与飞书 CLI 校验保持直连；
    - 若只发现 Windows packaged Desktop 且用户选择代理，启动器必须安全停止；不得为了继续而修改系统或用户全局代理。只有能找到可直接启动的 Win32 Desktop 可执行文件时才支持隔离的 -Proxy 模式；
    - 启动器必须保存选择、必要时重启本安装拥有的共享 App Server、重新注册 Scheduled Task watchdog，并等待同一 activation 的新鲜 ready heartbeat；失败时必须移除 Bridge-owned pointer，不得继续打开 Desktop。

13. 最终启动 Desktop 前：
    - 在当前仓库目录为用户打开一个独立 PowerShell；
    - 只给出第 12 步选定的那一条启动命令；
    - 要求用户完全退出 ChatGPT/Codex Desktop，确认应用进程结束；
    - 停止当前回合，等待用户从独立 PowerShell 运行命令并重新打开 Desktop。

    不得从正在使用共享 App Server 的 Codex 任务中强制退出、杀死或自行重启 Desktop。

14. Desktop 重新打开、用户回到当前任务后，运行：
    - .\status-bridge.ps1
    - .\doctor.ps1 -RequireRunning -RequireDesktopRelay

    只有全部 Doctor 检查通过，且 Bridge Channel、共享 App Server、选定的网络模式、watchdog 和 Desktop relay 都健康时，才能进入真实验收。

15. 使用安装后的 $feishu-session-bind 为当前 Codex 任务创建或复用专属飞书绑定群。
    - 初次绑定以该 skill 成功返回的群为准；
    - 不要要求用户先搜索 Bot、创建 Bot 私聊或发送 /add；
    - /add 仅是用户以后在已经存在的 Bot 私聊或已绑定群中的可选手工入口，不是本安装的前置条件；
    - 不得在聊天中输出 user/bot open ID、chat ID、Codex task ID 或任务路径。

16. 在绑定群完成真实验收：
    - 从飞书向 Codex 发送一条文本，确认进入同一任务并返回最终回答；
    - 从 Desktop 的同一任务发送一条文本，确认结果返回绑定群；
    - 从飞书发送一张小图和一个普通小文件，确认 Codex 可以读取；
    - 让 Codex 的最终回答引用一个本地文件，确认飞书收到原生附件；
    - 再运行 .\status-bridge.ps1 和严格 Doctor。

17. 安全与完成标准：
    - 除人工认证停点中 Lark CLI 原样生成的一次性 verification URL，以及应用模板脚本生成的临时本机 loopback URL 外，不得在聊天、日志、命令参数、文档或 Git 中输出 App Secret、OAuth token、App ID、device code、user/bot open ID、chat ID、Codex task ID、本机配置或任务路径；
    - 不得修改 Codex 全局状态来伪造 Project 归属；
    - 不得删除或覆盖用户文件；
    - 必须在每个需要用户的安全停点真正暂停，不得伪造认证、审批、发布、Secret 存储或 Desktop 重启成功；
    - 完整 Doctor 和真实双向消息/附件测试通过前，不得报告部署成功；
    - 工作期间提供简短进度更新，并在不需要用户操作时自主完成所有安全步骤。
```

## 设计说明

- Prompt 锁定到明确 tag，避免安装过程读到正在变化的分支。
- `configure-feishu-app.ps1` 把 11 项权限和消息事件合并到飞书官方的一次确认页；默认已有的 Bot、长连接与消息事件不再重复逐页设置。
- `setup-channel-secret.ps1` 现在可以在生成 Bridge 配置前运行，因此 Secret 输入紧跟应用创建。
- Lark CLI 认证始终向用户提供当次 verification URL；应用模板脚本提供不含 App ID 的临时本机备用 URL。
- 直连或代理是用户必须明确回答的安装选项；不带 `-Proxy` 默认直连。
- 初次绑定直接使用 `$feishu-session-bind`；Bot 私聊中的 `/add` 不再是验收前置条件。
- 浏览器确认、可能出现的管理员审批/应用发布、OAuth、Secret 输入与 Desktop 重启仍是必须的人工停点。
