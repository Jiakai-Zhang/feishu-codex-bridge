import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createLarkChannel } from "@larksuite/channel";
import {
  buildCapacityMarkdown,
  buildModelMarkdown,
  capacityView,
  formatInteger,
  formatPercent,
  formatTimestamp,
  readLatestRolloutSnapshot,
} from "./codex-status.mjs";
import { DeliveryOutbox, deliveryIdempotencyKey } from "./delivery-outbox.mjs";
import { runProcess } from "./process-runner.mjs";
import { createRolloutCompletionWatcher } from "./rollout-completion.mjs";
import { streamCodexInSingleMessage } from "./stream-progress.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(scriptDir, "bridge.config.json"), "utf8"));
const userProfile = process.env.USERPROFILE;
if (!userProfile) throw new Error("USERPROFILE is required to locate the Codex state database");
const runtimeDir = path.join(config.workspace, "work", "feishu-codex-bridge");
const pidPath = path.join(runtimeDir, "bridge.pid");
const stopPath = path.join(runtimeDir, "stop.request");
const statePath = path.join(runtimeDir, "completed.json");
const selectionPath = path.join(runtimeDir, "selected-thread.json");
const deliveryOutboxPath = path.join(runtimeDir, "pending-deliveries.json");
const codexStateDbPath = path.join(userProfile, ".codex", "state_5.sqlite");

const appSecret = process.env.LARK_APP_SECRET;
delete process.env.LARK_APP_SECRET;
if (!appSecret) throw new Error("LARK_APP_SECRET was not supplied by the secure launcher");

await fs.mkdir(runtimeDir, { recursive: true });
await fs.rm(stopPath, { force: true });
await fs.writeFile(pidPath, String(process.pid), "utf8");
const deliveryOutbox = await DeliveryOutbox.open(deliveryOutboxPath);

let completed = new Set();
try {
  const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
  completed = new Set(Array.isArray(saved) ? saved : []);
} catch (error) {
  if (error?.code !== "ENOENT") log("state file was unreadable; starting with an empty dedupe set");
}

let activeThreadId = config.threadId;
try {
  const selected = JSON.parse(await fs.readFile(selectionPath, "utf8"));
  if (typeof selected.threadId === "string") activeThreadId = selected.threadId;
} catch (error) {
  if (error?.code !== "ENOENT") log("thread selection file was unreadable; using the configured task");
}

const bridgeStartedAt = Date.now();
let channelConnected = false;
let activeWork;
let lastWork;
let queuedWorkCount = 0;
let workTail = Promise.resolve();
let completedWriteTail = Promise.resolve();

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function safeError(error) {
  if (error && typeof error === "object" && "code" in error) return `code=${String(error.code)}`;
  return error instanceof Error ? error.message : String(error);
}

function withStateDb(callback) {
  const db = new DatabaseSync(codexStateDbPath, { readOnly: true });
  try { return callback(db); }
  finally { db.close(); }
}

function getThread(threadId) {
  return withStateDb((db) => db.prepare(
    `select id, title, cwd, rollout_path, updated_at_ms, model, reasoning_effort,
      model_provider, cli_version, tokens_used, git_branch
     from threads where id = ? and coalesce(thread_source, 'user') = 'user' limit 1`,
  ).get(threadId));
}

function listRecentThreads(limit = 10) {
  return withStateDb((db) => db.prepare(
    "select id, title, cwd, updated_at_ms from threads where archived = 0 and coalesce(thread_source, 'user') = 'user' order by updated_at_ms desc limit ?",
  ).all(limit));
}

function normalizeCwd(cwd) {
  return typeof cwd === "string" ? cwd.replace(/^\\\\\?\\/, "") : config.workspace;
}

