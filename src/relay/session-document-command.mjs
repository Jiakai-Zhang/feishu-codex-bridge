export function parseSessionDocumentAction(value) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "status") return Object.freeze({ action: "status" });
  if (text.toLowerCase() === "create") return Object.freeze({ action: "create" });
  if (text.toLowerCase() === "summarize") return Object.freeze({ action: "summarize" });
  if (text.toLowerCase() === "unbind") return Object.freeze({ action: "unbind" });
  const bind = /^bind\s+([\s\S]+)$/i.exec(text);
  if (bind) return Object.freeze({ action: "bind", url: bind[1].trim() });
  const error = new Error("Invalid document summary command");
  error.code = "command_usage";
  error.publicMessage = "用法：`/doc`、`/doc create`、`/doc bind <飞书文档URL>`、`/doc summarize` 或 `/doc unbind`";
  throw error;
}

function formatTimestamp(value, timeZone = "Asia/Shanghai") {
  if (!Number.isFinite(Number(value))) return "尚未同步";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(Number(value)));
}

export function formatSessionDocumentStatus(record, {
  changed,
  timeZone = "Asia/Shanghai",
} = {}) {
  if (!record) {
    return [
      "### 持续摘要文档",
      "",
      "当前群尚未关联文档。",
      "",
      "发送 `/doc create` 新建独立文档，或 `/doc bind <飞书文档URL>` 关联已有文档。",
    ].join("\n");
  }
  const pending = Array.isArray(record.pending) ? record.pending.length : 0;
  const lines = [
    `### 持续摘要文档${changed ? "已更新" : ""}`,
    "",
    `- 文档：[打开飞书文档](${record.documentUrl})`,
    `- 群标签页：${record.tabId ? "已固定" : "等待自动固定"}`,
    `- 待总结：${pending} 个新回合`,
    `- 最近同步：${formatTimestamp(record.lastSyncedAt, timeZone)}`,
  ];
  if (record.lastErrorCode) lines.push(`- 最近状态：同步待重试（${record.lastErrorCode}）`);
  else lines.push("- 最近状态：正常");
  if (record.tabLastErrorCode) lines.push(`- 标签页状态：待重试（${record.tabLastErrorCode}）`);
  lines.push(
    "",
    "> 自动更新只提交“上次摘要 + 新回合”，不会反复读取完整聊天历史或整份文档。",
    "",
    "命令：`/doc summarize` 立即同步，`/doc unbind` 解除关联但不删除文档。",
  );
  return lines.join("\n");
}

export async function executeSessionDocumentCommand(command, context) {
  const service = context?.summaryCoordinator;
  const binding = context?.summaryBinding;
  if (!service || !binding?.groupChatId || !binding?.threadId) {
    const error = new Error("Document summaries require a fixed Session group binding");
    error.code = "summary_document_fixed_group_required";
    throw error;
  }
  const request = parseSessionDocumentAction(command.args);
  const options = { timeZone: context.timeZone };
  if (request.action === "status") {
    return formatSessionDocumentStatus(service.status(binding.groupChatId), options);
  }
  if (request.action === "create") {
    const record = await service.create({
      groupChatId: binding.groupChatId,
      threadId: binding.threadId,
      title: context.summaryTitle,
    });
    return formatSessionDocumentStatus(record, { ...options, changed: true });
  }
  if (request.action === "bind") {
    const record = await service.bind({
      groupChatId: binding.groupChatId,
      threadId: binding.threadId,
      url: request.url,
    });
    return formatSessionDocumentStatus(record, { ...options, changed: true });
  }
  if (request.action === "unbind") {
    await service.unbind(binding.groupChatId);
    return "### 已解除持续摘要文档\n\n本地关联和待处理增量已移除；飞书文档本身没有被删除。";
  }
  const record = await service.syncNow(binding.groupChatId);
  return formatSessionDocumentStatus(record, { ...options, changed: true });
}
