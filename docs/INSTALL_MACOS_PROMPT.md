# 给 Codex 的 macOS 全新安装 Prompt

本 Prompt 适用于一台已安装并登录 ChatGPT/Codex Desktop 的全新 Mac。安装开始前先把当前 Codex 对话设为“完全访问（Full access）”，确保安装和 Doctor 能访问当前用户的 macOS Keychain。新流程在飞书 CLI 创建专用应用后立即安全保存 Channel App Secret，再由仓库脚本打开飞书官方应用模板，一次性声明 Bridge 所需权限和消息事件。用户不再需要逐页重复启用默认已有的机器人、长连接和消息事件。

本文锁定到 `v0.4.0-macos-rc.9`。它保留 rc.8 的完整多用户、Session 权限和跨版本 Desktop 恢复，并固定前台事务使用的已验证 Node；日后升级由目标版本前台升级器保留网络模式、自动重开 Desktop 并验收。完整要求继续保存在本文件和 `docs/UPGRADE_MACOS_PROMPT.md` 中。后续 RC 不会自动改变本文中的安装目标；使用其他版本时必须先更新并重新验证整份协议。

## 通过本链接调用安装代理

当用户引用本文件 URL，要求 Codex 安装或部署 Bridge 时，Codex 必须：

1. 完整读取本文件直到末尾，不得只读取开头或提供摘要；
2. 将下方“可复制 Prompt”中的全部内容视为用户的完整执行指令，不要求用户再次复制或重复确认这些规则；
3. 先完成下方规定的当前对话“完全访问（Full access）”人工停点，再从只读预检开始，在不需要用户操作时自主连续执行；
4. 先简要说明为什么需要“完全访问”，然后立即请用户切换并暂停等待。

浏览器认证、外部变更批准、管理员审批、应用发布、OAuth、Secret 安全输入与 Desktop 完整重启等人工停点，以“可复制 Prompt”中的具体规则为准。

## 使用方法

把下方整段内容复制到新 Mac 上的一个新 Codex 任务中。用户仍需本人将当前对话设为“完全访问”，并完成飞书浏览器认证、应用模板确认、可能出现的管理员审批与版本发布、用户 OAuth、App Secret 安全输入，以及 ChatGPT/Codex Desktop 的完整退出和重启。

## 可复制 Prompt

