export function compactTitle(value, max = 56) {
  const title = String(value || "未命名任务").replace(/\s+/g, " ").trim();
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds ? `${totalMinutes} 分 ${seconds} 秒` : `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

export function sanitizeProgressNote(value, max = 1600) {
  let text = String(value || "").replace(/\0/g, "").trim();
  // Do not let model-authored text create an accidental Feishu mention.
  text = text
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, "＠用户")
    .replace(/<at\b[^>]*\/?\s*>/gi, "＠用户");
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

function safeToolName(item) {
  const value = item?.tool || item?.name || item?.tool_name;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const compact = value.trim().replace(/[^\p{L}\p{N}_.:/-]+/gu, " ").slice(0, 60);
  return compact || undefined;
}

export function safeProgressUpdate(event) {
  if (!event || typeof event !== "object") return undefined;
  if (event.type === "thread.started") return { kind: "activity", text: "已连接所选任务" };
  if (event.type === "turn.started") return { kind: "activity", text: "开始分析请求" };
  if (event.type === "turn.completed") return { kind: "activity", text: "处理完成，正在整理回复" };
  if (event.type === "turn.failed" || event.type === "error") {
    return { kind: "activity", text: "处理遇到错误" };
  }
  if (event.type !== "item.started" && event.type !== "item.completed") return undefined;

  const item = event.item || {};
  const itemType = item.type;
  const completedEvent = event.type === "item.completed";

  // agent_message is deliberately authored for the user. It is safe to stream
  // as public commentary; reasoning item contents remain private and are never read.
  if (itemType === "agent_message" && completedEvent) {
    const text = sanitizeProgressNote(item.text);
    return text ? { kind: "note", text } : undefined;
  }

  if (itemType === "command_execution") {
    const exitCode = Number.isInteger(item.exit_code) ? `（退出码 ${item.exit_code}）` : "";
    return {
      kind: "activity",
      text: completedEvent ? `本地命令执行完成${exitCode}` : "正在执行本地命令",
    };
  }
  if (itemType === "file_change") {
    const changeCount = Array.isArray(item.changes) ? item.changes.length : 0;
    return {
      kind: "activity",
      text: completedEvent
        ? `文件修改完成${changeCount ? `（${changeCount} 项）` : ""}，正在验证`
        : "正在修改文件",
    };
  }
  if (itemType === "mcp_tool_call") {
    const toolName = safeToolName(item);
    const target = toolName ? ` ${toolName}` : "外部工具";
    return {
      kind: "activity",
      text: completedEvent ? `${target.trim()}调用完成` : `正在调用${target}`,
    };
  }

  const labels = {
    reasoning: completedEvent ? "分析阶段完成" : "正在分析",
    web_search: completedEvent ? "公开资料搜索完成" : "正在搜索公开资料",
    plan_update: completedEvent ? "执行计划已更新" : "正在更新执行计划",
    error: "Codex 报告了一条运行提示",
  };
  const label = labels[itemType];
  return label ? { kind: "activity", text: label } : undefined;
}

export function createStatusRenderer({
  config,
  projectContext,
  activeWorks,
  getActiveThreadId,
  isChannelConnected,
  bridgeStartedAt,
  getQueuedCount,
  deliveryOutbox,
  agentEventOutbox,
  auditLog,
  taskLeaseStore,
  getTemporaryChat,
  getLastWork,
  getThread,
}) {
  function buildStatusMarkdown(thread, snapshot, scopedThread) {
    const currentWork = activeWorks.get(getActiveThreadId());
    const lifecycle = snapshot?.lifecycle?.type;
    const idleState = lifecycle === "task_complete"
      ? "空闲（最近一轮已完成）"
      : lifecycle === "turn_aborted" ? "空闲（最近一轮已中止）" : "空闲";
    const lines = [
      "## 飞书 Codex 状态",
      "",
      `- Channel SDK：**${isChannelConnected() ? "已连接" : "正在重连"}**`,
      `- 桥接运行时间：${formatDuration(Date.now() - bridgeStartedAt)}`,
      `- 当前状态：**${currentWork ? currentWork.phase : idleState}**`,
      `- 并行运行：${activeWorks.size} 个任务`,
      `- 等待队列：${getQueuedCount()} 条`,
      `- 待补发结果：${deliveryOutbox.size()} 条`,
      `- 待补发 Agent 事件：${agentEventOutbox.size()} 条`,
      `- 审计链：${auditLog.size()} 条 · head \`${auditLog.headHash().slice(0, 12)}\``,
      `- 活跃分支租约：${taskLeaseStore.list().length} 条`,
      `- Project：**${config.project.name}**（\`${config.project.id}\`）`,
      `- 当前任务：${thread ? `**${compactTitle(thread.title, 80)}**` : "不存在"}`,
      `- 当前分支：${scopedThread?.worktree?.branch ? `\`${scopedThread.worktree.branch}\`` : "不在 Project 内"}`,
      `- 写入策略：${scopedThread?.worktree ? `\`${projectContext.effectiveSandbox(scopedThread.worktree, config.sandboxMode)}\`` : "不可用"}`,
      `- 模型：\`${thread?.model || "不可用"}\`（推理强度 \`${thread?.reasoning_effort || "不可用"}\`）`,
    ];
    const temporaryChat = getTemporaryChat();
    if (temporaryChat) lines.push(`- 临时 Chat：**${temporaryChat.status === "creating" ? "正在创建" : "已启用"}**`);
    if (currentWork) {
      lines.push(
        `- 本轮已运行：${formatDuration(Date.now() - currentWork.startedAt)}`,
        `- 最近进展：${currentWork.lastUpdate || "正在启动"}`,
        `- 进展更新时间：${formatTimestamp(currentWork.lastUpdateAt)}`,
      );
    } else {
      const lastWork = getLastWork();
      if (lastWork) lines.push(`- 上一条桥接任务：${lastWork.ok ? "已完成" : "失败"}（${formatTimestamp(lastWork.finishedAt)}）`);
    }
    if (thread?.updated_at_ms) lines.push(`- Codex 任务更新时间：${formatTimestamp(thread.updated_at_ms)}`);
    lines.push("", "> 状态直接读取桥接内存、本机数据库和 rollout，不调用语言模型。运行中的状态查询会绕过普通消息队列立即响应。");
    return lines.join("\n");
  }

  function buildCurrentMarkdown(thread, snapshot, scopedThread) {
    if (!thread) return `当前绑定的任务不存在：\`${getActiveThreadId()}\``;
    if (!scopedThread) return [
      `当前任务不属于 Project **${config.project.name}**，或记录分支已与 worktree 不一致；桥接已禁止继续运行。`,
      "",
      "请发送 `/threads` 选择 Project 内任务，或发送 `/new` 在当前 Project worktree 中创建任务。",
    ].join("\n");
    const capacity = capacityView(snapshot);
    const remaining = capacity.contextRemaining === undefined
      ? "不可用"
      : `${formatInteger(capacity.contextRemaining)} tokens（${formatPercent(capacity.contextRemainingPercent)}）`;
    const account = capacity.accountRemainingPercent === undefined ? "不可用" : formatPercent(capacity.accountRemainingPercent);
    const lines = [
      `当前绑定：**${compactTitle(thread.title, 100)}**`,
      "",
      `- 任务 ID：\`${thread.id}\``,
      `- Project：\`${config.project.id}\``,
      `- worktree：\`${scopedThread.worktree.path}\``,
      `- 分支：\`${scopedThread.worktree.branch || "detached"}\``,
      `- 沙箱：\`${projectContext.effectiveSandbox(scopedThread.worktree, config.sandboxMode)}\``,
      `- 模型：\`${thread.model || "不可用"}\``,
      `- 推理强度：\`${thread.reasoning_effort || "不可用"}\``,
      `- 当前上下文剩余：${remaining}`,
      `- 账户周期剩余：${account}`,
      "",
      "发送 `/model` 查看模型详情，发送 `/capacity` 查看容量详情。以上查询不调用语言模型。",
    ];
    const temporaryChat = getTemporaryChat();
    if (temporaryChat) {
      const base = getThread(temporaryChat.baseThreadId);
      lines.push("", `当前处于临时 Chat；发送 \`/endchat\` 返回：**${compactTitle(base?.title || temporaryChat.baseThreadId, 100)}**。`);
    }
    return lines.join("\n");
  }

  return { buildStatusMarkdown, buildCurrentMarkdown };
}

import { capacityView, formatInteger, formatPercent, formatTimestamp } from "../codex/codex-status.mjs";
