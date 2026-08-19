# 给 Codex 的 Windows 极简升级协议

本协议把一台已安装 Feishu Codex Bridge 的 Windows 电脑安全升级到私有固定版本 `v0.4.0-windows-rc.5`。正常健康路径由 Codex 启动目标 release 自带的可见前台升级器；用户只需在明确提示后关闭 ChatGPT/Codex Desktop 可见窗口，升级器会安全结束已验证为同一 Desktop 可执行文件的残留 package 进程、事务更新、按原直连/代理模式自动重开 Desktop，并完成严格 Doctor。不得要求用户复制、粘贴或运行升级命令。

本文锁定到 `v0.4.0-windows-rc.5`。后续版本不得沿用本文件中的 tag，必须重新发布并验证协议。

## 通过本链接调用升级代理

当用户引用本文件并要求 Codex 升级 Bridge 时，Codex 必须：

1. 完整读取本文件直到末尾，不得只做摘要；
2. 将下方“可复制 Prompt”视为用户的完整执行指令；
3. 在不需要用户操作时自主连续执行；
4. 正常路径只在要求用户关闭 Desktop 可见窗口时暂停一次，不得把 PowerShell 命令转交用户执行；
5. Full access、GitHub 认证、私有仓库访问、干净工作树或安全状态不满足时，明确说明阻塞项并暂停。

## 可复制 Prompt

