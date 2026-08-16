# 给 Codex 的 macOS 全新安装 Prompt

本 Prompt 适用于一台已安装并登录 ChatGPT/Codex Desktop 的全新 Mac。它会让 Codex 使用仓库内脚本安装锁定的 Lark CLI、创建专用飞书应用/Bot、安装 Bridge，并在必须由用户操作的安全节点停下。

RC 发布后不会自动更新本文中的 tag。使用前应确认下方目标 tag 仍是希望安装的版本。

## 使用方法

把下方整段内容复制到新 Mac 上的一个新 Codex 任务中。用户仍需要本人完成浏览器登录、CAPTCHA/MFA、管理员审批、应用发布、OAuth 确认、App Secret 安全输入和 Desktop 完整重启。

## 可复制 Prompt

```text
请在这台全新 Mac 上安装并完整验收 Feishu Codex Bridge。

固定安装目标：
- 仓库：https://github.com/ninmon/feishu-codex-bridge.git
- tag：v0.3.2-macos-rc.7

已知条件：
- 这是一台独立的新 Mac，不迁移、复用或停止其他机器上的 Bridge。
- ChatGPT/Codex Desktop 已安装并登录。
- 这台 Mac 应创建或绑定一个未被其他 Bridge 使用的专用飞书企业自建应用和 Bot。

工作规则：

1. 先做只读预检，确认：
   - macOS 13 或更高；
   - Git 可用；
   - Node.js >= 22.13.0 且 npm 可用，可优先使用 Desktop 自带运行时；
   - ChatGPT/Codex Desktop 已安装，Codex 可执行文件支持 App Server listener；
   - 可访问 GitHub、npm 和飞书开放平台。

   如果缺少系统依赖，先说明缺少什么并请求用户批准；不要擅自选择 Homebrew 或其他系统安装方式。

2. 让用户确认仓库的最终存放位置，再克隆仓库并检出精确 tag v0.3.2-macos-rc.7。
   - 先确认远程 tag 的精确提交；
   - 目标目录已存在或包含文件时停下，不得覆盖；
   - 不得使用 git reset、git clean 或 git stash；
   - 不要在聊天中回显仓库绝对路径。

3. 进入仓库后，在做任何安装变更之前完整阅读：
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
   - 只绑定这台 Mac 上可见的 Codex 任务；
   - 不检查或停止其他机器上的 Bridge。

6. 引导用户创建一个专用的飞书企业自建应用，并启用该应用的机器人能力。
   - 不要把它说成“飞书 CLI 智能体”；
   - 可使用 ./lark-cli.sh config init --new --brand feishu --lang zh_cn 启动创建流程；
   - 创建应用、修改权限和发布版本都是外部变更。在真正执行前，先向用户说明拟进行的变更并获得明确批准；
   - 浏览器登录、CAPTCHA/MFA 或管理员确认时停下，由用户操作；
   - 任何 App Secret 都只能由用户在本机可见的交互提示中输入。不得在聊天中索取、读取或回显明文。

7. 按 docs/FEISHU_APP_SETUP.md 在开放平台完成应用配置：
   - 启用 Bot；
   - 添加应用权限：im:message、im:message.p2p_msg:readonly、im:message.group_msg、im:chat:readonly、im:chat.members:read、im:chat:create、im:resource；
   - 添加需要用户 OAuth 的权限：im:feed_group_v1:read、im:feed_group_v1:write、docx:document:create、docx:document:write_only；
   - 使用长连接订阅 im.message.receive_v1；
   - 将当前用户加入应用可用范围；
   - 创建并发布应用版本。

   如果组织要求管理员审批，停下并等待审批通过。权限或事件未发布时不得继续。

8. 完成当前用户 OAuth：
   - 使用 ./lark-cli.sh auth login --scope "im:feed_group_v1:read,im:feed_group_v1:write,docx:document:create,docx:document:write_only"；
   - 在用户浏览器授权时停下；
   - 然后使用 ./lark-cli.sh auth status --json --verify 只确认 Bot 和 User 均 available/verified，且所需 scope 不再缺失。

   auth status 的完整 JSON 含身份信息，不得粘贴到聊天、Issue 或日志中。

9. 飞书应用、Bot 和用户 OAuth 都验证通过后，运行 ./install.sh。
   - 不要使用 --force-config，除非先说明原因并获得用户批准；
   - 不得手工编辑 bridge.config.json；
   - 不得输出本机配置、身份标识或本机任务路径。

10. 安装器完成后，让用户在本机可见 Terminal 中运行 ./setup-channel-secret.sh。
    - Channel App Secret 只能由用户在该脚本的隐藏输入提示中粘贴；
    - Secret 保存到当前 macOS 用户的 Keychain；
    - 不得向用户索取 Secret，不得读取明文，不得将它写入聊天、命令参数、配置、日志或 Git。

11. 启动并验证 Bridge：
    - ./start-bridge.sh
    - ./configure-codex-desktop-relay.sh
    - ./doctor.sh --require-running --require-desktop-relay

    如果检查失败，先诊断具体检查项。不得通过删除配置、凭据或重建应用来绕过问题。

12. Desktop 启动默认直连。只有用户明确表示 Codex 需要代理时，才使用：
    ./launch-codex-desktop-with-relay.sh --proxy <无认证的本机 loopback URL>

    代理 URL 必须带明确端口。飞书 Bridge、Channel 和 watchdog 不使用此代理。没有代理时使用：
    ./launch-codex-desktop-with-relay.sh

13. 最终启动 Desktop 前：
    - 在当前仓库目录为用户打开一个独立 Terminal；
    - 给出上一步中选定的唯一一条 Desktop 启动命令；
    - 要求用户完全退出 ChatGPT/Codex Desktop；
    - 停止当前回合，等待用户从独立 Terminal 运行命令并重新打开 Desktop。

    不得从正在使用共享 App Server 的 Codex 任务中强制退出、杀死或自行重启 Desktop。

14. Desktop 重新打开、用户回到当前任务后，继续运行：
    ./doctor.sh --require-running --require-desktop-relay --require-desktop-attached

    只有全部 Doctor 检查通过，且 Bridge Channel、共享 App Server、watchdog 和 Desktop relay 都健康时，才能进入真实验收。

15. 指导用户在飞书私聊 Bot 发送 /add，只绑定这台 Mac 上可见的 Codex 任务，然后完成：
    - 从飞书向 Codex 发送一条文本，确认进入同一任务并返回最终回答；
    - 从 Desktop 的同一任务发送一条文本，确认结果返回绑定群；
    - 从飞书发送一张小图和一个普通小文件，确认 Codex 可以读取；
    - 让 Codex 的最终回答引用一个本地文件，确认飞书收到原生附件；
    - 再运行 ./status-bridge.sh 和严格 Doctor。

16. 安全与完成标准：
    - 不得在聊天、日志、命令参数、文档或 Git 中输出 App Secret、OAuth token、App ID、user/bot open ID、chat ID、Codex task ID、本机配置或任务路径；
    - 不得修改 Codex 全局状态来伪造 Project 归属；
    - 不得删除或覆盖用户文件；
    - 必须在每个需要用户的安全停点真正暂停，不得伪造授权、审批、发布、Secret 存储或 Desktop 重启成功；
    - 完整 Doctor 和真实双向消息/附件测试通过前，不得报告部署成功；
    - 工作期间提供简短进度更新，并在不需要用户操作时自主完成所有安全步骤。
```

## 设计说明

- Prompt 固定到明确 tag，避免安装过程读到正在变化的分支。
- `bootstrap.sh` 会安装仓库锁定的 Lark CLI，无需全局安装。
- 飞书应用创建/发布、管理员审批、OAuth、Secret 输入与 Desktop 重启仍是必须的人工停点。
- 本 Prompt 是全新独立安装流程，不包含旧机迁移或多机共用同一 Bot 的逻辑。