function compactTitle(value, max = 56) {
  const title = String(value || "未命名任务").replace(/\s+/g, " ").trim();
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds ? `${totalMinutes} 分 ${seconds} 秒` : `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

async function persistCompleted(messageId) {
  completed.add(messageId);
  const recent = [...completed].slice(-1000);
  completed = new Set(recent);
  completedWriteTail = completedWriteTail.then(
    () => fs.writeFile(statePath, JSON.stringify(recent, null, 2), "utf8"),
    () => fs.writeFile(statePath, JSON.stringify(recent, null, 2), "utf8"),
  );
  await completedWriteTail;
}

async function selectThread(thread) {
  activeThreadId = thread.id;
  await fs.writeFile(selectionPath, JSON.stringify({
    threadId: thread.id,
    title: thread.title,
    selectedAt: new Date().toISOString(),
  }, null, 2), "utf8");
}

async function getThreadSnapshot(thread) {
  if (!thread?.rollout_path) return undefined;
  try {
    return await readLatestRolloutSnapshot(normalizeCwd(thread.rollout_path));
  } catch (error) {
    log(`status snapshot unavailable for ${thread.id}: ${safeError(error)}`);
    return undefined;
  }
}

function commandName(content) {
  const trimmed = String(content || "").trim();
  const separator = trimmed.search(/\s/);
  return separator < 0 ? trimmed : trimmed.slice(0, separator);
}

const immediateCommands = new Set([
  "/status", "/model", "/capacity", "/quota", "/current", "/threads", "/help",
]);

function updateActiveWork(update) {
  if (!activeWork || !update?.text) return;
  activeWork.phase = update.kind === "note" ? "Codex 正在处理" : update.text;
  activeWork.lastUpdate = update.text;
  activeWork.lastUpdateAt = Date.now();
}

function enqueueWork(task) {
  queuedWorkCount += 1;
  const runTask = async () => {
    queuedWorkCount -= 1;
    return task();
  };
  const result = workTail.then(runTask, runTask);
  workTail = result.then(() => undefined, () => undefined);
  return result;
}

function buildStatusMarkdown(thread, snapshot) {
  const lifecycle = snapshot?.lifecycle?.type;
  const idleState = lifecycle === "task_complete"
    ? "空闲（最近一轮已完成）"
    : lifecycle === "turn_aborted"
      ? "空闲（最近一轮已中止）"
      : "空闲";
  const lines = [
    "## 飞书 Codex 状态",
    "",
    `- Channel SDK：**${channelConnected ? "已连接" : "正在重连"}**`,
    `- 桥接运行时间：${formatDuration(Date.now() - bridgeStartedAt)}`,
    `- 当前状态：**${activeWork ? activeWork.phase : idleState}**`,
    `- 等待队列：${queuedWorkCount} 条`,
    `- 待补发结果：${deliveryOutbox.size()} 条`,
    `- 当前任务：${thread ? `**${compactTitle(thread.title, 80)}**` : "不存在"}`,
    `- 模型：\`${thread?.model || "不可用"}\`（推理强度 \`${thread?.reasoning_effort || "不可用"}\`）`,
  ];
  if (activeWork) {
    lines.push(
      `- 本轮已运行：${formatDuration(Date.now() - activeWork.startedAt)}`,
      `- 最近进展：${activeWork.lastUpdate || "正在启动"}`,
      `- 进展更新时间：${formatTimestamp(activeWork.lastUpdateAt)}`,
    );
  } else if (lastWork) {
    lines.push(`- 上一条桥接任务：${lastWork.ok ? "已完成" : "失败"}（${formatTimestamp(lastWork.finishedAt)}）`);
  }
  if (thread?.updated_at_ms) lines.push(`- Codex 任务更新时间：${formatTimestamp(thread.updated_at_ms)}`);
  lines.push("", "> 状态直接读取桥接内存、本机数据库和 rollout，不调用语言模型。运行中的状态查询会绕过普通消息队列立即响应。");
  return lines.join("\n");
}

function buildCurrentMarkdown(thread, snapshot) {
  if (!thread) return `当前绑定的任务不存在：\`${activeThreadId}\``;
  const capacity = capacityView(snapshot);
  const remaining = capacity.contextRemaining === undefined
    ? "不可用"
    : `${formatInteger(capacity.contextRemaining)} tokens（${formatPercent(capacity.contextRemainingPercent)}）`;
  const account = capacity.accountRemainingPercent === undefined
    ? "不可用"
    : formatPercent(capacity.accountRemainingPercent);
  return [
    `当前绑定：**${compactTitle(thread.title, 100)}**`,
    "",
    `- 任务 ID：\`${thread.id}\``,
    `- 模型：\`${thread.model || "不可用"}\``,
    `- 推理强度：\`${thread.reasoning_effort || "不可用"}\``,
    `- 当前上下文剩余：${remaining}`,
    `- 账户周期剩余：${account}`,
    "",
    "发送 `/model` 查看模型详情，发送 `/capacity` 查看容量详情。以上查询不调用语言模型。",
  ].join("\n");
}