```text
请把这台 Windows 电脑上已有的 Feishu Codex Bridge 安全升级到私有固定 tag v0.4.0-windows-rc.5，并完整验收。

固定目标：
- 仓库：ninmon/feishu-codex-bridge-private
- tag：v0.4.0-windows-rc.5
- 平台：Windows only

正常健康路径中，我只负责在你明确提示后关闭 ChatGPT/Codex Desktop 可见窗口，不负责结束后台残留、重新打开或执行任何命令。你必须自行完成只读预检，启动目标 release 的 update-windows-with-desktop-restart.ps1，等待它确认前台窗口已经准备好；窗口关闭后，由该窗口安全结束已验证的残留 Desktop 进程、完成事务升级、按原有代理模式自动重开 Desktop 和最终 Doctor。

执行规则：

1. 运行任何命令前，如果当前 Codex 对话尚未设为“完全访问（Full access）”，先解释 DPAPI、PowerShell、Scheduled Task、进程和私有安装目录检查需要该权限，要求我切换并暂停。“替我审批（Approve for me）”不能解除沙盒边界，不得修改 Codex 全局配置或 Windows 安全机制代替。

2. 从只读预检开始，自动定位现有安装并核对：
   - 当前系统确为 Windows；
   - 本机 GitHub CLI 已登录且当前账号能读取 ninmon/feishu-codex-bridge-private；
   - 安装目录是该项目的 Git checkout；
   - 当前精确 tag、HEAD、所有 remote 和目标远端；
   - git status 包括全部未跟踪文件；
   - Bridge、Channel、共享 App Server、Desktop relay 和 Scheduled Task watchdog 状态；
   - 已保存的 Desktop 直连/代理模式与活动 App Server 进程记录一致；
   - 是否存在本安装不拥有的自建 guardian、计划任务、服务或守护进程。

   不得在聊天、日志或命令参数中输出 Token、App Secret、OAuth、App ID、open ID、chat ID、Codex task/session ID、本机配置内容或任务路径。

3. 在改变 checkout 或停止服务前，使用本机已登录的 GitHub CLI/Git 凭据确认目标 tag 已发布并解析到精确提交，然后完整读取该 tag 中的：
   - AGENTS.md；
   - docs/INSTALL_AGENT.md 的升级章节；
   - docs/releases/v0.4.0-windows-rc.5.md；
   - update-windows-with-desktop-restart.ps1；
   - update.ps1。

   不得使用 main、其他 tag、公开 raw 文件或未认证的任意下载脚本代替。

4. 工作树有任何已跟踪改动或普通未跟踪文件、目标 tag 不存在、GitHub 未认证、private remote 指向其他 URL、当前安装身份不明确、网络模式无法证明或发现可能被更新器影响的自建守护时，必须在停止服务或改变 checkout 前暂停。不得 reset、clean、stash、覆盖用户文件或删除自建守护。

   唯一例外是配置所指 runtime 恰好位于 checkout 内、且未跟踪内容全部位于 updater 自己生成的 upgrade-backups/。不要删除或移动这些恢复备份；交给目标 release 的 -PreflightOnly 校验确认，任何其他改动仍必须停止。

5. 若当前安装已有名为 private 且精确指向 https://github.com/ninmon/feishu-codex-bridge-private.git 的远端，使用它；若没有同名远端，可在确认不存在冲突后添加该精确远端。不得改写 origin，不得把 GitHub Token 写进 URL、聊天或命令参数。

6. 保留现有 bridge.config.json、DPAPI Secret、绑定、成员/Project 状态、Session 设置与权限、临时 Chat、队列、输入账本、附件草稿与缓存、投递状态、relay state、bootstrap、恢复备份和原有代理模式。不得重新索取 App Secret、重新配置飞书应用、重新 OAuth，或再次询问直连/代理。

7. 预检全部通过后，从已经验证的 private 精确 tag 提取 update-windows-with-desktop-restart.ps1 到当前用户临时目录，并以目标 tag v0.4.0-windows-rc.5、当前安装目录和 Remote private 调用它。不得改用当前旧版本的临时 monitor、后台 job、Start-Process 子进程、main、手工 checkout、公开 raw URL、reset、clean 或 stash。

   该入口必须自行创建一个当前用户、Interactive、Limited、无自动触发器的一次性 Scheduled Task，并在可见 Windows PowerShell 中运行。它必须先从目标 tag 提取目标 update.ps1，执行 -PreflightOnly 和严格 Doctor；只有全部通过才进入 waiting-for-desktop-exit。升级代理必须等待入口明确输出“Foreground upgrade is ready”，不得凭窗口出现就假定成功。

8. 前台升级器准备完成后，只要求我执行一个动作：
   “前台升级预检已通过。请现在关闭 ChatGPT/Codex Desktop 窗口，不要自己重新打开；可见 PowerShell 会安全结束已验证的残留 Desktop 进程、完成升级、按原网络模式自动重开 Desktop 并验收。”

   在用户关闭可见窗口前不得杀死 Desktop，也不得要求我回复后再关或运行 PowerShell。窗口关闭后，只能结束启动时记录且可执行路径完全一致的 Desktop 残留进程；不得按宽泛进程名结束共享 App Server、其他 Codex CLI 或无关进程。当前 Codex 任务暂时中断是正常现象；一次性 Scheduled Task 必须独立继续运行。

9. 前台升级器必须按顺序完成：记录启动时已验证的 Desktop 可执行路径并等待可见窗口关闭；结束路径完全一致的残留 Desktop package 进程；运行目标 release 的事务 update.ps1；核对精确 tag、HEAD 和干净工作树；运行严格 Doctor；用 launch-codex-desktop-with-relay.ps1 显式传回升级前保存的 -Proxy 或 -NoProxy；packaged Desktop 必须从当前 AppX 清单解析真实可执行文件并直接注入代理；自动重开 Desktop；再次运行严格 Doctor 并写入 completed 状态。思考过程、临时监控进程或当前 Codex 进程都不能承担这个生命周期。

10. Desktop 自动重开并能继续本任务后，读取前台升级状态并再次安全核对精确 tag、HEAD、git status、status-bridge.ps1 和 doctor.ps1 -RequireRunning -RequireDesktopRelay，确认版本为 v0.4.0-windows-rc.5、Bridge/Channel/共享 App Server/watchdog/Desktop relay 健康，且原有代理模式未改变。只有这些都通过才能报告升级成功。

11. 任何失败都必须保留可见 PowerShell 错误和 updater 恢复备份。前台升级器若在 Desktop 退出后失败，必须尝试用原网络模式重开当前或已回滚版本的 Desktop，并保持失败窗口可见等待人工确认。不得删除备份、凭据、配置或用户状态来绕过；自动重开也失败时，报告阻塞，不得伪造成功。
```

## 设计边界

- 极简指正常路径不再把命令交给用户，不代表跳过 Full access、私库认证、脏工作树或代理一致性检查。
- `update-windows-with-desktop-restart.ps1` 是一次性前台编排入口；`update.ps1` 仍是负责备份、切换和回滚的底层事务升级器。
- 一次性 Scheduled Task 没有登录或定时触发器，成功或失败结束后会注销，不会成为第二套常驻 guardian。
- Desktop 重开必须使用升级前已证明的显式直连/代理选择，不能依赖当前 Codex 进程继承的偶然环境变量。
