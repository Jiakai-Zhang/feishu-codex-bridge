# 给 Codex 的极简安装与升级 Prompt

下面四段都是固定版本入口。复制对应代码块到目标电脑上的新 Codex 任务即可；完整规则位于所引用的 tag 文件中，不需要把长协议粘贴进对话。

## macOS 全新安装

```text
请使用本机已登录且有仓库访问权的 GitHub CLI，完整读取并执行以下私有固定版本协议：
仓库：ninmon/feishu-codex-bridge-private
tag：v0.4.0-macos-rc.6
文件：docs/INSTALL_MACOS_PROMPT.md
将文件中“可复制 Prompt”部分视为我的完整执行指令，不得改用 main、其他版本或仅做摘要。
GitHub CLI 未安装、未登录或无权访问时请暂停；不得索取或输出访问 Token。
```

## Windows 全新安装

```text
请使用本机已登录且有仓库访问权的 GitHub CLI，完整读取并执行以下私有固定版本协议：
仓库：ninmon/feishu-codex-bridge-private
tag：v0.4.0-windows-rc.3
文件：docs/INSTALL_WINDOWS_PROMPT.md
将文件中“可复制 Prompt”部分视为我的完整执行指令，不得改用 main、其他版本或仅做摘要。
GitHub CLI 未安装、未登录或无权访问时请暂停；不得索取或输出访问 Token。
```

## macOS 极简升级

正常健康路径由 Codex 完成预检、准备独立 Terminal、升级和 Doctor；用户只在提示后完整退出、等待 Terminal 成功并重新打开 Desktop。

```text
请使用本机已登录且有仓库访问权的 GitHub CLI，完整读取并执行以下私有固定版本协议：
仓库：ninmon/feishu-codex-bridge-private
tag：v0.4.0-macos-rc.6
文件：docs/UPGRADE_MACOS_PROMPT.md
将文件中“可复制 Prompt”部分视为我的完整执行指令，不得改用 main、其他版本或仅做摘要。
GitHub CLI 未安装、未登录或无权访问时请暂停；不得索取或输出访问 Token。
```

## Windows 极简升级

正常健康路径由 Codex 完成预检、独立 PowerShell 升级和 Doctor；用户只在提示后完整重启 Desktop。

```text
请使用本机已登录且有仓库访问权的 GitHub CLI，完整读取并执行以下私有固定版本协议：
仓库：ninmon/feishu-codex-bridge-private
tag：v0.4.0-windows-rc.3
文件：docs/UPGRADE_WINDOWS_PROMPT.md
将文件中“可复制 Prompt”部分视为我的完整执行指令，不得改用 main、其他版本或仅做摘要。
GitHub CLI 未安装、未登录或无权访问时请暂停；不得索取或输出访问 Token。
```

极简不表示跳过安全边界。协议仍会在 Full access、浏览器认证、飞书外部变更、Secret 安全输入、管理员审批、工作树异常、私库认证失败或代理状态无法证明时暂停。全新安装还必须完成真实双向消息与附件验收。
