# 给 Codex 的 macOS 极简升级协议

本协议把一台已安装 Feishu Codex Bridge 的 Mac 安全升级到私有固定版本 `v0.4.0-macos-rc.9`。健康路径中，用户只在前台升级器明确准备完成后按一次 `⌘Q` 完全退出 ChatGPT/Codex Desktop；独立 Terminal 会保留原有直连/代理模式，事务升级、自动重开 Desktop 并完成最终 Doctor。不得让用户复制或运行更新命令，也不得要求用户手工重开 Desktop。

本文锁定到 `v0.4.0-macos-rc.9`。后续版本不得沿用本文件中的 tag，必须重新发布并验证协议。

## 通过本链接调用升级代理

当用户引用本文件，要求 Codex 升级 Bridge 时，Codex 必须：

1. 完整读取本文件直到末尾，不得只做摘要；
2. 将下方“可复制 Prompt”视为用户的完整执行指令；
3. 在不需要用户操作时自主连续执行；
4. 正常路径只在前台升级器进入 `waiting-for-desktop-exit` 后暂停一次，要求用户按 `⌘Q`；
5. Full access、GitHub 认证、私有仓库访问、干净工作树或安全状态不满足时，明确说明阻塞项并暂停。

## 可复制 Prompt

```text
请把这台 Mac 上已有的 Feishu Codex Bridge 安全升级到私有固定 tag v0.4.0-macos-rc.9，并完整验收。

固定目标：
- 仓库：ninmon/feishu-codex-bridge-private
- tag：v0.4.0-macos-rc.9
- 平台：macOS only

健康路径中，我只负责在你明确提示后按 ⌘Q 完全退出 ChatGPT/Codex Desktop。独立可见 Terminal 必须自行完成升级、保留原网络模式、重开 Desktop 和最终 Doctor；不得要求我复制、粘贴或运行命令，也不得要求我手工重开 Desktop。

执行规则：

1. 如果当前 Codex 对话尚未设为“完全访问（Full access）”，先解释 Keychain、launchd、进程与私有安装目录检查需要该权限，要求我切换并暂停。“替我审批”不能解除沙盒边界；不得修改 Codex 全局配置或伪造检查。

2. 从只读预检开始，自动定位现有安装并核对：
   - 当前系统确为 macOS；
   - 本机 GitHub CLI 已登录且当前账号能读取 ninmon/feishu-codex-bridge-private；
   - 安装目录是该项目的 Git checkout；
   - 当前精确 tag、HEAD、所有 remote 和目标远端；
   - git status 包括全部未跟踪文件；
   - Bridge、Channel、共享 App Server、Desktop relay、watchdog 和 Desktop attachment 状态；
   - 已保存的 Desktop 直连/代理模式与活动 App Server 实际环境一致；
   - 是否存在本安装不拥有的自建 guardian、LaunchAgent 或守护进程。

   不得在聊天、日志或命令参数中输出 Token、App Secret、OAuth、App ID、open ID、chat ID、Codex task/session ID、本机配置内容或任务路径。

3. 在改变 checkout 或停止服务前，使用本机已登录的 GitHub CLI/Git 凭据确认目标 tag 已发布并解析到精确提交，然后完整读取该 tag 中的：
   - AGENTS.md；
   - docs/INSTALL_MACOS.md 的“更新固定版本”章节；
   - docs/releases/v0.4.0-macos-rc.9.md；
   - src/runtime/platform/macos/update-with-desktop-restart.sh。

   不得使用 main、其他 tag、公开 raw 文件或未认证的临时下载代替。

4. 工作树有任何已跟踪或未跟踪改动、目标 tag 不存在、GitHub 未认证、private remote 指向其他 URL、当前安装身份不明确、代理状态无法证明或发现可能被更新器影响的自建守护时，必须在停止服务或改变 checkout 前暂停。不得 reset、clean、stash、覆盖用户文件或删除自建守护。

5. 若当前安装已有名为 private 且精确指向 https://github.com/ninmon/feishu-codex-bridge-private.git 的远端，使用它；若没有同名远端，可在确认不存在冲突后添加该精确远端。不得改写 origin，不得把 GitHub Token 写进 URL、聊天或命令参数。

6. 保留现有 bridge.config.json、Keychain Secret、绑定、成员/Project 状态、Session 设置与权限、临时 Chat、队列、输入账本、附件草稿与缓存、投递状态、relay state、bootstrap 和原有代理模式。不得重新索取 App Secret、重新配置飞书应用、重新 OAuth，或再次询问直连/代理。

7. 预检全部通过后，从已认证的 private 精确 tag 提取目标版本的 src/runtime/platform/macos/update-with-desktop-restart.sh 到当前用户的安全临时目录。在现有安装仓库作为工作目录，以目标 tag v0.4.0-macos-rc.9 和 Remote private 启动这个目标版本入口。不得改用当前旧版本脚本、手工 checkout、后台 job、公开 raw URL 或自行拼装 Terminal 命令。

   该入口必须自行：
   - 从同一目标 tag 提取目标 runtime；
   - 将入口已验证并实际运行前台 worker 的 Node 绝对路径固定到事务环境，使 bootstrap、安装和回滚不依赖 Desktop 退出后的 Terminal PATH 或再次扫描应用 Bundle；
   - 创建独立、可见的 Terminal 更新任务；
   - 在 Desktop 仍运行时执行严格 Doctor、精确 tag/工作树预检和代理一致性检查；
   - 解析并锁定经过 OpenAI Bundle ID、签名身份和规范可执行路径共同验证的 Desktop；
   - 明确进入 waiting-for-desktop-exit，且调用端看到原样输出“Foreground upgrade is ready”后才算准备完成。

8. 只有入口明确输出“Foreground upgrade is ready”后，才提示用户：
   “前台升级器已经完成预检。请现在按 ⌘Q 完全退出 ChatGPT/Codex Desktop；不要自行重开。可见 Terminal 会自动升级、按原有直连/代理模式重开 Desktop，并完成最终验收。”

   不得自行杀死 Desktop，不得因 Terminal 窗口刚出现就提前提示，不得改变保存的代理模式。用户退出后，前台升级器必须等待经过验证的 Desktop 主进程和其内嵌 App Server 都自然退出；macOS 路径不复制 Windows 的残留进程强制结束逻辑。

9. 前台升级器必须调用目标版本的底层 update.mjs/update.sh 事务：保留私有状态、失败自动回滚；安装阶段首次失败时只允许进行一次幂等重试，两次失败则保留脱敏诊断并回滚；relay 已启用时即使 Bridge 当时停止，也要恢复 Bridge、relay 和 watchdog。更新后先执行严格 Doctor，再由目标 tag 的前台 runtime 重新验证保存的网络选择、活动 App Server 和 relay，并直接重开升级前已锁定的 Desktop，最后执行包含 Desktop attachment 的严格 Doctor。重开逻辑不得依赖成功或回滚后的仓库启动器认识新参数。失败且 Desktop 已退出时，必须使用同一独立恢复路径尝试按保存的网络模式打开 Desktop，并让 Terminal 保持可见。

10. Desktop 自动重开并回到本任务后，自主核对：
   - git describe --tags --exact-match 精确为 v0.4.0-macos-rc.9；
   - HEAD 与远端该 tag 的提交一致；
   - 工作树干净；
   - ./status-bridge.sh 正常；
   - ./doctor.sh --require-running --require-desktop-relay --require-desktop-attached 全部通过；
   - Bridge、Channel、共享 App Server、watchdog 和 Desktop attachment 健康；
   - 升级前保存的直连/代理模式未改变，活动 App Server 使用同一模式。

11. 任何更新失败都必须报告 updater 的安全摘要；只有 updater 已确认自动回滚且旧版本 Doctor 恢复通过时，才能说明已恢复。不得删除备份、凭据、配置或用户状态来“修复”。全部验证通过前不得报告升级成功。
```

## 设计边界

- `src/runtime/platform/macos/update-with-desktop-restart.sh` 是一次性前台编排入口；当前版本仓库中的 `update.sh --foreground` 会路由到它。`update.mjs` 仍负责备份、切换、安装、回滚和同版本自愈。
- 极简指健康路径不把命令交给用户，不代表跳过 Full access、私库认证、脏工作树、签名身份、relay heartbeat 或代理一致性检查。
- 前台升级器只跟踪由 Bundle metadata、OpenAI Team ID 和规范可执行路径共同确认的 Desktop。它等待用户 `⌘Q` 后自然退出，不按进程名广泛结束应用。
- 直连和本地代理都通过同一个持久选择恢复；前台任务只在内存中保留经过验证的 loopback 代理选择，不把它写入 Terminal 命令、状态摘要或聊天。
- 任何飞书应用、OAuth、Secret、成员、绑定和 Session 权限配置都不属于本次升级的外部变更。