async function createCodexThread(topic, onProgress) {
  const tempDir = await fs.mkdtemp(path.join(runtimeDir, "new-thread-"));
  const answerPath = path.join(tempDir, "answer.md");
  const compactTopic = String(topic || "从飞书新建的任务").replace(/\s+/g, " ").trim().slice(0, 200);
  const prompt = [
    compactTopic,
    "",
    "[飞书新任务初始化]",
    "这是创建空白 Codex 任务的初始化消息。不要执行命令、修改文件或调用外部工具；只回复：新任务已创建，可以开始了。",
  ].join("\n");
  let newThreadId;

  try {
    const result = await runProcess(config.codexExecutable, [
      "exec",
      "--sandbox",
      "read-only",
      "--cd",
      config.workspace,
      "--skip-git-repo-check",
      "--json",
      "--output-last-message",
      answerPath,
      "-",
    ], {
      input: prompt,
      cwd: config.workspace,
      onStdoutLine: (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            newThreadId = event.thread_id;
          }
          const update = safeProgressUpdate(event);
          if (update) onProgress?.(update);
          return event.type === "turn.completed";
        } catch {}
        return false;
      },
    });

    if (result.code !== 0 && !result.logicalCompletionSeen) {
      throw new Error(`Codex new task failed with exit code ${result.code}`);
    }
    if (!newThreadId) throw new Error("Codex did not return a new task ID");
    const thread = getThread(newThreadId);
    if (!thread) throw new Error(`New Codex task was not persisted: ${newThreadId}`);
    return thread;
  } finally {
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(`${path.resolve(runtimeDir)}${path.sep}`)) {
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
}