```text
请在这台全新 Mac 上安装并完整验收 Feishu Codex Bridge。

固定安装目标：
- 仓库：https://github.com/ninmon/feishu-codex-bridge-private.git
- tag：v0.4.0-macos-rc.9

已知条件：
- 这是一台独立的新 Mac，不迁移、复用或停止其他机器上的 Bridge。
- ChatGPT/Codex Desktop 已安装并登录。
- 这台 Mac 必须创建一个新的专用飞书企业自建应用和 Bot，不复用组织内现有应用。
- 飞书应用展示名称必须与运行 Codex Desktop 的这台 Mac 的系统“电脑名称”完全一致。
- 即使两台 Mac 使用同一个飞书账号，每台 Mac 也分别使用自己的应用和 Bot。

工作规则：

开始前必须先完成一个人工权限停点：
- 告诉用户在当前 Codex 对话输入框下方的权限菜单中选择“完全访问（Full access）”；
- 说明 Bridge 的 Secret 保存在当前 macOS 用户的 Keychain，沙盒模式下的 Codex 子进程可能将已存在的密钥误报为缺失；
- 暂停并等待用户明确回复已完成，在此之前不得运行预检或安装命令；
- 不得通过修改 Codex 全局配置、关闭系统安全机制或伪造 Keychain 检查来代替这个停点。

1. 先做只读预检，确认：
   - macOS 13 或更高；
   - Git 可用；
   - GitHub CLI 可用、已登录，且当前账号能只读访问 ninmon/feishu-codex-bridge-private；
   - Node.js >= 22.13.0 且 npm 可用，可优先使用 Desktop 自带运行时；
   - ChatGPT/Codex Desktop 已安装，Codex 可执行文件支持 App Server listener；
   - 使用 /usr/sbin/scutil --get ComputerName 只读取得当前 Mac 的系统电脑名称，并在本次安装中保留其精确大小写、空格和字符；
   - 可访问 GitHub、npm 和飞书开放平台。

   如果缺少系统依赖，先说明缺少什么并请求用户批准；不要擅自选择 Homebrew 或其他系统安装方式。如果系统电脑名称为空，先让用户在 macOS“系统设置 > 通用 > 共享”中设置，不得自行生成应用名。

2. 让用户确认仓库的最终存放位置，并确认本机 GitHub CLI 已登录且当前账号有私有仓库访问权，再克隆仓库并检出精确 tag v0.4.0-macos-rc.9。
   - 使用 GitHub CLI 的已登录凭据克隆私有仓库；不得把 GitHub Token 放入 URL、命令参数、聊天或日志；
   - 先确认远程 tag 存在并解析到一个精确提交；tag 不存在时立即停止，不得退回分支或其他版本；
   - 目标目录已存在或包含文件时停下，不得覆盖；
   - 不得使用 git reset、git clean 或 git stash；
   - 不要在聊天中回显仓库绝对路径。

3. 进入仓库后，在做任何安装变更前完整阅读：
   - AGENTS.md
   - docs/INSTALL_MACOS.md
   - docs/FEISHU_APP_SETUP.md

   以这些文件作为安装协议。只使用仓库提供的 .sh 入口，不要手工复刻脚本行为。

4. 安装仓库锁定的本地工具：
   - 运行 ./bootstrap.sh；
   - 运行 ./lark-cli.sh --version 确认本地 Lark CLI 可用。

   bootstrap.sh 应通过 npm ci 安装 package-lock.json 锁定的 Lark CLI 和 Channel SDK。不要全局安装 Lark CLI。

5. 这是全新独立部署，不要询问是替换旧 Mac 还是与旧 Mac 并行。
   - 不迁移或复用其他机器的 Bridge 配置、绑定、队列或运行状态；
   - 不复用组织内已有的飞书应用或 Bot；
   - 同一个飞书账号部署第二台 Mac 时，也必须为第二台 Mac 创建另一个应用；
   - 只绑定这台 Mac 上可见的 Codex 任务；
   - 不检查或停止其他机器上的 Bridge。

6. 在创建应用前，向用户一次性说明并取得明确批准。批准范围包括：
   - 创建一个新的专用企业自建应用，应用展示名称精确使用第 1 步取得的系统电脑名称；
   - 用官方应用模板添加 7 项应用/Bot 权限、4 项用户权限和 im.message.receive_v1；
   - 在飞书要求时提交应用版本并等待管理员审批。

   用户明确回复“批准创建并配置”后，运行：
   ./lark-cli.sh config init --new --brand feishu --lang zh_cn

   使用飞书 CLI 自带的浏览器或设备认证流程，让用户使用实际部署 Bridge 的飞书组织账号完成应用创建。在创建页面把“应用名称”设置为第 1 步取得的系统电脑名称；如果创建流程没有名称输入框，创建后只进入一次“基础信息”修改应用名称，确认页面显示完全一致后再继续。

   CLI 输出 verification URL 后，无论浏览器是否自动打开，都要立即把 CLI 原样输出的该 URL 作为可点击的备用链接交给用户，然后暂停等待用户完成。只能转交该一次性 verification URL；不得同时输出 device code、原始 JSON、App ID、App Secret、Token 或其他身份数据。不得因为自动打开失败就重跑命令，以免让已交给用户的 URL 失效。

   注意：config init 的 --name 参数表示 Lark CLI 本地 profile 名称，不是飞书应用展示名称，因此不得用 --name 尝试设置应用名。若飞书拒绝该电脑名称，不得擅自添加 Codex、Bridge、序号或其他后缀；应暂停并让用户决定是否先修改 macOS 电脑名称。

   不要把 URL 之外的临时凭据、App ID、App Secret 或任何身份标识粘贴到聊天或命令参数。浏览器登录、CAPTCHA/MFA 或管理员确认时必须暂停，由用户本人操作。

7. 应用创建完成后，先让用户在本机可见的独立 Terminal 中运行：
   ./setup-channel-secret.sh

   - 这是创建应用后的第一项配置，不必等待 bridge.config.json 生成；
   - 用户只在脚本的隐藏输入提示中粘贴 Channel App Secret；
   - Secret 保存到当前 macOS 用户的 Keychain；
   - 不得在聊天中索取、读取或回显 Secret，不得将其放入命令参数、配置、日志、文档或 Git；
   - 脚本成功后再继续。

8. 运行：
   ./configure-feishu-app.sh

   该脚本应先输出一个最多两分钟有效的临时本机 loopback 备用 URL，再尝试自动打开浏览器。这个本机 URL 不包含 App ID，可以显式交给用户点击；不得输出它最终跳转的飞书目标 URL。如果没有自动弹出浏览器，立即明确告诉用户点击该本机备用 URL，不得只说“请在浏览器中完成”。让用户在同一个确认页核对并确认以下完整模板：

   应用/Bot 权限（7 项）：
   - im:message
   - im:message.p2p_msg:readonly
   - im:message.group_msg
   - im:chat:readonly
   - im:chat.members:read
   - im:chat:create
   - im:resource

   用户权限（7 项）：
   - im:feed_group_v1:read
   - im:feed_group_v1:write
   - im:chat.tabs:read
   - im:chat.tabs:write_only
   - docx:document:create
   - docx:document:write_only
   - docx:document:readonly

   事件（1 项）：
   - im.message.receive_v1

   新应用通常已默认启用机器人能力、长连接和 im.message.receive_v1。不要再要求用户逐页打开“机器人”和“事件与回调”重复设置；模板仍声明所需事件，后续脚本会验证实际状态。只有校验明确失败时，才按 docs/FEISHU_APP_SETUP.md 的故障回退步骤指导用户修复对应项目。

   如果确认页或组织策略要求创建/发布版本、设置可用范围或管理员审批：
   - 可用范围只包含实际使用 Bridge 的当前用户；
   - 由用户本人核对并提交；
   - 在状态明确为已发布/已生效前暂停等待。

9. 完成当前用户 OAuth：
   ./lark-cli.sh auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,im:chat.tabs:read,im:chat.tabs:write_only,docx:document:create,docx:document:readonly,docx:document:write_only"

   浏览器授权必须由用户本人确认。与第 6 步相同，CLI 一旦输出 verification URL，必须将该 URL 原样作为可点击备用链接交给用户并暂停；不输出 device code 或原始 JSON，不重跑令已交付 URL 失效的登录命令。授权完成后运行：
   ./verify-feishu-app.sh

   该验证器只输出不含身份标识的安全摘要。macOS 飞书 CLI 入口必须自动移除当前 Codex/Desktop 进程继承的 HTTP/HTTPS/ALL proxy 变量，使飞书身份与事件校验保持直连；不得要求用户临时修改已保存的 Desktop 代理。只有输出 ok=true，且应用、Bot、用户身份、七项用户 OAuth scope、消息事件发布状态和消息事件所需权限均通过，才能继续。不得运行后再把原始 auth status 或 event dry-run JSON 粘贴到聊天、Issue 或日志。

10. 运行：
    ./install.sh --skip-dependency-install

    - 不要使用 --force-config，除非先说明原因并获得用户批准；
    - 不得手工编辑 bridge.config.json；
    - 不得输出本机配置、身份标识或本机任务路径。

11. 多用户 Project 目录是可选能力，不要为单用户安装增加不必要的配置：
    - 如果用户在当前部署请求中没有明确要求“同机多用户”，不要额外询问，不运行设置脚本；Bridge 保持 Owner-only；
    - 如果用户已明确要求同机多用户，在本机可见的独立 Terminal 中让 Bridge Owner 亲自运行：
      ./setup-project-root.sh
    - 脚本会交互询问绝对 Project 根目录和 Owner 的一级目录名；不得在聊天、命令参数、日志或文档中代输、捕获或回显该路径；
    - 绝对路径只通过脚本 stdin 进入本机私有状态，不得放入 bridge.config.json 或 Git；
    - 新成员以后由 Owner 在 Bot 私聊或已绑定群发送一张飞书用户名片，并按 Bot 提示回复一级目录名；也可使用 `/members add <一级目录名> @成员` 登记；成功后 Bot 主动私聊成员并提示发送 `/add`，发送失败时保留登记并向 Owner 提供手动搜索 Bot 的兜底；发送名片不会自动邀请成员入群，不替用户推断成员、目录或自动邀请任何人加入群。

12. 启动并验证 Bridge：
    - ./start-bridge.sh
    - ./configure-codex-desktop-relay.sh
    - ./doctor.sh --require-running --require-desktop-relay

    如果检查失败，先诊断具体检查项。不得通过删除配置、凭据或重建应用来绕过问题。

13. 在给出 Desktop 启动命令前，必须明确询问并等待用户回答：

    “这台 Mac 上 Codex 访问服务是直连，还是需要本机代理？不需要代理请回复‘直连’；需要代理请提供一个无认证、带明确端口的 loopback URL，例如 http://127.0.0.1:7897。不要提供用户名、密码或远程代理地址。”

    - 不得根据系统环境、Clash 是否运行、旧配置或网络探测替用户推断；
    - 用户回答直连时，唯一启动命令是：
      ./launch-codex-desktop-with-relay.sh
    - 用户明确选择代理时，先验证 URL 为无认证且带明确端口的 127.0.0.1/localhost/[::1] 地址，再使用：
      ./launch-codex-desktop-with-relay.sh --proxy <用户确认的本机代理 URL>
    - 代理只应用于 Desktop 与共享 Codex App Server；飞书 Bridge、Channel 和 watchdog 保持直连。
    - 代理状态变化后，启动脚本必须重启并验证共享 App Server，再重新注册 relay watchdog；必须等待 watchdog 保持加载并发布新鲜 ready 心跳。首次注册未驻留时由脚本自动完整重试一次，两次均失败才停止，不得继续打开 Desktop，也不得把手工重跑 configure-codex-desktop-relay.sh 当作正常安装步骤。

14. 最终启动 Desktop 前：
    - 在当前仓库目录为用户打开一个独立 Terminal；
    - 只给出第 13 步选定的那一条启动命令；
    - 要求用户完全退出 ChatGPT/Codex Desktop，确认应用进程结束；
    - 停止当前回合，等待用户从独立 Terminal 运行命令并重新打开 Desktop。

    不得从正在使用共享 App Server 的 Codex 任务中强制退出、杀死或自行重启 Desktop。

15. Desktop 重新打开、用户回到当前任务后，运行：
    ./doctor.sh --require-running --require-desktop-relay --require-desktop-attached

    只有全部 Doctor 检查通过，且 Bridge Channel、共享 App Server、watchdog 和 Desktop relay 都健康时，才能进入真实验收。

16. 使用安装后的 $feishu-session-bind 为当前 Codex 任务创建或复用专属飞书绑定群。
    - 初次绑定以该 skill 成功返回的群为准；
    - 不要再要求用户先搜索 Bot、创建 Bot 私聊或发送 /add；
    - `/add` 仅是用户以后在 Bot 私聊中的可选手工入口，不是本安装的前置条件；绑定群中的 `/add` 只引导用户回到 Bot 私聊；
    - 不得在聊天中输出 user/bot open ID、chat ID、Codex task ID 或任务路径。

17. 在绑定群完成真实验收：
    - 从飞书向 Codex 发送一条文本，确认进入同一任务并返回最终回答；
    - 从 Desktop 的同一任务发送一条文本，确认结果返回绑定群；
    - 从飞书发送一张小图和一个普通小文件，确认 Codex 可以读取；
    - 让 Codex 的最终回答引用一个本地文件，确认飞书收到原生附件；
    - 再运行 ./status-bridge.sh 和严格 Doctor。

    如果第 11 步启用了多用户，还必须先由用户把一名测试成员加入应用可用范围并完成必要的发布/审批，再由 Owner 发送该成员的飞书用户名片并按提示回复测试目录名完成登记；同时确认原有 `/members add` 仍可用。确认 Bot 主动私聊测试成员并显示 `/add` 指引，再实测 Owner 与成员的 `/add` 列表隔离、成员目录内新建 Project/任务、在已有非空 Project 中继续新建并绑定 Session、把成员加入绑定群后的 Session 共享、多人群 `@Bot`/queue/`/steer` 权限、按发送者隔离的附件草稿、Session owner 从飞书安全调整自己 Session 的权限，以及未登记成员加群时的 fail-closed。完全访问必须二次确认，忙碌 Session 必须拒绝切换；成员身份和本机目录不得输出到聊天或日志。

18. 安全与完成标准：
    - 除人工认证停点中 Lark CLI 原样生成的一次性 verification URL，以及应用模板脚本生成的临时本机 loopback URL 外，不得在聊天、日志、命令参数、文档或 Git 中输出 App Secret、OAuth token、App ID、device code、user/bot open ID、chat ID、Codex task ID、本机配置或任务路径；
    - 不得修改 Codex 全局状态来伪造 Project 归属；
    - 不得删除或覆盖用户文件；
    - 必须在每个需要用户的安全停点真正暂停，不得伪造认证、审批、发布、Secret 存储或 Desktop 重启成功；
    - 完整 Doctor 和真实双向消息/附件测试通过前，不得报告部署成功；
    - 工作期间提供简短进度更新，并在不需要用户操作时自主完成所有安全步骤。
```

