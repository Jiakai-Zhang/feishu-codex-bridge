const COMMANDS = new Set(["status", "stop", "model", "plan", "goal", "queue", "settings", "attachments"]);

export class SessionCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionCommandError";
    this.code = code;
    this.publicMessage = message;
  }
}

export function parseSessionCommand(value) {
  const text = String(value || "").trim();
  const match = /^\/([a-z][a-z0-9-]*)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  if (!COMMANDS.has(name)) return undefined;
  return Object.freeze({ name, args: String(match[2] || "").trim(), raw: text });
}

export function parseQueueAction(value) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "status") return Object.freeze({ action: "status" });
  if (text.startsWith("--")) {
    const prompt = text.slice(2).trim();
    if (!prompt) usage("用法：`/queue -- <Prompt>`");
    return Object.freeze({ action: "enqueue", text: prompt });
  }
  if (text.toLowerCase() === "clear") return Object.freeze({ action: "clear" });
  const remove = /^remove\s+(\d+)$/i.exec(text);
  if (remove) {
    const position = Number(remove[1]);
    if (!Number.isSafeInteger(position) || position <= 0) usage("用法：`/queue remove <序号>`");
    return Object.freeze({ action: "remove", position });
  }
  if (/^(?:status|clear|remove)(?:\s|$)/i.test(text)) {
    usage("用法：`/queue`、`/queue <Prompt>`、`/queue remove <序号>` 或 `/queue clear`");
  }
  return Object.freeze({ action: "enqueue", text });
}

export function parseAttachmentsAction(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "status") return Object.freeze({ action: "status" });
  if (text === "clear") return Object.freeze({ action: "clear" });
  usage("用法：`/attachments` 或 `/attachments clear`");
}

export function parseSettingsAction(input) {
  const text = String(input || "").trim();
  if (!text || text.toLowerCase() === "status") return Object.freeze({ action: "status" });
  if (text.toLowerCase() === "reset") return Object.freeze({ action: "reset" });

  const match = /^(input|default|mode|progress|thinking|commentary|mention)\s+(\S+)$/i.exec(text);
  if (!match) {
    usage("用法：`/settings`、`/settings input steer|queue`、`/settings progress on|off`、`/settings mention on|off` 或 `/settings reset`");
  }
  const setting = match[1].toLowerCase();
  const value = match[2].toLowerCase();
  if (["input", "default", "mode"].includes(setting)) {
    if (!["steer", "queue"].includes(value)) usage("用法：`/settings input steer|queue`");
    return Object.freeze({ action: "input", value });
  }
  if (!["on", "off"].includes(value)) {
    usage(setting === "mention" ? "用法：`/settings mention on|off`" : "用法：`/settings progress on|off`");
  }
  return Object.freeze({ action: setting === "mention" ? "mention" : "progress", value: value === "on" });
}

function stateLabel(status) {
  switch (status?.type) {
    case "idle": return "空闲";
    case "active": return "正在回答";
    case "systemError": return "系统错误";
    case "notLoaded": return "未加载";
    default: return String(status?.type || "未知");
  }
}

function goalStatusLabel(status) {
  switch (status) {
    case "active": return "运行中";
    case "paused": return "已暂停";
    case "blocked": return "需要处理阻塞";
    case "usageLimited": return "用量受限";
    case "budgetLimited": return "预算已用尽";
    case "complete": return "已完成";
    default: return String(status || "未知");
  }
}

function modeLabel(mode) {
  return mode === "plan" ? "Plan" : mode === "default" ? "默认" : "未知";
}

function statusModeLabel(status) {
  const label = modeLabel(status?.settings?.collaborationMode?.mode);
  return status?.collaborationModeKnown === false ? `${label}（待原生事件确认）` : label;
}

function speedLabel(serviceTier, model) {
  if (serviceTier == null || ["", "default", "standard"].includes(String(serviceTier).toLowerCase())) return "标准";
  const tier = (model?.serviceTiers || []).find((entry) => entry?.id === serviceTier);
  if (tier?.name) return String(tier.name);
  if (["fast", "priority"].includes(String(serviceTier).toLowerCase())) return "Fast";
  return String(serviceTier);
}

