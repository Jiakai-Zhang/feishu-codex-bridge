import path from "node:path";
import { sameFsPath } from "../../../runtime/shared/fs-paths.mjs";

function inlineCode(value) {
  return `\`${String(value || "").replaceAll("`", "'")}\``;
}

function compact(value, max = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function parseNewCommandArgument(argument) {
  const value = String(argument || "").trim();
  if (!value.startsWith("--branch")) return { topic: value };
  const match = value.match(/^--branch(?:=|\s+)(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { error: "用法：`/new --branch task/LOGIN-123 修复登录问题`" };
  return { branch: match[1], topic: String(match[2] || "").trim() };
}

export function parseThreadsCommandArgument(argument) {
  const value = String(argument || "").trim();
  if (!value) return {};
  const match = value.match(/^branch\s+(.+)$/i);
  if (!match || !match[1].trim()) return { error: "用法：`/threads branch task/LOGIN-123`" };
  return { branch: match[1].trim() };
}

export function buildProjectMarkdown(config, snapshot, selectedThread, desktopStatus) {
  const current = selectedThread?.worktree;
  const desktopState = !desktopStatus?.stateReadable
    ? "无法读取本机 Codex Desktop 状态"
    : !desktopStatus.registered
      ? "未发现该 Git 根目录的 Desktop Project"
      : desktopStatus.configurationMatches
        ? "已注册（根目录与配置 ID 匹配）"
        : "已注册，但配置中的 Desktop Project ID 不匹配";
  const desktopProjectId = desktopStatus?.projectId || config.project.desktopProjectId || "未配置";
  const desktopProjectName = desktopStatus?.name || config.project.desktopProjectName || "未配置";
  return [
    `## Bridge Project：${config.project.name}`,
    "",
    `- Bridge Project ID：${inlineCode(config.project.id)}`,
    `- Git 根目录：${inlineCode(config.project.repoRoot)}`,
    `- 默认分支：${inlineCode(config.project.defaultBranch)}${config.project.protectDefaultBranch ? "（只读保护）" : ""}`,
    `- 新 worktree 根目录：${inlineCode(config.project.worktreeRoot || "未配置")}`,
    `- 允许的远端：${config.project.allowedRemotes.map(inlineCode).join("、")}`,
    `- 已注册 worktree：${snapshot.worktrees.length} 个`,
    `- 当前 worktree：${current ? inlineCode(current.path) : "尚未选择 Project 内任务"}`,
    `- 当前分支：${current?.branch ? inlineCode(current.branch) : "不可用"}`,
    `- 当前 Codex 任务：${selectedThread?.id ? inlineCode(selectedThread.id) : "尚未选择"}`,
    "",
    "### Codex Desktop Project",
    "",
    `- 注册状态：${desktopState}`,
    `- Desktop Project：${inlineCode(desktopProjectName)}`,
    `- Desktop Project ID：${inlineCode(desktopProjectId)}`,
    "",
    "> Bridge Project 是执行和安全边界；Desktop Project 是 Codex Desktop 侧边栏的分组。两者不是同一层对象。",
    "",
    "> `/threads`、`/use`、`/new` 和普通消息都会验证 cwd 是否属于 Bridge Project 的已注册 worktree；切换任务不会执行 git checkout。当前 Desktop 的独立 App Server 不接受 `projectId`，因此 `/new` 创建的任务不会自动进入 Desktop Project 分组，但仍会按 cwd 出现在 Codex 任务记录中。",
  ].join("\n");
}

export function buildBranchesMarkdown(config, snapshot) {
  const worktreeByBranch = new Map(snapshot.worktrees.filter(({ branch }) => branch).map((worktree) => [worktree.branch, worktree]));
  const local = snapshot.branches.filter(({ kind }) => kind === "local").slice(0, 100);
  const remote = snapshot.branches
    .filter(({ kind, name }) => kind === "remote" && config.project.allowedRemotes.some((allowed) => name.startsWith(`${allowed}/`)))
    .slice(0, 100);
  const localLines = local.length ? local.map((branch) => {
    const worktree = worktreeByBranch.get(branch.name);
    const protection = branch.name === config.project.defaultBranch && config.project.protectDefaultBranch ? " · 默认分支只读" : "";
    return `- ${inlineCode(branch.name)}${worktree ? ` · worktree ${inlineCode(worktree.path)}` : ""}${protection}`;
  }) : ["- 无本地分支"];
  const remoteLines = remote.length
    ? remote.map((branch) => `- ${inlineCode(branch.name)} · ${branch.head.slice(0, 12)}`)
    : ["- 未发现允许远端中的分支"];
  return [
    `## ${config.project.name} 分支`,
    "",
    "### 本地分支",
    "",
    ...localLines,
    "",
    "### 远端分支（本地 refs 快照）",
    "",
    ...remoteLines,
    "",
    "> 该命令只读取本地 Git refs，不自动 fetch。使用 `/new --branch <分支> <主题>` 创建或复用独立 worktree。",
  ].join("\n");
}

export function buildWorktreesMarkdown(config, snapshot, projectThreads, activeThreadId) {
  const lines = snapshot.worktrees.map((worktree, index) => {
    const threads = projectThreads.filter((thread) => sameFsPath(thread.worktree.path, worktree.path));
    const selected = threads.some(({ id }) => id === activeThreadId) ? " · 当前" : "";
    const branch = worktree.branch || (worktree.detached ? "detached" : "unknown");
    const flags = [worktree.locked ? "locked" : "", worktree.prunable ? "prunable" : ""].filter(Boolean);
    return [
      `${index + 1}. ${inlineCode(branch)}${selected}${flags.length ? ` · ${flags.join(", ")}` : ""}`,
      `   ${inlineCode(worktree.path)}`,
      `   HEAD ${inlineCode((worktree.head || "").slice(0, 12))} · Codex 任务 ${threads.length} 个`,
    ].join("\n");
  });
  return [
    `## ${config.project.name} worktree`,
    "",
    ...(lines.length ? lines : ["当前没有位于允许范围内的 Git worktree。"]),
    ...(snapshot.excludedWorktrees.length ? ["", `> 另有 ${snapshot.excludedWorktrees.length} 个 Git worktree 位于 Project 允许范围之外，桥接不会访问。`] : []),
  ].join("\n");
}

export function buildProjectThreadsMarkdown(threads, { branch } = {}) {
  const lines = threads.map((thread, index) => [
    `${index + 1}. ${compact(thread.title || "未命名任务", 64)}`,
    `   ${inlineCode(thread.id)}`,
    `   ${inlineCode(thread.worktree.branch || "detached")} · ${inlineCode(path.basename(thread.worktree.path))}`,
  ].join("\n"));
  return [
    `## Project 内的 Codex 任务${branch ? ` · ${inlineCode(branch)}` : ""}`,
    "",
    ...(lines.length ? lines : ["没有找到符合条件的 Codex 任务。"]),
    "",
    "发送 `/use 2` 切换到本列表中的第 2 个任务；只允许切换到当前 Project 的已注册 worktree。",
  ].join("\n");
}
