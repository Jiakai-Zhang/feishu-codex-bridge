# 给 Codex 的 macOS 极简升级协议

本协议把一台已安装 Feishu Codex Bridge 的 Mac 安全升级到私有固定版本 `v0.4.0-macos-rc.6`。正常前置条件已经满足时，用户只需要按一次提示完全退出 ChatGPT/Codex Desktop，等待独立 Terminal 明确显示升级成功，再重新打开 Desktop；Codex 必须自行完成其余预检、更新窗口准备、升级和验收，不得让用户复制或运行更新命令。

本文锁定到 `v0.4.0-macos-rc.6`。后续版本不得沿用本文件中的 tag，必须重新发布并验证协议。

## 通过本链接调用升级代理

当用户引用本文件，要求 Codex 升级 Bridge 时，Codex 必须：

1. 完整读取本文件直到末尾，不得只做摘要；
2. 将下方“可复制 Prompt”视为用户的完整执行指令；
3. 在不需要用户操作时自主连续执行；
4. 正常路径只在 Desktop 完整退出与重新打开时暂停用户，不得把 Terminal 命令转交用户执行；
5. Full access、GitHub 认证、私有仓库访问、干净工作树或安全状态不满足时，明确说明阻塞项并暂停。

## 可复制 Prompt

```text
请把这台 Mac 上已有的 Feishu Codex Bridge 安全升级到私有固定 tag v0.4.0-macos-rc.6，并完整验收。

固定目标：
- 仓库：ninmon/feishu-codex-bridge-private
- tag：v0.4.0-macos-rc.6
- 平台：macOS only

正常健康路径中，我只负责在你明确提示后完全退出 ChatGPT/Codex Desktop，等待独立 Terminal 显示升级成功，再重新打开 Desktop。你必须自行完成预检、准备并启动独立更新 Terminal、执行升级和最终 Doctor；不得要求我复制、粘贴或运行更新命令。

执行规则：

1. 如果当前 Codex 对话尚未设为“完全访问（Full access）”，先解释 Keychain、launchd、进程与私有安装目录检查需要该权限，要求我切换并暂停。不得用“替我审批”、修改 Codex 全局配置或伪造检查代替。

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
   - AGENTS.md
   - docs/INSTALL_MACOS.md 的更新章节
   - docs/releases/v0.4.0-macos-rc.6.md

   不得使用 main、其他 tag、公开 raw 文件或未认证的临时下载代替。

4. 只允许使用仓库提供的 ./update.sh。工作树有任何已跟踪或未跟踪改动、目标 tag 不存在、GitHub 未认证、private remote 指向其他 URL、当前安装身份不明确、代理状态无法证明或发现可能被更新器影响的自建守护时，必须在停止服务或改变 checkout 前暂停。不得 reset、clean、stash、覆盖用户文件或删除自建守护。

5. 若当前安装已有名为 private 且精确指向 https://github.com/ninmon/feishu-codex-bridge-private.git 的远端，使用它；若没有同名远端，可在确认不存在冲突后添加该精确远端。不得改写 origin，不得把 GitHub Token 写进 URL、聊天或命令参数。

6. 保留现有 bridge.config.json、Keychain Secret、绑定、成员/Project 状态、Session 设置与权限、临时 Chat、队列、输入账本、附件草稿与缓存、投递状态、relay state、bootstrap 和原有代理模式。不得重新索取 App Secret、重新配置飞书应用、重新 OAuth，或再次询问直连/代理。

7. 预检全部通过后，由你在现有仓库目录自动准备并启动一个本机可见、独立于当前 Codex 进程的 Terminal 更新任务：
   - 独立任务必须等待 ChatGPT/Codex Desktop 及其内嵌 App Server 完全退出后再运行 updater；
   - 只在该独立任务中移除继承的 CODEX_THREAD_ID/CODEX_SESSION_ID，不能修改用户或 Codex 全局环境；
   - 最终执行的仓库入口必须是 ./update.sh --version v0.4.0-macos-rc.6 --remote private；
   - Terminal 必须保持可见并明确显示成功或失败；
   - 不得要求用户输入、复制、粘贴或运行该命令；
   - 如果当前工具无法可靠准备这个独立任务，应在让用户退出 Desktop 之前说明阻塞，不得假装已经安排。

8. 只有独立 Terminal 已经准备完毕并确认会在 Desktop 退出后自动执行时，才提示用户：
   “更新窗口已经准备好。请现在完全退出 ChatGPT/Codex Desktop；等待独立 Terminal 明确显示 Upgrade completed successfully 后，再重新打开 Desktop 并回到本任务回复‘好了’。”

   不得自行杀死 Desktop，不得要求用户再执行其他命令，也不得改变保存的代理模式。

9. 用户重新打开 Desktop 并回复后，自主核对：
   - git describe --tags --exact-match 精确为 v0.4.0-macos-rc.6；
   - HEAD 与远端该 tag 的提交一致；
   - 工作树干净；
   - ./status-bridge.sh 正常；
   - ./doctor.sh --require-running --require-desktop-relay --require-desktop-attached 全部通过；
   - Bridge、Channel、共享 App Server、watchdog 和 Desktop attachment 健康；
   - 升级前保存的直连/代理模式未改变，活动 App Server 使用同一模式。

10. 任何更新失败都必须报告 updater 的安全摘要；只有 updater 已确认自动回滚且旧版本 Doctor 恢复通过时，才能说明已恢复。不得删除备份、凭据、配置或用户状态来“修复”。全部验证通过前不得报告升级成功。
```

## 设计边界

- 极简指的是正常路径不再把命令交给用户，不代表跳过 Full access、私库认证、脏工作树或代理一致性检查。
- macOS updater 拒绝从活动 Codex/Desktop 进程内自更新，因此必须先由 Codex 准备独立可见的更新任务，再让用户退出和重开 Desktop。
- 更新器继续负责精确 tag、备份、回滚、launchd 重建、relay/watchdog 恢复和严格 Doctor。