function sanitizeProgressNote(value, max = 1600) {
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

function safeProgressUpdate(event) {
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

async function askCodex(content, onProgress) {
  const tempDir = await fs.mkdtemp(path.join(runtimeDir, "turn-"));
  const answerPath = path.join(tempDir, "answer.md");
  const activeThread = getThread(activeThreadId);
  if (!activeThread) throw new Error(`Selected Codex task no longer exists: ${activeThreadId}`);
  const activeWorkspace = normalizeCwd(activeThread.cwd);
  const rolloutPath = normalizeCwd(activeThread.rollout_path);
  let completionWatcher;
  try {
    completionWatcher = await createRolloutCompletionWatcher(rolloutPath, {
      stableMs: Number(config.completionStableMs) || 15_000,
    });
  } catch (error) {
    log(`completion watcher unavailable for ${activeThreadId}: ${safeError(error)}`);
  }
  let lastAgentMessage = "";
  const prompt = [
    "[来自已验证的飞书私聊]",
    content.slice(0, config.maxInputChars),
    "",
    "请直接处理并回答这条消息。当前通道具有完全本机权限，可以读写文件和执行命令。对于递归删除、覆盖重要数据、重置凭据或权限、强制推送、清空数据库及其他难以恢复的操作，必须先向用户说明具体影响并取得明确确认。",
    "处理过程中，请像 Codex 桌面端一样，在开始主要阶段、得到关键发现或下一步发生变化时，主动发送一两句简短、可公开的过程说明：说清楚准备做什么、刚发现了什么、接下来做什么。不要逐字输出隐藏思维链，也不要在过程说明里粘贴凭据、完整命令、命令输出或敏感路径。",
  ].join("\n");

  try {
    const result = await runProcess(config.codexExecutable, [
      "exec",
      "--sandbox",
      config.sandboxMode,
      "--cd",
      activeWorkspace,
      "--skip-git-repo-check",
      "--json",
      "--output-last-message",
      answerPath,
      "resume",
      "--all",
      activeThreadId,
      "-",
    ], {
      input: prompt,
      cwd: activeWorkspace,
      onStdoutLine: (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "item.completed" && event.item?.type === "agent_message") {
            const text = sanitizeProgressNote(event.item.text, config.maxReplyChars);
            if (text) lastAgentMessage = text;
          }
          const update = safeProgressUpdate(event);
          if (update) onProgress?.(update);
          return event.type === "turn.completed";
        } catch {}
        return false;
      },
      completionProbe: completionWatcher ? () => completionWatcher.poll() : undefined,
      completionPollMs: Number(config.completionPollMs) || 30_000,
      onCompletionProbeError: (error) => log(`completion watcher poll failed: ${safeError(error)}`),
    });

    if (result.code !== 0 && !result.logicalCompletionSeen) {
      throw new Error(`Codex resume failed with exit code ${result.code}`);
    }
    if (result.forcedAfterLogicalCompletion) {
      log("Codex process tree was stopped after durable turn completion while the CLI remained alive");
    }
    let answer = "";
    try { answer = (await fs.readFile(answerPath, "utf8")).trim(); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!answer) answer = String(result.recoveredAnswer || lastAgentMessage || "").trim();
    if (!answer) answer = "Codex 已处理，但没有返回文本结果。";
    if (answer.length > config.maxReplyChars) {
      answer = `${answer.slice(0, config.maxReplyChars)}\n\n（回复过长，已截断；完整上下文保留在 Codex 任务中。）`;
    }
    return answer;
  } finally {
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(`${path.resolve(runtimeDir)}${path.sep}`)) {
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
}

const channel = createLarkChannel({
  appId: config.appId,
  appSecret,
  transport: "websocket",
  httpTimeoutMs: Number(config.httpTimeoutMs) || 20_000,
  handshakeTimeoutMs: Number(config.handshakeTimeoutMs) || 20_000,
  policy: {
    dmMode: "allowlist",
    dmAllowlist: [config.allowedSenderOpenId],
    groupAllowlist: [],
    requireMention: true,
    respondToMentionAll: false,
    botLoopGuard: { enabled: true, onTrip: "reject" },
  },
  safety: {
    dedup: { ttl: 3_600_000, maxEntries: 2000 },
    // Normal work is serialized by the bridge so read-only status commands
    // can bypass the queue and answer while a long Codex turn is running.
    chatQueue: { enabled: false, mergeWhileBusy: false },
    staleMessageWindowMs: 300_000,
  },
  outbound: {
    streamThrottleMs: 800,
    streamThrottleChars: 20,
    streamInitialText: "⏳ Codex 正在连接当前任务…（完全权限）",
    streamMaxElementChars: 10_000,
    ssrfGuard: true,
  },
  keepalive: {
    enabled: true,
    onUnrecoverable: (error) => {
      channelConnected = false;
      log(`Channel SDK keepalive could not reconnect: ${safeError(error)}`);
    },
  },
  loggerLevel: "info",
  source: "codex-feishu-channel-bridge",
});

let deliveryRetryInFlight = false;

async function deliverPendingRecord(record) {
  const response = await channel.rawClient.im.message.reply({
    data: {
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: "md", text: record.markdown }]] },
      }),
      msg_type: "post",
      reply_in_thread: Boolean(record.threadId),
      uuid: deliveryIdempotencyKey(record.messageId),
    },
    path: { message_id: record.messageId },
  });
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu reply failed with code ${response.code}`);
  }
  return response?.data?.message_id;
}

async function retryPendingDeliveries() {
  if (!channelConnected || deliveryRetryInFlight) return;
  deliveryRetryInFlight = true;
  try {
    for (const record of deliveryOutbox.list({ dueAt: Date.now() })) {
      try {
        const replyMessageId = await deliverPendingRecord(record);
        await persistCompleted(record.messageId);
        await deliveryOutbox.remove(record.messageId);
        log(`deferred result delivered for ${record.messageId}${replyMessageId ? ` as ${replyMessageId}` : ""}`);
      } catch (error) {
        await deliveryOutbox.markFailure(record.messageId, error);
        log(`deferred result delivery failed for ${record.messageId}: ${safeError(error)}`);
      }
    }
  } finally {
    deliveryRetryInFlight = false;
  }
}

async function replyCommand(msg, markdown) {
  await channel.reply(msg, { markdown });
  await persistCompleted(msg.messageId);
}

async function handleCommand(msg, content) {
  const trimmed = content.trim();
  const separator = trimmed.search(/\s/);
  const command = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const argument = separator < 0 ? "" : trimmed.slice(separator).trim();
  if (command === "/threads") {
    const threads = listRecentThreads();
    const lines = threads.map((thread, index) => `${index + 1}. ${compactTitle(thread.title)}\n   \`${thread.id}\``);
    await replyCommand(msg, [
      "## 最近的 Codex 任务",
      "",
      ...lines,
      "",
      "发送 `/use 2` 切换到第 2 个任务；发送 `/current` 查看当前绑定。",
    ].join("\n"));
    return true;
  }
  if (command === "/status") {
    const thread = getThread(activeThreadId);
    const snapshot = await getThreadSnapshot(thread);
    await replyCommand(msg, buildStatusMarkdown(thread, snapshot));
    return true;
  }
  if (command === "/model") {
    await replyCommand(msg, buildModelMarkdown(getThread(activeThreadId)));
    return true;
  }
  if (command === "/capacity" || command === "/quota") {
    const thread = getThread(activeThreadId);
    const snapshot = await getThreadSnapshot(thread);
    await replyCommand(msg, buildCapacityMarkdown(snapshot));
    return true;
  }
  if (command === "/current") {
    const thread = getThread(activeThreadId);
    const snapshot = await getThreadSnapshot(thread);
    await replyCommand(msg, buildCurrentMarkdown(thread, snapshot));
    return true;
  }
  if (command === "/new") {
    await channel.reply(msg, {
      markdown: argument
        ? `⏳ 正在创建新任务：**${compactTitle(argument, 100)}**`
        : "⏳ 正在创建新的 Codex 任务…",
    });
    const thread = await createCodexThread(argument);
    await selectThread(thread);
    // Persist the side effect before replying so a transient reply failure cannot
    // cause the same Feishu delivery to create a second Codex task.
    await persistCompleted(msg.messageId);
    await channel.reply(msg, { markdown: [
      `已创建并切换到：**${compactTitle(thread.title, 100)}**`,
      "",
      `\`${thread.id}\``,
      "",
      "现在发送的下一条普通消息会进入这个新任务；旧任务仍然保留，可用 `/threads` 切回。",
    ].join("\n") });
    log(`created and selected thread ${thread.id}`);
    return true;
  }
  if (command === "/use") {
    if (!argument) {
      await replyCommand(msg, "请先发送 `/threads`，然后使用 `/use 2`；也可以发送 `/use <完整任务ID>`。");
      return true;
    }
    let thread;
    if (/^\d+$/.test(argument)) thread = listRecentThreads()[Number(argument) - 1];
    else if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(argument)) thread = getThread(argument);
    if (!thread) {
      await replyCommand(msg, "没有找到这个 Codex 任务。请发送 `/threads` 后重新选择。");
      return true;
    }
    await selectThread(thread);
    await replyCommand(msg, `已切换到：**${compactTitle(thread.title, 100)}**\n\n后续消息会携带该任务的完整历史继续处理。`);
    log(`selected thread ${thread.id}`);
    return true;
  }
  if (command === "/help") {
    await replyCommand(msg, [
      "## 飞书 Codex 命令",
      "",
      "- `/status`：查看桥接、运行任务、队列和最近进展（不调用模型）",
      "- `/model`：查看当前任务使用的模型和推理强度（不调用模型）",
      "- `/capacity`：查看上下文与账户周期剩余容量（不调用模型）",
      "- `/new`：创建并切换到新任务",
      "- `/new 主题`：以指定主题创建并切换到新任务",
      "- `/threads`：列出最近任务",
      "- `/use 2`：切换到列表中的第 2 个任务",
      "- `/current`：查看当前任务",
      "- `/help`：显示帮助",
    ].join("\n"));
    return true;
  }
  return false;
}