## 设计说明

- Prompt 固定到明确 tag，避免安装过程读到正在变化的分支。
- 当前 Codex 对话在任何命令前切换为“完全访问”，避免 Keychain 读取被沙盒拒绝后造成假阴性。
- `bootstrap.sh` 安装仓库锁定的 Lark CLI，无需全局安装。
- `configure-feishu-app.sh` 把 11 项权限和消息事件合并到飞书官方的一次确认页；默认已有的 Bot、长连接与消息事件不再重复逐页设置。
- `setup-channel-secret.sh` 现在可以在生成 Bridge 配置前运行，因此 Secret 输入紧跟应用创建。
- `setup-project-root.sh` 与 Windows v0.4 共享同一访问状态模型，但只在用户明确要求同机多用户时才交互执行；单用户默认仍是 Owner-only。
- 直连或代理是用户必须明确回答的安装选项，安装代理不得自行假设。
- 初次绑定直接使用 `$feishu-session-bind`；Bot 私聊中的 `/add` 不再是验收前置条件。
- Lark CLI 认证始终向用户提供当次 verification URL；应用模板脚本提供不含 App ID 的临时本机备用 URL。
- 浏览器确认、可能出现的管理员审批/应用发布、OAuth、Secret 输入与 Desktop 重启仍是必须的人工停点。
