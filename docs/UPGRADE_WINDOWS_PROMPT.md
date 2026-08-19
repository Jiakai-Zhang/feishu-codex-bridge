# 给 Codex 的 Windows 极简升级协议

本协议把一台已安装 Feishu Codex Bridge 的 Windows 电脑安全升级到私有固定版本 `v0.4.0-windows-rc.3`。正常前置条件已经满足时，Codex 自行完成预检、独立 PowerShell 更新和 Doctor，用户只需在明确提示后完整重启 ChatGPT/Codex Desktop；不得要求用户复制或运行升级命令。

本文锁定到 `v0.4.0-windows-rc.3`。后续版本不得沿用本文件中的 tag，必须重新发布并验证协议。

## 通过本链接调用升级代理

当用户引用本文件，要求 Codex 升级 Bridge 时，Codex 必须：

1. 完整读取本文件直到末尾，不得只做摘要；
2. 将下方“可复制 Prompt”视为用户的完整执行指令；
3. 在不需要用户操作时自主连续执行；
4. 正常路径只在 Desktop 完整重启时暂停用户，不得把 PowerShell 命令转交用户执行；
5. Full access、GitHub 认证、私有仓库访问、干净工作树或安全状态不满足时，明确说明阻塞项并暂停。

## 可复制 Prompt

```text
请把这台 Windows 电脑上已有的 Feishu Codex Bridge 安全升级到私有固定 tag v0.4.0-windows-rc.3，并完整验收。

固定目标：
- 仓库：ninmon/feishu-codex-bridge-private
- tag：v0.4.0-windows-rc.3
- 平台：Windows only

正常健康路径中，我只负责在你明确提示后完全退出并重新打开 ChatGPT/Codex Desktop。你必须自行完成预检、准备并运行独立 PowerShell 更新、验证和最终 Doctor；不得要求我复制、粘贴或运行升级命令。

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
   - AGENTS.md
   - docs/INSTALL_AGENT.md 的升级章节
   - docs/releases/v0.4.0-windows-rc.3.md

   不得使用 main、其他 tag、公开 raw 文件或未认证的任意下载脚本代替。

4. 工作树有任何已跟踪或未跟踪改动、目标 tag 不存在、GitHub 未认证、private remote 指向其他 URL、当前安装身份不明确、网络模式无法证明或发现可能被更新器影响的自建守护时，必须在停止服务或改变 checkout 前暂停。不得 reset、clean、stash、覆盖用户文件或删除自建守护。

5. 若当前安装已有名为 private 且精确指向 https://github.com/ninmon/feishu-codex-bridge-private.git 的远端，使用它；若没有同名远端，可在确认不存在冲突后添加该精确远端。不得改写 origin，不得把 GitHub Token 写进 URL、聊天或命令参数。

6. 保留现有 bridge.config.json、DPAPI Secret、绑定、成员/Project 状态、Session 设置与权限、临时 Chat、队列、输入账本、附件草稿与缓存、投递状态、relay state、bootstrap 和原有代理模式。不得重新索取 App Secret、重新配置飞书应用、重新 OAuth，或再次询问直连/代理。

7. 预检全部通过后，由你自动打开并使用一个本机可见的独立 PowerShell 执行更新，不得要求用户输入命令：
   - 当前 updater 支持 Remote 参数时，运行 .\update.ps1 -Version v0.4.0-windows-rc.3 -Remote private；
   - 旧 updater 不支持 Remote 参数时，严格按照目标 Release Note，从已经验证的 private 精确 tag 提取目标 update.ps1 到系统临时目录，再以 -InstallRoot 当前安装目录、-Version v0.4.0-windows-rc.3、-Remote private 执行；
   - 不得用 main、手工 checkout、公开 raw URL、reset、clean 或 stash 代替事务 updater；
   - 独立 PowerShell 必须保持可见并明确显示成功或失败；
   - 如果当前工具无法可靠启动并监控独立 PowerShell，应在改变安装前说明阻塞，不得把命令转交用户后声称仍是自动升级。

8. updater 成功后，在要求用户重启 Desktop 前先核对精确 tag、HEAD、工作树、.\status-bridge.ps1，以及 .\doctor.ps1 -RequireRunning -RequireDesktopRelay。确认升级前保存的直连/代理模式未改变，活动 App Server 仍使用同一模式。

9. 上述验证全部通过后，只要求用户执行一个动作：
   “升级和严格 Doctor 已完成。请现在完全退出并重新打开 ChatGPT/Codex Desktop，然后回到本任务回复‘好了’。”

   不得自行杀死 Desktop，不得要求用户再执行 PowerShell 命令，也不得改变保存的代理模式。

10. 用户重新打开 Desktop 并回复后，再运行安全状态检查与严格 Doctor，确认 Bridge、Channel、共享 App Server、watchdog 和 Desktop relay 仍健康，精确 tag 仍为 v0.4.0-windows-rc.3。任何失败都先诊断；不得删除备份、凭据、配置或用户状态来绕过。全部验证通过前不得报告升级成功。
```

## 设计边界

- 极简指的是正常路径不再把命令交给用户，不代表跳过 Full access、私库认证、脏工作树或代理一致性检查。
- Windows updater 继续锁定并恢复原 Desktop 网络模式，保留 DPAPI 与运行状态，失败时自动回滚。
- 完整重启用于让 Desktop 重新读取经过验证的 relay 环境；Bridge 更新本身仍由独立 PowerShell 完成。