async function streamCodex(msg, content) {
  // Feishu disables native streaming_mode after ten minutes. End it early,
  // then PATCH the same message as a regular card so long tasks neither freeze
  // nor create a new continuation card every eight minutes.
  const configuredSegmentMs = Number(config.streamSegmentMs) || 480_000;
  const segmentMs = Math.min(540_000, Math.max(60_000, configuredSegmentMs));
  return streamCodexInSingleMessage({
    channel,
    msg,
    content,
    askCodex: async (prompt, onProgress) => {
      const answer = await askCodex(prompt, (update) => {
        updateActiveWork(update);
        onProgress?.(update);
      });
      if (activeWork) {
        activeWork.phase = "正在回传最终结果";
        activeWork.lastUpdate = "Codex 已完成，正在更新飞书消息";
        activeWork.lastUpdateAt = Date.now();
      }
      return answer;
    },
    onAnswerReady: (answer) => deliveryOutbox.put({
      messageId: msg.messageId,
      chatId: msg.chatId,
      threadId: msg.threadId,
      markdown: answer,
      createdAt: Date.now(),
    }),
    log,
    streamWindowMs: segmentMs,
  });
}

async function processMessage(msg, content) {
  const messageStartedAt = Date.now();
  log(`accepted ${msg.messageId}`);

  try {
    if (await handleCommand(msg, content)) return true;
    await streamCodex(msg, content);
    await deliveryOutbox.remove(msg.messageId);
    await persistCompleted(msg.messageId);
    try {
      await channel.reply(msg, {
        text: `✅ Codex 任务已完成（用时 ${formatDuration(Date.now() - messageStartedAt)}），请查看上一条结果。`,
      });
      log(`completion notice sent for ${msg.messageId}`);
    } catch (noticeError) {
      // The answer is already complete and persisted. A notification failure
      // must not trigger the generic task-failed reply or re-run the task.
      log(`completion notice failed for ${msg.messageId}: ${safeError(noticeError)}`);
    }
    log(`completed ${msg.messageId}`);
    return true;
  } catch (error) {
    log(`failed ${msg.messageId}: ${safeError(error)}`);
    if (deliveryOutbox.has(msg.messageId)) {
      log(`result delivery deferred for ${msg.messageId}; background retry will not call Codex again`);
      void retryPendingDeliveries();
      return false;
    }
    try {
      await channel.reply(msg, { text: "Codex 暂时无法处理这条消息。请确认桌面端任务没有正在运行，然后稍后重试。" });
    } catch (replyError) {
      log(`error reply failed for ${msg.messageId}: ${safeError(replyError)}`);
    }
    return false;
  }
}

