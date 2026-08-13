# 给 Codex 的安装 Prompt

## 推荐：固定测试版

把下面一段发到一个新的 Codex 任务：

```text
请按照 https://github.com/ninmon/feishu-codex-bridge/releases/tag/v0.1.0-beta.1 中的 AGENTS.md 和 docs/INSTALL_AGENT.md，在这台 Windows 电脑安装并部署 Codex Session Relay。先做只读预检；需要安装系统依赖、创建或修改飞书应用、浏览器授权、管理员审批、输入 App Secret、重启 Codex Desktop 时先说明并等我操作。不得在聊天、日志或仓库中输出 App Secret、token 或账户/会话标识。完成后运行 doctor，并实际验证飞书和 Desktop 双向消息。
```

固定 release tag 可以避免安装过程中读到正在变化的分支。

## 最短写法

```text
请按照 https://github.com/ninmon/feishu-codex-bridge/releases/tag/v0.1.0-beta.1 帮我安装部署这个应用。
```

Codex 应先读取 release 中的根目录 `AGENTS.md`，再进入确定性的安装协议。若安装代理没有读取这两个文件，不要让它继续处理飞书凭据。

## 默认分支合并后

当该 Beta 已合并到仓库默认分支后，也可以使用：

```text
请按照 https://github.com/Jiakai-Zhang/feishu-codex-bridge 帮我安装部署应用，并遵守仓库 AGENTS.md 的安装协议。
```