function compactId(value) {
  const text = String(value || "");
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

export function formatGoalStatus(goal, { heading = "Goal" } = {}) {
  if (!goal) {
    return `### ${heading}\n\n当前任务没有 Goal。\n\n使用 \`/goal start <目标>\` 创建。`;
  }
  const budget = goal.tokenBudget == null ? "不限" : Number(goal.tokenBudget).toLocaleString("zh-CN");
  const used = Number(goal.tokensUsed || 0).toLocaleString("zh-CN");
  const seconds = Math.max(0, Number(goal.timeUsedSeconds || 0));
  return [
    `### ${heading}`,
    "",
    `> ${String(goal.objective || "（无目标文本）").replace(/\r?\n/g, "\n> ")}`,
    "",
    `- 状态：${goalStatusLabel(goal.status)}`,
    `- Token：${used} / ${budget}`,
    `- 已运行：${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`,
  ].join("\n");
}

function promptPreview(value, maxChars = 100) {
  const text = String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "'")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function queueWaitReason(status) {
  if (!status?.connected) return "App Server 未连接";
  if (status?.goal?.status === "active") return "Goal 运行中";
  if (status?.status?.type === "active") return "当前回答完成";
  if (status?.status?.type === "idle") return "即将开始";
  return `会话恢复空闲（当前：${stateLabel(status?.status)}）`;
}

function inputModeLabel(inputMode) {
  return inputMode === "queue" ? "排队新 Turn（queue）" : "调整当前回答（steer）";
}

export function formatSessionSettings(settings, { changed = false } = {}) {
  const value = settings || {};
  return [
    `### Session 设置${changed ? "已更新" : ""}`,
    "",
    `- 普通消息：${inputModeLabel(value.inputMode)}`,
    `- 公开进度：${value.publicProgress ? "开启" : "关闭"}`,
    `- 最终回答提醒：${value.finalMention === false ? "关闭" : "开启（@你）"}`,
    "",
    "命令：`/settings input steer|queue`、`/settings progress on|off`、`/settings mention on|off`、`/settings reset`",
    "",
    "> `/settings reset` 会复制当前“新绑定默认设置”到本 Session。",
    "",
    "> 最终回答提醒只在 Turn 的最终消息中 @你；公开进度始终不会 @。",
    "",
    "> “公开进度（非隐藏思维链）”只转发 Codex 标记为 commentary 的阶段说明；不会转发隐藏思维链、raw reasoning 或工具原始输出。",
  ].join("\n");
}

export function formatGlobalSessionSettings(settings, { changed = false } = {}) {
  const value = settings || {};
  return [
    `### 新绑定默认设置${changed ? "已更新" : ""}`,
    "",
    `- 普通消息：${inputModeLabel(value.inputMode)}`,
    `- 公开进度：${value.publicProgress ? "开启" : "关闭"}`,
    `- 最终回答提醒：${value.finalMention === false ? "关闭" : "开启（@你）"}`,
    "",
    "私聊命令：`/settings input steer|queue`、`/settings progress on|off`、`/settings mention on|off`、`/settings reset`",
    "",
    "> 只在此后成功创建绑定时复制给新 Session；已有绑定群不会随全局默认变化。群内 `/settings` 仍只修改该 Session。",
    "",
    "> 最终回答提醒只在 Turn 的最终消息中 @你；公开进度始终不会 @。",
    "",
    "> “公开进度（非隐藏思维链）”不会转发隐藏思维链、raw reasoning 或工具原始输出。",
  ].join("\n");
}

export function formatPromptQueue(entries, { status } = {}) {
  const queue = Array.isArray(entries) ? entries : [];
  const lines = ["### 下一轮队列", ""];
  if (queue.length === 0) {
    lines.push("当前没有待执行 Prompt。", "", "使用 `/queue <Prompt>` 将内容作为独立的新 Turn 排队。 ");
    return lines.join("\n");
  }
  lines.push(`- 等待：${queue.length} 条`);
  if (status) lines.push(`- 启动条件：${queueWaitReason(status)}`);
  lines.push("");
  for (const [index, entry] of queue.slice(0, 10).entries()) {
    const attachmentCount = Array.isArray(entry?.attachments) ? entry.attachments.length : 0;
    const fallback = attachmentCount > 0 ? `（${attachmentCount} 个附件）` : "（无文本）";
    lines.push(`${index + 1}. ${promptPreview(entry?.text) || fallback}`);
  }
  if (queue.length > 10) lines.push(`…另有 ${queue.length - 10} 条未显示`);
  lines.push(
    "",
    "使用 `/queue remove <序号>` 删除一条，或 `/queue clear` 清空所有待执行项。",
  );
  return lines.join("\n");
}

export function formatAttachmentDraft(entries) {
  const records = Array.isArray(entries) ? entries : [];
  const attachments = records.flatMap((record) => Array.isArray(record?.attachments) ? record.attachments : []);
  const lines = ["### 待提交附件", ""];
  if (attachments.length === 0) {
    lines.push("当前没有暂存附件。", "", "先发送文件，再发送普通文字 Prompt；Bridge 会把它们合并为一次输入。");
    return lines.join("\n");
  }
  lines.push(`当前暂存 ${attachments.length} 个附件：`, "");
  for (const [index, attachment] of attachments.entries()) {
    lines.push(`${index + 1}. ${promptPreview(attachment?.name) || "未命名附件"}`);
  }
  lines.push(
    "",
    "下一条普通文字 Prompt 会与以上全部附件一起提交；Bridge 命令不会消耗它们。",
    "",
    "发送 `/attachments clear` 可放弃这些暂存附件。",
  );
  return lines.join("\n");
}

export function formatSessionStatus(status, { queueEntries = [], attachmentDraftEntries = [], relaySettings } = {}) {
  const settings = status?.settings || {};
  const activeFlags = Array.isArray(status?.status?.activeFlags) ? status.status.activeFlags : [];
  const usage = status?.tokenUsage?.total;
  const lines = [
    "### Codex 会话状态",
    "",
    `- App Server：${status?.connected ? "已连接" : "未连接"}`,
    `- 会话：${stateLabel(status?.status)}`,
  ];
  if (status?.activeTurnId) lines.push(`- 当前 Turn：${compactId(status.activeTurnId)}`);
  if (activeFlags.includes("waitingOnApproval")) lines.push("- 等待：审批");
  if (activeFlags.includes("waitingOnUserInput")) lines.push("- 等待：用户输入");
  lines.push(
    `- 模型：${settings.model || "未知"}`,
    `- 推理强度：${settings.effort || "默认"}`,
    `- 速度：${speedLabel(settings.serviceTier)}`,
    `- 模式：${statusModeLabel(status)}`,
    `- 普通消息：${inputModeLabel(relaySettings?.inputMode)}`,
    `- 公开进度：${relaySettings?.publicProgress ? "开启" : "关闭"}`,
    `- 最终回答提醒：${relaySettings?.finalMention === false ? "关闭" : "开启（@你）"}`,
  );
  if (usage) {
    lines.push(`- 上下文累计：${Number(usage.totalTokens || 0).toLocaleString("zh-CN")} tokens`);
  }
  if (status?.goal) {
    lines.push(`- Goal：${goalStatusLabel(status.goal.status)}（${Number(status.goal.tokensUsed || 0).toLocaleString("zh-CN")} tokens）`);
  } else {
    lines.push("- Goal：无");
  }
  lines.push(`- 下一轮队列：${queueEntries.length} 条`);
  const stagedAttachmentCount = attachmentDraftEntries
    .flatMap((entry) => Array.isArray(entry?.attachments) ? entry.attachments : [])
    .length;
  lines.push(`- 待提交附件：${stagedAttachmentCount} 个`);
  if (queueEntries.length > 0) {
    lines.push(`- 下一条：${promptPreview(queueEntries[0]?.text) || "（无文本）"}`);
    lines.push(`- 队列等待：${queueWaitReason(status)}`);
  }
  return lines.join("\n");
}

async function executeAttachments(command, context) {
  const { attachmentDraftStore, threadId } = context;
  if (!attachmentDraftStore) throw new TypeError("Attachment command execution requires a draft store");
  const request = parseAttachmentsAction(command.args);
  if (request.action === "status") return formatAttachmentDraft(attachmentDraftStore.list(threadId));
  const removed = await attachmentDraftStore.clear(threadId);
  const count = removed.reduce((sum, record) => sum + (record.attachments?.length || 0), 0);
  return count > 0
    ? `### 暂存附件已清空\n\n已放弃 ${count} 个附件；当前 Turn 和下一轮队列不受影响。`
    : "### 暂存附件已经为空\n\n没有需要清除的附件。";
}

function currentModelEntry(view) {
  const selected = String(view?.settings?.model || "").toLowerCase();
  return (view?.models || []).find((model) => [model.id, model.model]
    .some((value) => String(value || "").toLowerCase() === selected));
}

export function formatModelView(view, { changed = false } = {}) {
  const settings = view?.settings || {};
  const selected = currentModelEntry(view);
  const efforts = (selected?.supportedReasoningEfforts || []).map((option) => option.reasoningEffort);
  const tiers = [
    ...(selected?.serviceTiers || []).map((tier) => tier.name || tier.id),
    ...(selected?.serviceTiers?.length ? [] : (selected?.additionalSpeedTiers || [])),
  ].filter((value, index, list) => value && list.indexOf(value) === index);
  const lines = [
    `### 模型设置${changed ? "已更新" : ""}`,
    "",
    `- 模型：${settings.model || "未知"}`,
    `- 推理强度：${settings.effort || selected?.defaultReasoningEffort || "默认"}`,
    `- 速度：${speedLabel(settings.serviceTier, selected)}`,
    `- 模式：${view?.collaborationModeKnown === false ? `${modeLabel(settings.collaborationMode?.mode)}（待原生事件确认）` : modeLabel(settings.collaborationMode?.mode)}`,
  ];
  if (efforts.length > 0) lines.push(`- 可用推理强度：${efforts.join(" / ")}`);
  lines.push(`- 可用速度：标准${tiers.length > 0 ? ` / ${tiers.join(" / ")}` : ""}`);
  if (!changed) {
    lines.push("", "#### 可用模型");
    for (const [index, model] of (view?.models || []).entries()) {
      lines.push(`${index + 1}. ${model.displayName || model.model || model.id}（\`${model.model || model.id}\`）${model.isDefault ? " · 默认" : ""}`);
    }
    lines.push(
      "",
      "命令：`/model <编号或模型>`、`/model effort <强度>`、`/model speed standard|fast`、`/model reset`",
    );
  } else {
    lines.push("", "设置已写入该任务；若当前回答正在运行，将从下一轮起完整生效。");
  }
  return lines.join("\n");
}

function usage(message) {
  throw new SessionCommandError("command_usage", message);
}

async function executeModel(command, context) {
  const { controller, threadId } = context;
  if (!command.args || command.args.toLowerCase() === "status") {
    return formatModelView(await controller.getModelView(threadId, { refreshCatalog: true }));
  }
  const [action, ...rest] = command.args.split(/\s+/);
  const tail = rest.join(" ").trim();
  const lower = action.toLowerCase();
  if (["effort", "reasoning"].includes(lower)) {
    if (!tail) usage("用法：`/model effort <推理强度>`");
    await controller.updateModel(threadId, { effort: tail.toLowerCase() });
  } else if (lower === "speed") {
    const value = tail.toLowerCase();
    if (!value || !["standard", "fast"].includes(value)) usage("用法：`/model speed standard|fast`");
    await controller.updateModel(threadId, { serviceTier: value === "standard" ? null : value });
  } else if (lower === "set") {
    if (!tail) usage("用法：`/model set <编号或模型>`");
    await controller.updateModel(threadId, { model: tail });
  } else if (lower === "reset") {
    if (tail) usage("用法：`/model reset`");
    await controller.updateModel(threadId, { reset: true });
  } else {
    await controller.updateModel(threadId, { model: command.args });
  }
  return formatModelView(await controller.getModelView(threadId), { changed: true });
}

async function executePlan(command, context) {
  const { controller, threadId } = context;
  const action = (command.args || "status").toLowerCase();
  if (action === "status") {
    const status = await controller.getStatus(threadId);
    return [
      "### Plan 模式",
      "",
      `当前：${statusModeLabel(status)}`,
      "",
      "使用 `/plan on` 进入原生 Plan 模式，使用 `/plan off` 返回默认模式。",
    ].join("\n");
  }
  if (!["on", "off"].includes(action)) usage("用法：`/plan`、`/plan on` 或 `/plan off`");
  const mode = await controller.setPlan(threadId, action === "on");
  return `### Plan 模式已更新\n\n当前：${modeLabel(mode.mode)}\n\n设置作用于该任务后续输入；Plan 与 Goal 是两条独立生命周期。`;
}

async function executeGoal(command, context) {
  const { controller, threadId } = context;
  if (!command.args || command.args.toLowerCase() === "status") {
    return formatGoalStatus(await controller.getGoal(threadId, { refresh: true }));
  }
  const match = /^(start|replace|pause|resume|clear|budget)(?:\s+([\s\S]*))?$/i.exec(command.args);
  if (!match) usage("用法：`/goal start <目标>`、`/goal pause|resume|clear`、`/goal replace <目标>`、`/goal budget <tokens|none>`");
  const action = match[1].toLowerCase();
  const tail = String(match[2] || "").trim();
  let result;
  if (action === "start") {
    if (!tail) usage("用法：`/goal start <目标>`");
    result = await controller.startGoal(threadId, tail);
  } else if (action === "replace") {
    if (!tail) usage("用法：`/goal replace <目标>`");
    result = await controller.replaceGoal(threadId, tail);
  } else if (action === "pause") {
    if (tail) usage("用法：`/goal pause`");
    result = await controller.pauseGoal(threadId);
  } else if (action === "resume") {
    if (tail) usage("用法：`/goal resume`");
    result = await controller.resumeGoal(threadId);
  } else if (action === "clear") {
    if (tail) usage("用法：`/goal clear`");
    await controller.clearGoal(threadId);
    return "### Goal 已清除\n\n自动续跑已停止，目标状态已从该任务移除。";
  } else if (action === "budget") {
    if (!tail) usage("用法：`/goal budget <tokens|none>`");
    const budget = ["none", "unlimited", "不限"].includes(tail.toLowerCase()) ? null : integer(tail);
    if (budget === undefined || budget === 0) usage("Goal token 预算必须是正整数，或使用 `none` 取消预算。 ");
    result = await controller.setGoalBudget(threadId, budget);
  }
  return formatGoalStatus(result, { heading: "Goal 已更新" });
}

async function executeQueue(command, context) {
  const { controller, threadId, promptQueue, enqueuePrompt } = context;
  if (!promptQueue) throw new TypeError("Queue command execution requires a prompt queue");
  const request = parseQueueAction(command.args);
  if (request.action === "status") {
    const status = await controller.getStatus(threadId);
    return formatPromptQueue(promptQueue.list(threadId), { status });
  }
  if (request.action === "remove") {
    const removed = await promptQueue.removeAt(threadId, request.position);
    return [
      "### 已移除排队 Prompt",
      "",
      `原第 ${request.position} 条已删除：${promptPreview(removed.text) || `（${removed.attachments?.length || 0} 个附件）`}`,
      `当前仍有 ${promptQueue.count(threadId)} 条等待。`,
    ].join("\n");
  }
  if (request.action === "clear") {
    const count = await promptQueue.clear(threadId);
    return count > 0
      ? `### 队列已清空\n\n已删除 ${count} 条待执行 Prompt；当前正在运行的 Turn 不受影响。`
      : "### 队列已经为空\n\n没有待执行 Prompt；当前正在运行的 Turn 不受影响。";
  }
  if (typeof enqueuePrompt !== "function") throw new TypeError("Queue enqueue requires the Feishu message context");
  const queued = await enqueuePrompt(request.text);
  return [
    `### ${queued.alreadyQueued ? "已在下一轮队列中" : "已加入下一轮队列"}`,
    "",
    `- 当前排位：${queued.position}`,
    "- 执行方式：任务空闲后作为独立的新 Turn 开始",
    "- 普通消息：由 `/settings` 的默认输入方式决定",
  ].join("\n");
}

async function executeSettings(command, context) {
  const { settingsStore, threadId } = context;
  if (!settingsStore) throw new TypeError("Settings command execution requires a Session settings store");
  const request = parseSettingsAction(command.args);
  if (request.action === "status") return formatSessionSettings(settingsStore.get(threadId));
  if (request.action === "reset") {
    return formatSessionSettings(await settingsStore.reset(threadId), { changed: true });
  }
  const patch = request.action === "input"
    ? { inputMode: request.value }
    : request.action === "progress"
      ? { publicProgress: request.value }
      : { finalMention: request.value };
  return formatSessionSettings(await settingsStore.update(threadId, patch), { changed: true });
}

export async function executeGlobalSettingsCommand(command, { settingsStore } = {}) {
  if (command?.name !== "settings") throw new TypeError("A parsed settings command is required");
  if (!settingsStore) throw new TypeError("Global settings command requires a Session settings store");
  const request = parseSettingsAction(command.args);
  if (request.action === "status") return formatGlobalSessionSettings(settingsStore.getDefaults());
  if (request.action === "reset") {
    return formatGlobalSessionSettings(await settingsStore.resetDefaults(), { changed: true });
  }
  const patch = request.action === "input"
    ? { inputMode: request.value }
    : request.action === "progress"
      ? { publicProgress: request.value }
      : { finalMention: request.value };
  return formatGlobalSessionSettings(await settingsStore.updateDefaults(patch), { changed: true });
}

export async function executeSessionCommand(command, context) {
  if (!command || !COMMANDS.has(command.name)) throw new TypeError("A parsed session command is required");
  const { controller, threadId } = context;
  if (!controller || !threadId) throw new TypeError("Command execution requires a controller and threadId");
  if (command.name === "status") {
    if (command.args) usage("用法：`/status`");
    return formatSessionStatus(await controller.getStatus(threadId), {
      queueEntries: context.promptQueue?.list(threadId) || [],
      attachmentDraftEntries: context.attachmentDraftStore?.list(threadId) || [],
      relaySettings: context.settingsStore?.get(threadId),
    });
  }
  if (command.name === "stop") {
    if (command.args) usage("用法：`/stop`");
    const result = await controller.interrupt(threadId, { pauseGoal: true });
    if (!result.interrupted && !result.goalPaused) return "### 无需中止\n\n当前任务没有正在运行的回答。";
    const queued = context.promptQueue?.count(threadId) || 0;
    return [
      "### 已中止",
      "",
      result.interrupted ? "当前回答已收到中止请求。" : "当前没有活动回答。",
      result.goalPaused ? "活动 Goal 已先暂停，不会自动继续下一轮。" : "",
      queued > 0 ? `队列中的 ${queued} 条 Prompt 保持不变，将在会话空闲后继续；如需取消请使用 \`/queue clear\`。` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (command.name === "model") return executeModel(command, context);
  if (command.name === "plan") return executePlan(command, context);
  if (command.name === "queue") return executeQueue(command, context);
  if (command.name === "attachments") return executeAttachments(command, context);
  if (command.name === "settings") return executeSettings(command, context);
  return executeGoal(command, context);
}

export function publicCommandFailure(error) {
  if (error?.publicMessage) return error.publicMessage;
  switch (error?.code) {
    case "goal_active": return "当前有运行中的 Goal。请先使用 `/goal pause`，再进入 Plan 模式。";
    case "goal_missing": return "当前任务没有 Goal。可使用 `/goal start <目标>` 创建。";
    case "goal_objective_required": return "Goal 目标不能为空。";
    case "goal_budget_invalid": return "Goal token 预算必须是正整数或 `none`。";
    case "model_unknown": return "没有在当前 Codex 模型目录中找到该模型。请先发送 `/model` 查看动态列表。";
    case "reasoning_effort_unsupported":
    case "service_tier_unsupported": return error.message;
    case "collaboration_mode_unavailable": return "当前 Codex 没有提供所需的原生模式预设。";
    case "session_busy": return "当前会话状态刚刚发生变化，请查看 `/status` 后重试。";
    case "queue_full": return "下一轮队列已满。请先使用 `/queue` 查看，并通过 `/queue remove <序号>` 或 `/queue clear` 腾出空间。";
    case "queue_position_invalid": return "该队列序号不存在。请先发送 `/queue` 查看当前队列。";
    case "queue_message_conflict": return "这条飞书消息已经关联到另一条排队 Prompt，没有重复加入。";
    case "attachment_draft_full": return "暂存附件数量已达到上限。请先发送文字 Prompt，或使用 `/attachments clear` 清空后重试。";
    case "attachment_draft_total_too_large": return "暂存附件总大小已达到上限。请先发送文字 Prompt，或使用 `/attachments clear` 清空后重试。";
    case "attachment_draft_busy": return "暂存附件正在提交，请稍后重试。";
    case "attachment_draft_conflict": return "这条飞书附件消息已关联到另一份暂存记录，没有重复加入。";
    case "codex_app_server_unavailable": return "本机共享 Codex 服务当前未连接，请稍后重试。";
    default: return "命令执行失败。请查看 `/status` 后重试。";
  }
}
