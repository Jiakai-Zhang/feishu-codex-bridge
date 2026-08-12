function inlineCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

export function parseAuditLimit(argument) {
  const value = String(argument || "").trim();
  if (!value) return 20;
  if (!/^\d+$/.test(value)) return undefined;
  const limit = Number(value);
  return limit >= 1 && limit <= 100 ? limit : undefined;
}

export function buildAuditMarkdown(records, headHash) {
  const lines = records.map((record) => [
    `- #${record.sequence} ${inlineCode(record.type)} · ${inlineCode(record.actor)}`,
    `  ${new Date(record.timestamp).toISOString()}${record.taskId ? ` · task ${inlineCode(record.taskId)}` : ""} · hash ${inlineCode(record.hash.slice(0, 12))}`,
  ].join("\n"));
  return [
    "## Bridge 审计链",
    "",
    `- 当前 head：${inlineCode(headHash)}`,
    `- 返回记录：${records.length} 条`,
    "",
    ...(lines.length ? lines : ["尚无审计记录。"]),
    "",
    "> 这里只显示事件类型、actor、任务和哈希摘要；提示词、结果、凭据与完整路径不会进入审计展示。",
  ].join("\n");
}

export function buildMetricsMarkdown(metrics) {
  const taskStates = Object.entries(metrics.taskStates || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${inlineCode(state)}=${count}`)
    .join("、") || "none";
  return [
    "## Bridge 运行指标",
    "",
    `- Channel：**${metrics.channelConnected ? "connected" : "disconnected"}**`,
    `- 等待队列：${metrics.queuedWorkCount}`,
    `- 飞书结果发件箱：${metrics.deliveryOutboxSize}`,
    `- Agent 事件发件箱：${metrics.agentEventOutboxSize}`,
    `- 协作任务：${metrics.teamTaskCount}（${taskStates}）`,
    `- Team Hub 条目：${metrics.knowledgeCount}`,
    `- 审计记录：${metrics.auditCount} · head ${inlineCode(metrics.auditHead.slice(0, 12))}`,
    `- 活跃分支租约：${metrics.taskLeaseCount}`,
    `- Executor：${inlineCode(metrics.executorType)} · capabilities ${Object.entries(metrics.executorCapabilities).filter(([, enabled]) => enabled).map(([name]) => inlineCode(name)).join("、")}`,
  ].join("\n");
}