async function processQueuedMessage(msg, content) {
  const startedAt = Date.now();
  const command = commandName(content);
  activeWork = {
    messageId: msg.messageId,
    threadId: activeThreadId,
    startedAt,
    phase: command.startsWith("/") ? `正在执行 ${command}` : "正在启动 Codex",
    lastUpdate: "消息已从等待队列取出",
    lastUpdateAt: startedAt,
  };
  let ok = false;
  try {
    ok = await processMessage(msg, content);
  } finally {
    lastWork = { messageId: msg.messageId, finishedAt: Date.now(), ok };
    activeWork = undefined;
  }
}

channel.on("message", async (msg) => {
  if (msg.chatType !== "p2p" || msg.senderId !== config.allowedSenderOpenId || msg.rawContentType !== "text") return;
  if (completed.has(msg.messageId)) return;
  const content = String(msg.content || "").trim();
  if (!content) return;

  if (immediateCommands.has(commandName(content))) {
    await processMessage(msg, content);
    return;
  }
  await enqueueWork(() => processQueuedMessage(msg, content));
});

channel.on("reject", (event) => log(`rejected message ${event.messageId}: ${event.reason}`));
channel.on("error", (error) => log(`channel error: ${safeError(error)}`));
channel.on("reconnecting", () => {
  channelConnected = false;
  log("Channel SDK reconnecting");
});
channel.on("reconnected", () => {
  channelConnected = true;
  log("Channel SDK reconnected");
});

let stopResolve;
const stopPromise = new Promise((resolve) => { stopResolve = resolve; });
let stopping = false;
async function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping Channel SDK bridge (${reason})`);
  stopResolve();
}
process.on("SIGINT", () => void requestStop("SIGINT"));
process.on("SIGTERM", () => void requestStop("SIGTERM"));
const stopWatcher = setInterval(async () => {
  try {
    await fs.access(stopPath);
    await requestStop("stop request");
  } catch {}
}, 1000);
const deliveryRetryTimer = setInterval(
  () => void retryPendingDeliveries(),
  Math.max(15_000, Number(config.deliveryRetryMs) || 60_000),
);

try {
  await channel.connect();
  channelConnected = true;
  const identity = channel.getBotIdentity();
  log(`READY: Channel SDK connected as ${identity.name || identity.openId}`);
  void retryPendingDeliveries();
  await stopPromise;
} finally {
  channelConnected = false;
  clearInterval(stopWatcher);
  clearInterval(deliveryRetryTimer);
  await channel.disconnect().catch(() => {});
  await fs.rm(pidPath, { force: true });
  await fs.rm(stopPath, { force: true });
  log("Channel SDK bridge stopped");
}
