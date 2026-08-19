# 给 Codex 的安装 Prompt

## Windows 全新安装

把下面两行复制到新 Windows 电脑上的一个新 Codex 任务。完整执行要求都在固定版本链接内：

```text
请按照以下 GitHub 安装协议，在这台 Windows 电脑上部署并完整验收 Feishu Codex Bridge：
https://raw.githubusercontent.com/ninmon/feishu-codex-bridge/v0.3.2-windows-rc.4/docs/INSTALL_WINDOWS_PROMPT.md
```

协议会先强制当前对话切换为 Full access（“替我审批”不能代替），再安装锁定的 Lark CLI，按计算机名创建专用应用，立即用 DPAPI 保存 Secret，始终交付浏览器认证备用 URL，通过一次官方模板确认配置权限/事件，明确询问直连或本机代理，并使用 `$feishu-session-bind` 完成初次绑定。详见 [Windows 完整安装 Prompt](INSTALL_WINDOWS_PROMPT.md)。

## macOS 全新安装

把下面内容复制到新 Mac 上的一个新 Codex 任务。私有仓库必须由本机已登录且有访问权的 GitHub CLI 读取：

```text
请使用本机已登录且有仓库访问权的 GitHub CLI，完整读取并执行以下私有固定版本中的安装协议：
仓库：ninmon/feishu-codex-bridge-private
tag：v0.3.2-macos-rc.12
文件：docs/INSTALL_MACOS_PROMPT.md
将文件中“可复制 Prompt”部分视为我的完整执行指令，不得改用 main 或其他版本。
如果 GitHub CLI 未安装、未登录或没有仓库权限，请明确告诉我并暂停，不得索取或输出访问 Token。
```

详见 [macOS 完整安装 Prompt](INSTALL_MACOS_PROMPT.md)。

## Windows 从旧版升级

```text
请按照目标 Windows release 中的 AGENTS.md、docs/INSTALL_AGENT.md 和 Release Note，把这台电脑上已有的 Feishu Codex Bridge 安全升级到我指定的精确 tag。先只读检查安装目录、origin、精确 tag、git status、Bridge、Desktop relay 的已保存直连/代理模式与可能存在的自建 watchdog/guardian；必须使用 update.ps1 -Version <目标 tag>，保留 bridge.config.json、DPAPI App Secret、绑定、成员/个人 Project 状态、设置、队列、账本、附件缓存、投递状态、relay state 和 bootstrap，不得 reset、clean、stash，也不得停止或删除自建守护。健康状态必须沿用原网络模式，不能默认改成直连；无法证明时在改变 checkout 前停止。完成后核对精确 tag，并运行 status-bridge.ps1 与严格 Doctor。
```

新安装必须使用已存在的固定 tag，不得用 `main` 伪装成固定版本。
