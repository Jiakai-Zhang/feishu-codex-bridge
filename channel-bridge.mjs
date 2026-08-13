import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createLarkChannel } from "@larksuite/channel";
import { AgentEventOutbox } from "./agent-event-outbox.mjs";
import {
  createAgentEvent,
  decodeAgentEvent,
  encodeAgentEvent,
  validateIncomingAgentEvent,
} from "./agent-protocol.mjs";
import { CollaborationGitHandoff, writeCollaborationRegistration } from "./collaboration-git.mjs";
import { buildLandingPlan, effectiveReceiveMode, resolveLandingChoice } from "./collaboration-landing.mjs";
import { CollaborationRequestInbox } from "./collaboration-request-inbox.mjs";
import { startCodexProjectThread } from "./codex-app-server.mjs";
import { AuditLog } from "./audit-log.mjs";
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
import { inspectDesktopProject } from "./desktop-project-state.mjs";
import { createExecutor } from "./executor-registry.mjs";
import { buildKnowledgeArtifactMarkdown, buildKnowledgeListMarkdown, parseKnowledgeCommand } from "./knowledge-commands.mjs";
import { KnowledgeHub } from "./knowledge-hub.mjs";
import { buildAuditMarkdown, buildMetricsMarkdown, parseAuditLimit } from "./operational-commands.mjs";
import { runProcess } from "./process-runner.mjs";
import { createRolloutCompletionWatcher } from "./rollout-completion.mjs";
import { streamCodexInSingleMessage } from "./stream-progress.mjs";
import {
  buildBranchesMarkdown,
  buildProjectMarkdown,
  buildProjectThreadsMarkdown,
  buildWorktreesMarkdown,
  parseNewCommandArgument,
  parseThreadsCommandArgument,
} from "./project-commands.mjs";
import { ProjectContext } from "./project-context.mjs";
import { classifyInboundMessage } from "./team-router.mjs";
import { buildPeerControlReply, buildTeamMarkdown, parsePeerControlMessage } from "./team-commands.mjs";
import {
  buildTaskLandingMarkdown,
  buildTeamTasksMarkdown,
  parseDelegateArgument,
  parseTaskAcceptArgument,
  parseTaskActionArgument,
} from "./team-task-commands.mjs";
import { loadBridgeConfig, sdkGroupAllowlist } from "./team-config.mjs";
import { TeamTaskStore } from "./team-task-store.mjs";
import { TaskLeaseStore } from "./task-lease-store.mjs";
import { ThreadWorkQueue } from "./thread-work-queue.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const config = await loadBridgeConfig(path.join(scriptDir, "bridge.config.json"));
const projectContext = new ProjectContext(config.project);
const userProfile = process.env.USERPROFILE;
if (!userProfile) throw new Error("USERPROFILE is required to locate the Codex state database");
const runtimeDir = path.join(config.workspace, "work", "feishu-codex-bridge");
const pidPath = path.join(runtimeDir, "bridge.pid");
const stopPath = path.join(runtimeDir, "stop.request");
const statePath = path.join(runtimeDir, "completed.json");
const legacySelectionPath = path.join(runtimeDir, "selected-thread.json");
const selectionPath = path.join(runtimeDir, `selected-thread.${config.project.id}.json`);
const deliveryOutboxPath = path.join(runtimeDir, "pending-deliveries.json");
const agentEventOutboxPath = path.join(runtimeDir, "pending-agent-events.json");
const teamTaskStorePath = path.join(runtimeDir, "team-tasks.json");
const auditLogPath = path.join(runtimeDir, "audit.jsonl");
const taskLeaseStorePath = path.join(runtimeDir, "task-leases.json");
const collaborationInboxPath = path.join(runtimeDir, "collaboration-inbox");
const temporaryChatPath = path.join(runtimeDir, "temporary-chat.json");
const codexStateDbPath = path.join(userProfile, ".codex", "state_5.sqlite");
const codexHome = path.join(userProfile, ".codex");

const appSecret = process.env.LARK_APP_SECRET;
delete process.env.LARK_APP_SECRET;
if (!appSecret) throw new Error("LARK_APP_SECRET was not supplied by the secure launcher");

await fs.mkdir(runtimeDir, { recursive: true });
await fs.rm(stopPath, { force: true });
await fs.writeFile(pidPath, String(process.pid), "utf8");
const deliveryOutbox = await DeliveryOutbox.open(deliveryOutboxPath);
const agentEventOutbox = await AgentEventOutbox.open(agentEventOutboxPath);
const teamTaskStore = await TeamTaskStore.open(teamTaskStorePath);
const auditLog = await AuditLog.open(auditLogPath);
const taskLeaseStore = await TaskLeaseStore.open(taskLeaseStorePath);
const collaborationInbox = config.collaboration.enabled
  ? await CollaborationRequestInbox.open(collaborationInboxPath)
  : undefined;
const collaborationGit = config.collaboration.enabled
  ? new CollaborationGitHandoff(projectContext, {
      githubRepository: config.collaboration.githubRepository,
      remote: config.collaboration.remote,
    })
  : undefined;
const knowledgeHub = config.teamHub.enabled
  ? new KnowledgeHub(config.teamHub.path, {
      projectId: config.project.id,
      agentId: config.agent.id,
      repositoryIds: config.teamHub.repositoryIds,
      maxContextChars: config.teamHub.maxContextChars,
    })
  : undefined;

let completed = new Set();
try {
  const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
  completed = new Set(Array.isArray(saved) ? saved : []);
} catch (error) {
  if (error?.code !== "ENOENT") log("state file was unreadable; starting with an empty dedupe set");
}

let activeThreadId = config.threadId;
for (const candidatePath of [selectionPath, legacySelectionPath]) {
  try {
    const selected = JSON.parse(await fs.readFile(candidatePath, "utf8"));
    if (typeof selected.threadId === "string") activeThreadId = selected.threadId;
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") log("thread selection file was unreadable; using the configured task");
  }
}

let temporaryChat;
try {
  const saved = JSON.parse(await fs.readFile(temporaryChatPath, "utf8"));
  if (typeof saved.baseThreadId === "string" && typeof saved.threadId === "string") {
    temporaryChat = saved;
    activeThreadId = saved.threadId;
  }
} catch (error) {
  if (error?.code !== "ENOENT") log("temporary Chat state was unreadable; continuing without it");
}

const bridgeStartedAt = Date.now();
let channelConnected = false;
const activeWorks = new Map();
let lastWork;
const workQueue = new ThreadWorkQueue();
let completedWriteTail = Promise.resolve();
let connectedBotOpenId = config.agent.botOpenId;
const threadListSelections = new Map();
const collaborationInboxInFlight = new Set();
let temporaryChatReady;

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function safeError(error) {
  if (error && typeof error === "object" && "code" in error) return `code=${String(error.code)}`;
  return error instanceof Error ? error.message : String(error);
}

function safeErrorCode(error) {
  if (error && typeof error === "object" && "code" in error) return String(error.code).slice(0, 80);
  return error instanceof Error ? error.name.slice(0, 80) : "unknown";
}

async function audit(type, actor, { taskId, details } = {}) {
  return auditLog.append({
    type,
    actor,
    projectId: config.project.id,
    taskId,
    details,
  });
}

function withStateDb(callback) {
  const db = new DatabaseSync(codexStateDbPath, { readOnly: true });
  try { return callback(db); }
  finally { db.close(); }
}

function getThread(threadId) {
  if (!threadId) return undefined;
  return withStateDb((db) => db.prepare(
    `select id, title, cwd, rollout_path, updated_at_ms, model, reasoning_effort,
      model_provider, cli_version, tokens_used, git_branch
     from threads where id = ? and archived = 0 and coalesce(thread_source, 'user') = 'user' limit 1`,
  ).get(threadId));
}

function listRecentThreads(limit = 500) {
  return withStateDb((db) => db.prepare(
    "select id, title, cwd, updated_at_ms, git_branch from threads where archived = 0 and coalesce(thread_source, 'user') = 'user' order by updated_at_ms desc limit ?",
  ).all(limit));
}

function normalizeCwd(cwd) {
  return typeof cwd === "string" ? cwd.replace(/^\\\\\?\\/, "") : config.project.repoRoot;
}

async function listProjectThreads({ branch, limit = 20, snapshot } = {}) {
  const currentSnapshot = snapshot || await projectContext.refresh();
  const validated = await Promise.all(listRecentThreads().map((thread) => projectContext.validateThread(thread, currentSnapshot)));
  return validated.filter(Boolean).filter((thread) => !branch || thread.worktree.branch === branch).slice(0, limit);
}

async function activeProjectThread(snapshot) {
  const currentSnapshot = snapshot || await projectContext.refresh();
  return projectContext.validateThread(getThread(activeThreadId), currentSnapshot);
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

async function selectThread(thread, snapshot) {
  const currentSnapshot = snapshot || await projectContext.refresh();
  const scopedThread = await projectContext.validateThread(thread, currentSnapshot);
  if (!scopedThread) throw new Error("This Codex task is outside the configured Project or its recorded branch no longer matches the worktree");
  activeThreadId = thread.id;
  await fs.writeFile(selectionPath, JSON.stringify({
    projectId: config.project.id,
    threadId: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    branch: scopedThread.worktree.branch,
    selectedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  return scopedThread;
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
  "/status", "/model", "/capacity", "/quota", "/current", "/project", "/branches", "/worktrees", "/threads", "/team", "/team-tasks", "/team-options", "/audit", "/metrics", "/help",
  "/chat", "/endchat", "/end",
]);

function updateActiveWork(work, update) {
  if (update === undefined) {
    update = work;
    work = activeWorks.get(activeThreadId);
  }
  if (!work || !update?.text) return;
  work.phase = update.kind === "note" ? "Codex 正在处理" : update.text;
  work.lastUpdate = update.text;
  work.lastUpdateAt = Date.now();
}

function buildStatusMarkdown(thread, snapshot, scopedThread) {
  const currentWork = activeWorks.get(activeThreadId);
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
    `- 当前状态：**${currentWork ? currentWork.phase : idleState}**`,
    `- 并行运行：${activeWorks.size} 个任务`,
    `- 等待队列：${workQueue.queuedCount} 条`,
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
  if (temporaryChat) {
    lines.push(`- 临时 Chat：**${temporaryChat.status === "creating" ? "正在创建" : "已启用"}**`);
  }
  if (currentWork) {
    lines.push(
      `- 本轮已运行：${formatDuration(Date.now() - currentWork.startedAt)}`,
      `- 最近进展：${currentWork.lastUpdate || "正在启动"}`,
      `- 进展更新时间：${formatTimestamp(currentWork.lastUpdateAt)}`,
    );
  } else if (lastWork) {
    lines.push(`- 上一条桥接任务：${lastWork.ok ? "已完成" : "失败"}（${formatTimestamp(lastWork.finishedAt)}）`);
  }
  if (thread?.updated_at_ms) lines.push(`- Codex 任务更新时间：${formatTimestamp(thread.updated_at_ms)}`);
  lines.push("", "> 状态直接读取桥接内存、本机数据库和 rollout，不调用语言模型。运行中的状态查询会绕过普通消息队列立即响应。");
  return lines.join("\n");
}

function buildCurrentMarkdown(thread, snapshot, scopedThread) {
  if (!thread) return `当前绑定的任务不存在：\`${activeThreadId}\``;
  if (!scopedThread) return [
    `当前任务不属于 Project **${config.project.name}**，或记录分支已与 worktree 不一致；桥接已禁止继续运行。`,
    "",
    "请发送 `/threads` 选择 Project 内任务，或发送 `/new` 在当前 Project worktree 中创建任务。",
  ].join("\n");
  const capacity = capacityView(snapshot);
  const remaining = capacity.contextRemaining === undefined
    ? "不可用"
    : `${formatInteger(capacity.contextRemaining)} tokens（${formatPercent(capacity.contextRemainingPercent)}）`;
  const account = capacity.accountRemainingPercent === undefined
    ? "不可用"
    : formatPercent(capacity.accountRemainingPercent);
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
  if (temporaryChat) {
    const base = getThread(temporaryChat.baseThreadId);
    lines.push("", `当前处于临时 Chat；发送 \`/endchat\` 返回：**${compactTitle(base?.title || temporaryChat.baseThreadId, 100)}**。`);
  }
  return lines.join("\n");
}

async function createCodexThread(topic, onProgress, workspace = config.project.repoRoot) {
  const compactTopic = String(topic || "从飞书新建的任务").replace(/\s+/g, " ").trim().slice(0, 200);
  const projectSnapshot = await projectContext.refresh();
  const worktree = projectContext.matchCwd(workspace, projectSnapshot);
  if (!worktree) throw new Error("New Codex task workspace is outside the configured Project worktrees");
  onProgress?.({ kind: "activity", text: "正在创建空白 Project 任务" });
  const created = await startCodexProjectThread({
    codexExecutable: config.codexExecutable,
    cwd: workspace,
    name: compactTopic,
    sandboxMode: projectContext.effectiveSandbox(worktree, config.sandboxMode),
    timeoutMs: Number(config.handshakeTimeoutMs) || 20_000,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const thread = getThread(created.id);
    if (thread) return thread;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`New Codex task was not persisted: ${created.id}`);
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

async function askCodex(content, onProgress, targetThreadId = activeThreadId) {
  const tempDir = await fs.mkdtemp(path.join(runtimeDir, "turn-"));
  const answerPath = path.join(tempDir, "answer.md");
  const activeThread = getThread(targetThreadId);
  if (!activeThread) throw new Error(`Selected Codex task no longer exists: ${targetThreadId}`);
  const projectSnapshot = await projectContext.refresh();
  const scopedThread = await projectContext.validateThread(activeThread, projectSnapshot);
  if (!scopedThread) throw new Error("Selected Codex task is outside the configured Project or its recorded branch no longer matches the worktree");
  const activeWorkspace = normalizeCwd(activeThread.cwd);
  const effectiveSandbox = projectContext.effectiveSandbox(scopedThread.worktree, config.sandboxMode);
  const rolloutPath = normalizeCwd(activeThread.rollout_path);
  let completionWatcher;
  try {
    completionWatcher = await createRolloutCompletionWatcher(rolloutPath, {
      stableMs: Number(config.completionStableMs) || 15_000,
    });
  } catch (error) {
    log(`completion watcher unavailable for ${targetThreadId}: ${safeError(error)}`);
  }
  let lastAgentMessage = "";
  const sharedKnowledge = knowledgeHub ? await knowledgeHub.buildContext() : "";
  const prompt = [
    `[来自已验证的飞书消息；Project=${config.project.id}；branch=${scopedThread.worktree.branch || "detached"}]`,
    ...(sharedKnowledge ? [sharedKnowledge, ""] : []),
    content.slice(0, config.maxInputChars),
    "",
    `请直接处理并回答这条消息。本轮运行沙箱为 ${effectiveSandbox}。只允许在当前 Project 的 worktree 内工作，不得切换 checkout 的分支。${effectiveSandbox === "read-only" ? "当前是受保护的默认分支，只能读取和分析；需要修改时请让用户用 /new --branch 创建任务 worktree。" : "当前任务分支允许按沙箱策略修改。"}`,
    "对于递归删除、覆盖重要数据、重置凭据或权限、强制推送、清空数据库及其他难以恢复的操作，必须先向用户说明具体影响并取得明确确认。",
    "处理过程中，请像 Codex 桌面端一样，在开始主要阶段、得到关键发现或下一步发生变化时，主动发送一两句简短、可公开的过程说明：说清楚准备做什么、刚发现了什么、接下来做什么。不要逐字输出隐藏思维链，也不要在过程说明里粘贴凭据、完整命令、命令输出或敏感路径。",
  ].join("\n");

  try {
    const result = await runProcess(config.codexExecutable, [
      "exec",
      "--sandbox",
      effectiveSandbox,
      "--cd",
      activeWorkspace,
      "--skip-git-repo-check",
      "--json",
      "--output-last-message",
      answerPath,
      "resume",
      "--all",
      targetThreadId,
      "-",
    ], {
      input: Buffer.from(prompt, "utf8"),
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

async function initializeProjectSelection() {
  const snapshot = await projectContext.refresh();
  const selected = await projectContext.validateThread(getThread(activeThreadId), snapshot);
  if (selected) {
    if (!await fs.stat(selectionPath).then(() => true, () => false)) await selectThread(selected, snapshot);
    return selected;
  }
  const fallback = (await listProjectThreads({ snapshot, limit: 1 }))[0];
  if (fallback) {
    await selectThread(fallback, snapshot);
    log(`selected most recent Project task ${fallback.id}; previous selection was outside Project`);
    return fallback;
  }
  activeThreadId = undefined;
  log(`Project ${config.project.id} has no Codex task yet; use /new to create one`);
  return undefined;
}

await initializeProjectSelection();
if (collaborationGit) await collaborationGit.verifyBinding();
const collaborationRegistrationFile = await writeCollaborationRegistration(projectContext, config.collaboration.enabled
  ? {
      schemaVersion: 1,
      enabled: true,
      agentId: config.agent.id,
      projectId: config.project.id,
      groupChatId: config.collaboration.groupChatId,
      githubRepository: config.collaboration.githubRepository,
      remote: config.collaboration.remote,
      inboxPath: collaborationInboxPath,
    }
  : {
      schemaVersion: 1,
      enabled: false,
      agentId: config.agent.id,
      projectId: config.project.id,
    });
const executor = createExecutor(config.agent.executor, {
  codex: {
    capabilities: {
      persistentThreads: true,
      projectCwd: true,
      progressUpdates: true,
      cancellation: false,
    },
    createThread: createCodexThread,
    runTurn: askCodex,
  },
});
await audit("bridge.started", `agent:${config.agent.id}`, {
  details: {
    executorType: executor.type,
    capabilities: executor.capabilities,
    collaborationEnabled: config.collaboration.enabled,
    collaborationRegistration: path.basename(collaborationRegistrationFile),
  },
});

const channel = createLarkChannel({
  appId: config.appId,
  appSecret,
  transport: "websocket",
  httpTimeoutMs: Number(config.httpTimeoutMs) || 20_000,
  handshakeTimeoutMs: Number(config.handshakeTimeoutMs) || 20_000,
  policy: {
    dmMode: "allowlist",
    dmAllowlist: config.agent.allowedHumanOpenIds,
    groupAllowlist: sdkGroupAllowlist(config),
    requireMention: config.collaboration.groupHumanMessageMode === "mention",
    respondToMentionAll: false,
    botLoopGuard: {
      enabled: true,
      windowMs: 60_000,
      maxBotMentions: 5,
      scope: "chat+sender",
      onTrip: "reject",
    },
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
    streamInitialText: "⏳ Codex 正在连接当前 Project 任务…（权限由分支策略决定）",
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

function trustedPeer(agentId) {
  return config.collaboration.trustedPeers.find((peer) => (
    peer.enabled
    && peer.agentId === agentId
  ));
}

function requireTaskApprover(openId, task, { allowRequester = false } = {}) {
  if (config.collaboration.approverOpenIds.includes(openId)) return;
  if (allowRequester && task?.requesterHumanOpenId === openId) return;
  throw new Error("该操作只允许配置的协作审批者执行");
}

function eventForTask(task, kind, payload) {
  return createAgentEvent({
    kind,
    taskId: task.taskId,
    groupChatId: task.groupChatId,
    githubRepository: task.githubRepository,
    fromAgentId: config.agent.id,
    toAgentId: task.peerAgentId,
    requesterAgentId: task.requesterAgentId,
    executorAgentId: task.executorAgentId,
    payload,
  }, { ttlMs: config.collaboration.eventTtlMs });
}

async function deliverAgentEventRecord(record) {
  const peer = trustedPeer(record.peerAgentId);
  if (!peer?.botOpenId) throw new Error("Trusted peer Bot identity is unavailable");
  if (record.chatId !== config.collaboration.groupChatId) throw new Error("Agent event target is not the bound collaboration group");
  // The authenticated wire must be a text message. Markdown is emitted as a
  // Feishu post and the router deliberately rejects non-text Bot messages.
  await channel.send(record.chatId, { text: encodeAgentEvent(record.event) }, {
    mentions: [{ key: "peer", openId: peer.botOpenId, name: peer.displayName, isBot: true }],
  });
}

function agentEventNoticeMarkdown(event, peer) {
  const common = [
    `## Agent 协作 · ${event.kind}`,
    "",
    `- 对方：${peer.humanDisplayName} + ${peer.displayName}`,
    `- 任务：\`${event.taskId}\``,
    `- 仓库：\`${event.githubRepository}\``,
  ];
  if (event.kind === "task.request") {
    common.push(
      `- 标题：${sanitizeProgressNote(event.payload.title, 160)}`,
      `- Git：\`${event.payload.git.branch}@${event.payload.git.commit.slice(0, 12)}\``,
      `- 接收模式：\`${event.payload.receiveMode}\``,
      "",
      sanitizeProgressNote(event.payload.prompt, 2_000),
    );
  } else if (event.kind === "task.result") {
    common.push(
      `- Git：\`${event.payload.git.branch}@${event.payload.git.commit.slice(0, 12)}\``,
      "",
      sanitizeProgressNote(event.payload.summary, 2_000),
    );
  } else if (event.payload?.reason) {
    common.push("", sanitizeProgressNote(event.payload.reason, 1_000));
  } else if (event.payload?.message) {
    common.push("", sanitizeProgressNote(event.payload.message, 1_000));
  }
  return common.join("\n");
}

async function announceAgentEvent(peer, chatId, event) {
  if (!new Set(["task.request", "task.result", "task.blocked", "task.rejected"]).has(event.kind)) return;
  await channel.send(chatId, { markdown: agentEventNoticeMarkdown(event, peer) }, {
    mentions: [
      { key: "human", openId: peer.humanOpenId, name: peer.humanDisplayName },
      { key: "bot", openId: peer.botOpenId, name: peer.displayName, isBot: true },
    ],
  });
}

async function sendAgentEvent(peer, chatId, event, { announce = true } = {}) {
  const record = {
    peerAgentId: peer.agentId,
    chatId,
    event,
    createdAt: Date.now(),
  };
  await agentEventOutbox.put(record);
  try {
    if (announce) {
      await announceAgentEvent(peer, chatId, event).catch((error) => {
        log(`Agent event public notice failed for ${event.eventId}: ${safeError(error)}`);
      });
    }
    await deliverAgentEventRecord(record);
    await agentEventOutbox.remove(event.eventId);
    await audit("agent_event.delivered", `agent:${config.agent.id}`, {
      taskId: event.taskId,
      details: { eventId: event.eventId, kind: event.kind, peerAgentId: peer.agentId },
    });
    return true;
  } catch (error) {
    await agentEventOutbox.markFailure(event.eventId, error);
    await audit("agent_event.queued", `agent:${config.agent.id}`, {
      taskId: event.taskId,
      details: { eventId: event.eventId, kind: event.kind, peerAgentId: peer.agentId, errorCode: safeErrorCode(error) },
    });
    log(`Agent event ${event.eventId} queued for retry: ${safeError(error)}`);
    return false;
  }
}

async function sendTaskEvent(task, kind, payload) {
  const peer = trustedPeer(task.peerAgentId);
  if (!peer) throw new Error(`Trusted peer ${task.peerAgentId} is unavailable in the bound collaboration group`);
  const event = eventForTask(task, kind, payload);
  const delivered = await sendAgentEvent(peer, task.chatId || config.collaboration.groupChatId, event);
  return { event, delivered };
}

async function validateLocalCollaborationRequest(request) {
  if (!config.collaboration.enabled || !collaborationGit) throw new Error("Collaboration is disabled for this Bridge Project");
  if (request.source.agentId !== config.agent.id) throw new Error("Collaboration request source Agent does not match this Bridge");
  if (request.source.projectId !== config.project.id) throw new Error("Collaboration request source Project does not match this machine");
  if (request.source.groupChatId !== config.collaboration.groupChatId) throw new Error("Collaboration request group does not match this Project binding");
  if (request.source.githubRepository !== config.collaboration.githubRepository) throw new Error("Collaboration request repository does not match this Project binding");
  if (request.source.remote !== config.collaboration.remote) throw new Error("Collaboration request remote does not match this Project binding");
  const peer = trustedPeer(request.action.peerAgentId);
  if (!peer) throw new Error(`Agent ${request.action.peerAgentId} is not a trusted member of this collaboration group`);
  if (request.action.resultMode === "resume" && !request.source.threadId) {
    throw new Error("resultMode resume requires a source Codex task");
  }
  if (request.source.threadId) {
    const snapshot = await projectContext.refresh();
    const sourceThread = await projectContext.validateThread(getThread(request.source.threadId), snapshot);
    if (!sourceThread || sourceThread.worktree.branch !== request.source.branch) {
      throw new Error("Source Codex task is outside this Project or no longer matches the handoff branch");
    }
  }
  return peer;
}

async function dispatchCollaborationRequest(request, {
  requesterHumanOpenId = config.agent.ownerOpenId,
  taskId = `task:${request.requestId.slice("req:".length)}`,
} = {}) {
  const peer = await validateLocalCollaborationRequest(request);
  const git = await collaborationGit.publishRequest(request);
  let task = teamTaskStore.get(taskId);
  let event;
  let delivered;
  if (!task) {
    event = createAgentEvent({
      kind: "task.request",
      taskId,
      groupChatId: config.collaboration.groupChatId,
      githubRepository: config.collaboration.githubRepository,
      fromAgentId: config.agent.id,
      toAgentId: peer.agentId,
      requesterAgentId: config.agent.id,
      executorAgentId: peer.agentId,
      payload: {
        title: request.action.title,
        prompt: request.action.prompt,
        receiveMode: request.action.receiveMode,
        resultMode: request.action.resultMode,
        git,
      },
    }, { ttlMs: config.collaboration.eventTtlMs });
    task = await teamTaskStore.createOutboundRequest(event, {
      peer,
      chatId: config.collaboration.groupChatId,
      requesterHumanOpenId,
      sourceThreadId: request.source.threadId,
      localProjectId: config.project.id,
    });
    delivered = await sendAgentEvent(peer, config.collaboration.groupChatId, event);
  } else {
    if (task.direction !== "outbound" || task.peerAgentId !== peer.agentId
      || task.prompt !== request.action.prompt || task.branch !== git.branch
      || task.requestGit?.commit !== git.commit || task.githubRepository !== config.collaboration.githubRepository) {
      throw new Error(`Existing task ${taskId} does not match this collaboration request`);
    }
    ({ event, delivered } = await sendTaskEvent(task, "task.request", {
      title: task.title,
      prompt: task.prompt,
      receiveMode: task.receiveMode,
      resultMode: task.resultMode,
      git: task.requestGit,
    }));
  }
  await audit("task.delegated", `agent:${config.agent.id}`, {
    taskId: task.taskId,
    details: {
      peerAgentId: task.peerAgentId,
      branch: task.branch,
      commit: task.requestGit.commit,
      delivered,
    },
  });
  return { task, event, delivered };
}

function requestIdFromInboxPath(filePath) {
  const match = path.basename(filePath).match(/^req_([0-9a-f-]{36})\.json$/i);
  return match ? `req:${match[1]}` : undefined;
}

async function processCollaborationInboxRecord(record) {
  const requestId = record.request?.requestId || requestIdFromInboxPath(record.filePath);
  if (!requestId) {
    log(`ignored collaboration inbox file with an invalid name`);
    return;
  }
  if (record.error) {
    await collaborationInbox.finish(record.filePath, requestId, {
      ok: false,
      status: "blocked",
      error: "Bridge rejected an invalid or expired collaboration request; inspect /audit.",
      errorCode: record.error.name || "validation_error",
    });
    await audit("collaboration_request.rejected", `agent:${config.agent.id}`, {
      details: { requestId, errorCode: record.error.name || "validation_error" },
    });
    return;
  }
  try {
    const { task, event, delivered } = await dispatchCollaborationRequest(record.request);
    await collaborationInbox.finish(record.filePath, requestId, {
      ok: true,
      status: delivered ? "delivered" : "queued",
      taskId: task.taskId,
      eventId: event.eventId,
      git: task.requestGit,
    });
  } catch (error) {
    await collaborationInbox.finish(record.filePath, requestId, {
      ok: false,
      status: "blocked",
      error: "Bridge blocked the collaboration request; inspect /audit for the local reason.",
      errorCode: safeErrorCode(error),
    });
    await audit("collaboration_request.blocked", `agent:${config.agent.id}`, {
      details: { requestId, errorCode: safeErrorCode(error) },
    });
    log(`collaboration request ${requestId} blocked: ${safeError(error)}`);
  }
}

async function scanCollaborationInbox() {
  if (!channelConnected || !collaborationInbox) return;
  const pending = await collaborationInbox.list();
  for (const record of pending) {
    if (collaborationInboxInFlight.has(record.filePath)) continue;
    collaborationInboxInFlight.add(record.filePath);
    void enqueueWork(async () => {
      try { await processCollaborationInboxRecord(record); }
      finally { collaborationInboxInFlight.delete(record.filePath); }
    });
  }
}

let deliveryRetryInFlight = false;
let agentEventRetryInFlight = false;

async function retryPendingAgentEvents() {
  if (!channelConnected || agentEventRetryInFlight) return;
  agentEventRetryInFlight = true;
  try {
    for (const record of agentEventOutbox.list({ dueAt: Date.now() })) {
      if (Number.isFinite(record.event.expiresAt) && record.event.expiresAt <= Date.now()) {
        await agentEventOutbox.remove(record.eventId);
        await audit("agent_event.expired", `agent:${config.agent.id}`, {
          taskId: record.event.taskId,
          details: { eventId: record.eventId, kind: record.event.kind, peerAgentId: record.peerAgentId },
        });
        continue;
      }
      try {
        await deliverAgentEventRecord(record);
        await agentEventOutbox.remove(record.eventId);
        await audit("agent_event.retry_delivered", `agent:${config.agent.id}`, {
          taskId: record.event.taskId,
          details: { eventId: record.eventId, kind: record.event.kind, peerAgentId: record.peerAgentId, attempts: record.attempts },
        });
      } catch (error) {
        await agentEventOutbox.markFailure(record.eventId, error);
        log(`Agent event retry failed for ${record.eventId}: ${safeError(error)}`);
      }
    }
  } finally {
    agentEventRetryInFlight = false;
  }
}

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

function threadListKey(msg) {
  return `${msg.chatId}:${msg.senderId}`;
}

function rememberThreadList(msg, threads) {
  threadListSelections.set(threadListKey(msg), {
    threadIds: threads.map(({ id }) => id),
    expiresAt: Date.now() + 30 * 60_000,
  });
  if (threadListSelections.size > 100) {
    const oldest = threadListSelections.keys().next().value;
    threadListSelections.delete(oldest);
  }
}

async function selectedThreadFromList(msg, index) {
  const cached = threadListSelections.get(threadListKey(msg));
  if (cached?.expiresAt > Date.now()) return getThread(cached.threadIds[index]);
  return (await listProjectThreads())[index];
}

async function landingPlanForTask(task, { persist = true } = {}) {
  if (!task || task.direction !== "inbound") throw new Error("Unknown inbound collaboration task");
  const snapshot = await projectContext.refresh();
  const threads = await listProjectThreads({ branch: task.branch, snapshot, limit: 100 });
  const plan = buildLandingPlan({ branch: task.branch, threads, snapshot });
  const mode = effectiveReceiveMode(task.receiveMode, config.collaboration.receiveMode);
  if (persist && new Set(["pending", "blocked"]).has(task.state)) {
    await teamTaskStore.setLandingRecommendation(task.taskId, plan.recommendation);
  }
  return { plan, mode };
}

async function startTemporaryChat(msg, topic) {
  if (temporaryChat) {
    await replyCommand(msg, temporaryChat.status === "creating"
      ? "临时 Chat 正在创建，请稍等；创建后直接发送消息即可。"
      : "当前已经处于临时 Chat。直接发送消息继续，或发送 `/endchat` 返回原任务。");
    return;
  }

  const session = {
    baseThreadId: activeThreadId,
    threadId: undefined,
    title: undefined,
    status: "creating",
    startedAt: new Date().toISOString(),
  };
  temporaryChat = session;
  temporaryChatReady = (async () => {
    await channel.reply(msg, {
      markdown: topic
        ? `⏳ 正在创建临时 Chat：**${compactTitle(topic, 100)}**`
        : "⏳ 正在创建临时 Chat…",
    });
    const thread = await createCodexThread(topic || "飞书临时 Chat");
    session.threadId = thread.id;
    session.title = thread.title;
    session.status = "active";
    await selectThread(thread);
    await fs.writeFile(temporaryChatPath, JSON.stringify({
      baseThreadId: session.baseThreadId,
      threadId: session.threadId,
      title: session.title,
      status: session.status,
      startedAt: session.startedAt,
    }, null, 2), "utf8");
    await persistCompleted(msg.messageId);
    await channel.reply(msg, { markdown: [
      `临时 Chat 已就绪：**${compactTitle(thread.title, 100)}**`,
      "",
      "现在可以随时发送消息。它与原任务使用独立队列，可以并行处理。",
      "发送 `/endchat`（或 `/end`）即可立即返回原任务；已发出的临时 Chat 消息仍会在后台完成。",
    ].join("\n") });
    log(`temporary Chat ${thread.id} started from ${session.baseThreadId}`);
    return thread;
  })();

  try {
    await temporaryChatReady;
  } catch (error) {
    if (temporaryChat === session) temporaryChat = undefined;
    temporaryChatReady = undefined;
    throw error;
  }
}

async function endTemporaryChat(msg) {
  const session = temporaryChat;
  if (!session) {
    await replyCommand(msg, "当前不在临时 Chat 中，无需返回。发送 `/chat` 可以创建一个临时异步 Chat。");
    return;
  }

  session.ending = true;
  if (temporaryChatReady) await temporaryChatReady;
  const baseThread = getThread(session.baseThreadId);
  if (!baseThread) throw new Error(`Original Codex task no longer exists: ${session.baseThreadId}`);
  await selectThread(baseThread);
  await fs.rm(temporaryChatPath, { force: true });
  if (temporaryChat === session) temporaryChat = undefined;
  temporaryChatReady = undefined;
  await persistCompleted(msg.messageId);
  await channel.reply(msg, { markdown: [
    `已结束临时 Chat，并返回：**${compactTitle(baseThread.title, 100)}**`,
    "",
    "后续普通消息会继续使用原任务的完整对话上下文。临时 Chat 中已经提交的消息不会被取消，完成后仍会回复到各自的飞书卡片。",
  ].join("\n") });
  log(`temporary Chat ended; restored ${baseThread.id}`);
}

async function resolveMessageThreadId() {
  const session = temporaryChat;
  if (!session) return activeThreadId;
  if (session.ending) return session.baseThreadId;
  if (session.status === "creating" && temporaryChatReady) {
    try { await temporaryChatReady; }
    catch { return activeThreadId; }
  }
  return temporaryChat?.threadId || activeThreadId;
}

async function handleCommand(msg, content) {
  const trimmed = content.trim();
  const separator = trimmed.search(/\s/);
  const command = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const argument = separator < 0 ? "" : trimmed.slice(separator).trim();
  if (command === "/chat") {
    await startTemporaryChat(msg, argument);
    return true;
  }
  if (command === "/endchat" || command === "/end") {
    await endTemporaryChat(msg);
    return true;
  }
  if (command === "/threads") {
    const filter = parseThreadsCommandArgument(argument);
    if (filter.error) {
      await replyCommand(msg, filter.error);
      return true;
    }
    const snapshot = await projectContext.refresh();
    const threads = await listProjectThreads({ branch: filter.branch, snapshot });
    rememberThreadList(msg, threads);
    await replyCommand(msg, buildProjectThreadsMarkdown(threads, filter));
    return true;
  }
  if (command === "/status") {
    const thread = getThread(activeThreadId);
    const [rolloutSnapshot, projectSnapshot] = await Promise.all([
      getThreadSnapshot(thread),
      projectContext.refresh(),
    ]);
    const scopedThread = await projectContext.validateThread(thread, projectSnapshot);
    await replyCommand(msg, buildStatusMarkdown(thread, rolloutSnapshot, scopedThread));
    return true;
  }
  if (command === "/audit") {
    const limit = parseAuditLimit(argument);
    await replyCommand(msg, limit
      ? buildAuditMarkdown(auditLog.tail(limit), auditLog.headHash())
      : "用法：`/audit [1-100]`"
    );
    return true;
  }
  if (command === "/metrics") {
    const tasks = teamTaskStore.list({ limit: 500 });
    const taskStates = tasks.reduce((counts, task) => ({
      ...counts,
      [task.state]: (counts[task.state] || 0) + 1,
    }), {});
    const knowledgeCount = knowledgeHub ? (await knowledgeHub.list()).length : 0;
    await replyCommand(msg, buildMetricsMarkdown({
      channelConnected,
      queuedWorkCount,
      deliveryOutboxSize: deliveryOutbox.size(),
      agentEventOutboxSize: agentEventOutbox.size(),
      teamTaskCount: tasks.length,
      taskStates,
      knowledgeCount,
      auditCount: auditLog.size(),
      auditHead: auditLog.headHash(),
      taskLeaseCount: taskLeaseStore.list().length,
      executorType: executor.type,
      executorCapabilities: executor.capabilities,
    }));
    return true;
  }
  if (command === "/model") {
    const thread = getThread(activeThreadId);
    const scopedThread = await projectContext.validateThread(thread, await projectContext.refresh());
    await replyCommand(msg, scopedThread
      ? buildModelMarkdown(thread)
      : "当前没有选中 Project 内的 Codex 任务。请先使用 `/threads`、`/use` 或 `/new`。"
    );
    return true;
  }
  if (command === "/capacity" || command === "/quota") {
    const thread = getThread(activeThreadId);
    const scopedThread = await projectContext.validateThread(thread, await projectContext.refresh());
    await replyCommand(msg, scopedThread
      ? buildCapacityMarkdown(await getThreadSnapshot(thread))
      : "当前没有选中 Project 内的 Codex 任务。请先使用 `/threads`、`/use` 或 `/new`。"
    );
    return true;
  }
  if (command === "/current") {
    const thread = getThread(activeThreadId);
    const projectSnapshot = await projectContext.refresh();
    const scopedThread = await projectContext.validateThread(thread, projectSnapshot);
    await replyCommand(msg, buildCurrentMarkdown(thread, await getThreadSnapshot(thread), scopedThread));
    return true;
  }
  if (command === "/project") {
    const snapshot = await projectContext.refresh();
    const [selectedThread, desktopStatus] = await Promise.all([
      activeProjectThread(snapshot),
      inspectDesktopProject(config.project, { codexHome }),
    ]);
    await replyCommand(msg, buildProjectMarkdown(config, snapshot, selectedThread, desktopStatus));
    return true;
  }
  if (command === "/team") {
    await replyCommand(msg, buildTeamMarkdown(config, connectedBotOpenId));
    return true;
  }
  if (command === "/team-tasks") {
    await replyCommand(msg, buildTeamTasksMarkdown(teamTaskStore.list()));
    return true;
  }
  if (command === "/team-options") {
    const request = parseTaskActionArgument(argument);
    if (request.error) {
      await replyCommand(msg, request.error);
      return true;
    }
    const task = teamTaskStore.get(request.taskId);
    requireTaskApprover(msg.senderId, task);
    const { plan, mode } = await landingPlanForTask(task);
    await replyCommand(msg, buildTaskLandingMarkdown(task, plan, mode));
    return true;
  }
  if (command === "/knowledge") {
    if (!knowledgeHub) {
      await replyCommand(msg, "Team Hub 尚未启用。请先配置 `teamHub.enabled=true` 与共享路径。");
      return true;
    }
    const request = parseKnowledgeCommand(argument);
    if (request.error) {
      await replyCommand(msg, request.error);
      return true;
    }
    if (request.action === "list") {
      await replyCommand(msg, buildKnowledgeListMarkdown(await knowledgeHub.list(), config));
      return true;
    }
    if (request.action === "show") {
      await replyCommand(msg, buildKnowledgeArtifactMarkdown(await knowledgeHub.get(request.category, request.id)));
      return true;
    }
    if (!config.teamHub.writerOpenIds.includes(msg.senderId)) {
      await replyCommand(msg, "该成员没有 Team Hub 写入权限；可继续使用 `/knowledge list|show` 只读查看。");
      return true;
    }
    const metadata = request.action === "create"
      ? await knowledgeHub.create({
          category: request.category,
          id: request.id,
          title: request.title,
          content: request.content,
          authorHumanOpenId: msg.senderId,
        })
      : await knowledgeHub.update({
          category: request.category,
          id: request.id,
          content: request.content,
          expectedRevision: request.expectedRevision,
          authorHumanOpenId: msg.senderId,
        });
    await audit(`knowledge.${request.action === "create" ? "created" : "updated"}`, `human:${msg.senderId}`, {
      details: { category: metadata.category, id: metadata.id, revision: metadata.revision, repositoryIds: metadata.repositoryIds },
    });
    await replyCommand(msg, [
      `已${request.action === "create" ? "创建" : "更新"}共享知识：\`${metadata.category}/${metadata.id}\`。`,
      "",
      `revision：\`${metadata.revision}\``,
      "",
      "后续 Codex 回合会在有界上下文中读取该条目；实时任务状态仍与 Team Hub 分离。",
    ].join("\n"));
    return true;
  }
  if (command === "/delegate") {
    if (!config.collaboration.enabled) {
      await replyCommand(msg, "多 Bot 协作尚未启用。请先绑定唯一飞书群、可信成员/Bot 和同一个 GitHub 仓库。");
      return true;
    }
    const request = parseDelegateArgument(argument);
    if (request.error) {
      await replyCommand(msg, request.error);
      return true;
    }
    const peer = trustedPeer(request.peerAgentId);
    if (!peer) {
      await replyCommand(msg, `未找到该协作群中的可信 peer：\`${request.peerAgentId}\``);
      return true;
    }
    const sourceThread = await activeProjectThread();
    if (!sourceThread) throw new Error("No Project Codex task is selected for this delegation");
    if (sourceThread.worktree.branch !== request.branch) {
      throw new Error(`The selected Codex task is on ${sourceThread.worktree.branch}, not ${request.branch}`);
    }
    const head = (await projectContext.git(["rev-parse", "HEAD"], { cwd: normalizeCwd(sourceThread.cwd) })).trim().toLowerCase();
    const now = Date.now();
    const collaborationRequest = {
      schemaVersion: 1,
      requestId: `req:${randomUUID()}`,
      createdAt: now,
      expiresAt: now + config.collaboration.eventTtlMs,
      source: {
        agentId: config.agent.id,
        projectId: config.project.id,
        groupChatId: config.collaboration.groupChatId,
        githubRepository: config.collaboration.githubRepository,
        cwd: normalizeCwd(sourceThread.cwd),
        threadId: sourceThread.id,
        remote: config.collaboration.remote,
        branch: request.branch,
        head,
      },
      action: {
        type: "delegate",
        peerAgentId: request.peerAgentId,
        title: request.title,
        prompt: request.prompt,
        receiveMode: "recommend",
        gitSyncMode: "push",
        resultMode: "resume",
      },
    };
    const { task, delivered: eventDelivered } = await dispatchCollaborationRequest(collaborationRequest, {
      requesterHumanOpenId: msg.senderId,
      taskId: `task:${msg.messageId}`,
    });
    await replyCommand(msg, [
      `已向 **${peer.humanDisplayName} + ${peer.displayName}** 委派任务。`,
      "",
      `- 任务：\`${task.taskId}\``,
      `- 仓库：\`${task.githubRepository}\``,
      `- Git：\`${task.branch}@${task.requestGit.commit.slice(0, 12)}\``,
      `- 状态：${eventDelivered ? "已投递，等待 peer 接单" : "已进入 Agent 事件发件箱，等待自动补发"}`,
    ].join("\n"));
    return true;
  }
  if (command === "/team-accept") {
    const request = parseTaskAcceptArgument(argument);
    if (request.error) {
      await replyCommand(msg, request.error);
      return true;
    }
    await executeInboundTask(request.taskId, {
      commandMessage: msg,
      approvedByOpenId: msg.senderId,
      landingChoice: request.choice,
    });
    return true;
  }
  if (command === "/team-reject") {
    const request = parseTaskActionArgument(argument, { requireNote: true });
    if (request.error) {
      await replyCommand(msg, request.error);
      return true;
    }
    const current = teamTaskStore.get(request.taskId);
    requireTaskApprover(msg.senderId, current);
    const task = await teamTaskStore.rejectInbound(request.taskId, request.note, msg.senderId);
    await sendTaskEvent(task, "task.rejected", { reason: request.note });
    await audit("task.rejected", `human:${msg.senderId}`, {
      taskId: task.taskId,
      details: { peerAgentId: task.peerAgentId, branch: task.branch },
    });
    await replyCommand(msg, `已拒绝协作任务 \`${task.taskId}\`，并通知 ${task.peerAgentId}。`);
    return true;
  }
  if (command === "/team-approve") {
    const request = parseTaskActionArgument(argument);
    if (request.error) {
      await replyCommand(msg, request.error);
      return true;
    }
    const current = teamTaskStore.get(request.taskId);
    requireTaskApprover(msg.senderId, current, { allowRequester: true });
    const task = await teamTaskStore.approveOutbound(request.taskId, request.note, msg.senderId);
    await sendTaskEvent(task, "task.approved", { note: request.note || undefined });
    await audit("task.approved", `human:${msg.senderId}`, {
      taskId: task.taskId,
      details: { peerAgentId: task.peerAgentId, branch: task.branch },
    });
    await replyCommand(msg, `已批准 peer 返回的任务结果：\`${task.taskId}\`。`);
    return true;
  }
  if (command === "/branches") {
    await replyCommand(msg, buildBranchesMarkdown(config, await projectContext.refresh()));
    return true;
  }
  if (command === "/worktrees") {
    const snapshot = await projectContext.refresh();
    const threads = await listProjectThreads({ snapshot, limit: 500 });
    await replyCommand(msg, buildWorktreesMarkdown(config, snapshot, threads, activeThreadId));
    return true;
  }
  if (command === "/new") {
    if (temporaryChat) {
      await replyCommand(msg, "当前处于临时 Chat。请先发送 `/endchat` 返回原任务，再使用 `/new` 创建新的长期任务。");
      return true;
    }
    const request = parseNewCommandArgument(argument);
    if (request.error) {
      await replyCommand(msg, request.error);
      return true;
    }
    let snapshot = await projectContext.refresh();
    const current = await activeProjectThread(snapshot);
    const targetWorktree = request.branch
      ? await projectContext.prepareWorktree(request.branch)
      : current?.worktree || snapshot.worktrees.find(({ branch }) => branch === config.project.defaultBranch) || snapshot.worktrees[0];
    if (!targetWorktree) {
      await replyCommand(msg, "Project 内没有可用 worktree；请检查 `project.repoRoot` 与 `allowedWorktreeRoots` 配置。");
      return true;
    }
    const topic = request.topic || (request.branch
      ? `${request.branch} 任务`
      : `${config.project.name} 新任务`);
    await channel.reply(msg, {
      markdown: [
        `⏳ 正在创建 Codex 任务：**${compactTitle(topic, 100)}**`,
        "",
        `- 分支：\`${targetWorktree.branch || "detached"}\``,
        `- worktree：\`${targetWorktree.path}\``,
        `- 权限：\`${projectContext.effectiveSandbox(targetWorktree, config.sandboxMode)}\``,
      ].join("\n"),
    });
    const thread = await executor.createThread(topic, undefined, targetWorktree.path);
    snapshot = await projectContext.refresh();
    const scopedThread = await selectThread(thread, snapshot);
    // Persist the side effect before replying so a transient reply failure cannot
    // cause the same Feishu delivery to create a second Codex task.
    await persistCompleted(msg.messageId);
    await channel.reply(msg, { markdown: [
      `已创建并切换到：**${compactTitle(thread.title, 100)}**`,
      "",
      `\`${thread.id}\``,
      "",
      `分支 \`${scopedThread.worktree.branch || "detached"}\` · worktree \`${scopedThread.worktree.path}\``,
      "",
      scopedThread.worktree.branch === config.project.defaultBranch && config.project.protectDefaultBranch
        ? "这是受保护的默认分支任务，只能读取和分析；需要改代码请用 `/new --branch <任务分支> <主题>`。"
        : "下一条普通消息会进入这个任务；旧任务仍然保留，可用 `/threads` 切回。",
      "",
      config.project.desktopProjectId
        ? "说明：该任务由独立 App Server 创建，当前 Codex Desktop 不会自动把它归入已注册的 Desktop Project；Bridge 的 cwd/worktree 安全边界不受影响。"
        : "说明：尚未配置 Desktop Project 关联；Bridge 的 cwd/worktree 安全边界不受影响。",
    ].join("\n") });
    log(`created and selected project thread ${thread.id} in ${scopedThread.worktree.path}`);
    return true;
  }
  if (command === "/use") {
    if (temporaryChat) {
      await replyCommand(msg, "当前处于临时 Chat。请先发送 `/endchat` 返回原任务，再使用 `/use` 切换长期任务。");
      return true;
    }
    if (!argument) {
      await replyCommand(msg, "请先发送 `/threads`，然后使用 `/use 2`；也可以发送 `/use <完整任务ID>`。");
      return true;
    }
    let thread;
    if (/^\d+$/.test(argument)) thread = await selectedThreadFromList(msg, Number(argument) - 1);
    else if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(argument)) thread = getThread(argument);
    if (!thread) {
      await replyCommand(msg, "没有在最近的 Project 任务列表中找到该项。请重新发送 `/threads` 后选择。");
      return true;
    }
    let scopedThread;
    try { scopedThread = await selectThread(thread); }
    catch {
      await replyCommand(msg, "已拒绝切换：该 Codex 任务的 cwd 不属于当前 Project，或任务记录的分支已与 worktree 当前分支不一致。");
      return true;
    }
    await replyCommand(msg, [
      `已切换到：**${compactTitle(thread.title, 100)}**`,
      "",
      `分支 \`${scopedThread.worktree.branch || "detached"}\` · worktree \`${scopedThread.worktree.path}\``,
      "",
      "后续消息会携带该任务的完整历史继续处理；bridge 不会执行 git checkout。",
    ].join("\n"));
    log(`selected thread ${thread.id}`);
    return true;
  }
  if (command === "/help") {
    await replyCommand(msg, [
      "## 飞书 Codex 命令",
      "",
      "- `/project`：查看 Bot 绑定的 Project 与权限边界",
      "- `/branches`：列出本地/远端 refs 与分支 worktree",
      "- `/worktrees`：列出 Project 的 worktree、HEAD 与任务数",
      "- `/status`：查看桥接、运行任务、队列和最近进展（不调用模型）",
      "- `/model`：查看当前任务使用的模型和推理强度（不调用模型）",
      "- `/capacity`：查看上下文与账户周期剩余容量（不调用模型）",
      "- `/new 主题`：在当前 worktree 创建并切换到新任务",
      "- `/new --branch task/LOGIN-123 主题`：准备独立 worktree 后创建任务",
      "- `/threads`：只列出当前 Project 的任务",
      "- `/threads branch task/LOGIN-123`：按分支过滤任务",
      "- `/chat`：创建临时异步 Chat，同时保留原任务上下文",
      "- `/chat 主题`：以指定主题创建临时异步 Chat",
      "- `/endchat`（或 `/end`）：结束临时 Chat，立即返回原任务",
      "- `/use 2`：切换到列表中的第 2 个任务",
      "- `/current`：查看当前任务",
      "- `/team`：查看唯一群、GitHub 仓库、本机 Project 和可信成员/Bot",
      "- `/team-tasks`：查看 Agent 协作任务和所有权状态",
      "- `/delegate <peer> <branch> <任务>`：向可信 peer 委派任务",
      "- `/team-options <taskId>`：查看本机 worktree/对话落点",
      "- `/team-accept <taskId> [auto|thread:<id>|new-thread|new-worktree]`：选择落点并执行",
      "- `/team-reject <taskId> <原因>`：拒绝收到的任务",
      "- `/team-approve <taskId> [说明]`：批准 peer 返回的结果",
      "- `/knowledge [list|show|create|update]`：管理共享稳定知识、总结和参考资料",
      "- `/audit [1-100]`：查看追加式审计链摘要",
      "- `/metrics`：查看队列、发件箱、任务、知识、租约与 executor 指标",
      "- `/help`：显示帮助",
    ].join("\n"));
    return true;
  }
  return false;
}

async function streamCodex(msg, content, targetThreadId, work) {
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
      const answer = await executor.runTurn(prompt, (update) => {
        updateActiveWork(work, update);
        onProgress?.(update);
      }, targetThreadId);
      if (work) {
        work.phase = "正在回传最终结果";
        work.lastUpdate = "Codex 已完成，正在更新飞书消息";
        work.lastUpdateAt = Date.now();
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

async function processMessage(msg, content, targetThreadId, work) {
  const messageStartedAt = Date.now();
  log(`accepted ${msg.messageId}`);

  try {
    if (await handleCommand(msg, content)) return true;
    const projectSnapshot = await projectContext.refresh();
    const targetThread = getThread(targetThreadId);
    const scopedThread = await projectContext.validateThread(targetThread, projectSnapshot);
    if (!scopedThread) {
      await replyCommand(msg, [
        `当前没有选中 Project **${config.project.name}** 内的 Codex 任务。`,
        "",
        "发送 `/threads` 选择已有任务，或发送 `/new` 在默认 worktree 中创建任务。需要修改代码时建议使用 `/new --branch task/<ID> <主题>`。",
      ].join("\n"));
      return true;
    }
    await audit("turn.started", `human:${msg.senderId}`, {
      details: { messageId: msg.messageId, threadId: scopedThread.id, branch: scopedThread.worktree.branch, executorType: executor.type },
    });
    await streamCodex(msg, content, targetThreadId, work);
    await audit("turn.completed", `agent:${config.agent.id}`, {
      details: { messageId: msg.messageId, threadId: scopedThread.id, branch: scopedThread.worktree.branch, executorType: executor.type },
    });
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
    await audit("message.failed", `agent:${config.agent.id}`, {
      details: { messageId: msg.messageId, errorCode: safeErrorCode(error) },
    }).catch((auditError) => log(`message failure audit failed: ${safeError(auditError)}`));
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

async function processQueuedMessage(msg, content, targetThreadId) {
  const startedAt = Date.now();
  const command = commandName(content);
  const work = {
    messageId: msg.messageId,
    threadId: targetThreadId,
    startedAt,
    phase: command.startsWith("/") ? `正在执行 ${command}` : "正在启动 Codex",
    lastUpdate: "消息已从等待队列取出",
    lastUpdateAt: startedAt,
  };
  activeWorks.set(targetThreadId, work);
  let ok = false;
  try {
    ok = await processMessage(msg, content, targetThreadId, work);
  } finally {
    lastWork = { messageId: msg.messageId, finishedAt: Date.now(), ok };
    if (activeWorks.get(targetThreadId) === work) activeWorks.delete(targetThreadId);
  }
}

async function executeInboundTask(taskId, {
  commandMessage,
  approvedByOpenId,
  landingChoice = "auto",
} = {}) {
  let task = teamTaskStore.get(taskId);
  let leaseAcquired = false;
  if (!task || task.direction !== "inbound") throw new Error(`Unknown inbound task ${taskId}`);
  if (approvedByOpenId !== "auto") requireTaskApprover(approvedByOpenId, task);
  try {
    if (task.state === "pending" || task.state === "blocked") {
      const { plan } = await landingPlanForTask(task);
      const landing = resolveLandingChoice(plan, landingChoice);
      task = await teamTaskStore.acceptInbound(taskId, approvedByOpenId || "auto", {
        landing: landing.landing,
        targetThreadId: landing.threadId,
      });
    } else if (task.state !== "accepted") {
      throw new Error(`Task ${taskId} cannot be executed from ${task.state}`);
    }
    await audit("task.accepted", approvedByOpenId === "auto" ? `agent:${config.agent.id}` : `human:${approvedByOpenId}`, {
      taskId: task.taskId,
      details: { peerAgentId: task.peerAgentId, branch: task.branch, autoAccepted: approvedByOpenId === "auto" },
    });
    await taskLeaseStore.acquire({
      projectId: config.project.id,
      branch: task.branch,
      taskId: task.taskId,
      ownerAgentId: config.agent.id,
      leaseMs: config.collaboration.taskLeaseMs,
    });
    leaseAcquired = true;
    await audit("task.lease_acquired", `agent:${config.agent.id}`, {
      taskId: task.taskId,
      details: { branch: task.branch, leaseMs: config.collaboration.taskLeaseMs },
    });
    if (commandMessage) {
      await channel.reply(commandMessage, {
        markdown: `⏳ 已审批协作任务 \`${task.taskId}\`，正在同步 \`${task.githubRepository}:${task.branch}\` 并准备本地 Codex 落点。`,
      });
    }

    if (!collaborationGit) throw new Error("Collaboration Git handoff is unavailable");
    const worktree = await collaborationGit.prepareIncoming(task.requestGit);
    let thread;
    if (task.landing === "existing-thread") {
      thread = getThread(task.targetThreadId);
      const scoped = await projectContext.validateThread(thread, await projectContext.refresh());
      if (!scoped || scoped.worktree.branch !== task.branch) {
        throw new Error("Selected existing Codex task is no longer bound to the collaboration branch");
      }
    } else {
      thread = await executor.createThread(`[peer:${task.peerAgentId}] ${task.title}`, undefined, worktree.path);
    }
    const scopedThread = await selectThread(thread, await projectContext.refresh());
    task = await teamTaskStore.markRunning(task.taskId, {
      threadId: thread.id,
      worktree: scopedThread.worktree.path,
      branch: scopedThread.worktree.branch,
      landing: task.landing,
    });
    await audit("task.started", `agent:${config.agent.id}`, {
      taskId: task.taskId,
      details: { peerAgentId: task.peerAgentId, branch: task.branch, executorType: executor.type },
    });
    await sendTaskEvent(task, "task.accepted", {
      message: "accepted by the local Bridge",
      landing: task.landing,
    });
    await sendTaskEvent(task, "task.progress", { message: "Codex task started at the selected local Project landing" });

    const prompt = [
      `你正在执行一个经过本地审批的 Agent 协作任务。`,
      `请求 Agent：${task.requesterAgentId}`,
      `执行 Agent：${task.executorAgentId}`,
      `共享 GitHub 仓库：${task.githubRepository}`,
      `起始 Git：${task.requestGit.branch}@${task.requestGit.commit}`,
      `本机 Bridge Project：${config.project.id}`,
      `任务 ID：${task.taskId}`,
      "",
      "只在当前 Project/worktree 权限边界内完成任务并验证。不要修改任务协议字段或绕过审批状态。完成前只提交本任务需要的改动，并确保 worktree 干净；Bridge 会以非 force push 同步结果。不得把 App Secret、凭据、本机路径或本机 Codex task ID 写入提交。",
      "",
      task.prompt,
    ].join("\n");
    const answer = await executor.runTurn(prompt, (update) => updateActiveWork(update));
    const summary = String(answer || "任务完成，但 Codex 未返回文本结果。").slice(0, 12_000);
    const resultGit = await collaborationGit.publishResult({
      cwd: task.localWorktree,
      branch: task.localBranch,
    });
    task = await teamTaskStore.markCompleted(task.taskId, summary, { git: resultGit });
    await audit("task.completed", `agent:${config.agent.id}`, {
      taskId: task.taskId,
      details: { peerAgentId: task.peerAgentId, branch: task.branch, executorType: executor.type },
    });
    await sendTaskEvent(task, "task.result", { summary, git: task.resultGit });
    const doneMarkdown = [
      `## 协作任务已完成`,
      "",
      `- 任务：\`${task.taskId}\``,
      `- peer：\`${task.peerAgentId}\``,
      `- Git：\`${task.resultGit.branch}@${task.resultGit.commit.slice(0, 12)}\``,
      "- 状态：等待请求方审批结果",
    ].join("\n");
    if (commandMessage) await replyCommand(commandMessage, doneMarkdown);
    else await channel.send(task.chatId, { markdown: doneMarkdown });
    return true;
  } catch (error) {
    const latest = teamTaskStore.get(taskId);
    const peerReason = "本地执行未完成；请由本地审批者检查 Bridge 状态后决定是否重试。";
    if (latest && new Set(["accepted", "running"]).has(latest.state)) {
      task = await teamTaskStore.markBlocked(taskId, peerReason);
      await audit("task.blocked", `agent:${config.agent.id}`, {
        taskId: task.taskId,
        details: { peerAgentId: task.peerAgentId, branch: task.branch, errorCode: safeErrorCode(error) },
      });
      await sendTaskEvent(task, "task.blocked", { reason: peerReason }).catch((sendError) => {
        log(`failed to notify peer about blocked task ${taskId}: ${safeError(sendError)}`);
      });
    }
    if (commandMessage) {
      await replyCommand(commandMessage, `协作任务 \`${taskId}\` 被本地安全检查阻塞（\`${safeErrorCode(error)}\`）。请使用 \`/audit\` 在本机核对原因；不会向 peer 发送本机路径或凭据。`);
      return false;
    }
    log(`auto-accepted team task ${taskId} failed: ${safeError(error)}`);
    return false;
  } finally {
    if (leaseAcquired) {
      const released = await taskLeaseStore.release({
        projectId: config.project.id,
        branch: task.branch,
        taskId: task.taskId,
      });
      if (released) await audit("task.lease_released", `agent:${config.agent.id}`, {
        taskId: task.taskId,
        details: { branch: task.branch },
      });
    }
  }
}

async function resumeOutboundResult(task) {
  if (!collaborationGit) throw new Error("Collaboration Git handoff is unavailable");
  if (task.direction !== "outbound" || task.state !== "completed" || task.resultMode !== "resume") {
    throw new Error(`Task ${task.taskId} is not an outbound resumable result`);
  }
  if (!task.sourceThreadId) throw new Error("The collaboration request has no local source Codex task");
  await collaborationGit.prepareIncoming(task.resultGit);
  const sourceThread = getThread(task.sourceThreadId);
  const scopedThread = await projectContext.validateThread(sourceThread, await projectContext.refresh());
  if (!scopedThread || scopedThread.worktree.branch !== task.resultGit.branch) {
    throw new Error("The source Codex task no longer matches the returned Git branch");
  }
  await selectThread(sourceThread);
  const prompt = [
    "对方 Agent 已完成你委派的协作任务，Bridge 已将返回分支 fast-forward 到当前干净 worktree。",
    `协作任务：${task.taskId}`,
    `对方 Agent：${task.peerAgentId}`,
    `共享 GitHub 仓库：${task.githubRepository}`,
    `返回 Git：${task.resultGit.branch}@${task.resultGit.commit}`,
    "",
    "请结合当前对话历史、返回提交和下面的对方总结检查结果，并自然决定下一步。不要假设对方的本机 Project、worktree 路径或 Codex task ID。若还需对方处理，可继续使用本 Project 的 Feishu Agent Collaboration Skill。",
    "",
    task.result,
  ].join("\n");
  const answer = await executor.runTurn(prompt, (update) => updateActiveWork(update));
  const markdown = [
    "## 原请求 Agent 已继续处理协作结果",
    "",
    `- 任务：\`${task.taskId}\``,
    `- Git：\`${task.resultGit.branch}@${task.resultGit.commit.slice(0, 12)}\``,
    "",
    String(answer || "Agent 已接收结果，但没有返回文本总结。").slice(0, config.maxReplyChars),
  ].join("\n");
  await channel.send(task.groupChatId, { markdown }, {
    mentions: [{ key: "requester", openId: task.requesterHumanOpenId, name: "请求者" }],
  });
  await audit("task.result_resumed", `agent:${config.agent.id}`, {
    taskId: task.taskId,
    details: { peerAgentId: task.peerAgentId, branch: task.resultGit.branch, commit: task.resultGit.commit },
  });
}

function inboundEventMarkdown(event, task) {
  const labels = {
    "task.request": "收到新的 Git 协作任务",
    "task.accepted": "peer 已接单",
    "task.progress": `peer 进度：${event.payload.message}`,
    "task.result": "peer 已返回结果，等待请求者或审批者确认",
    "task.blocked": `peer 阻塞：${event.payload.reason}`,
    "task.rejected": `peer 已拒绝：${event.payload.reason}`,
    "task.approved": "请求方已批准结果",
  };
  return [
    `## ${labels[event.kind]}`,
    "",
    `- 任务：\`${task.taskId}\``,
    `- requester：\`${task.requesterAgentId}\``,
    `- executor：\`${task.executorAgentId}\``,
    `- 仓库：\`${task.githubRepository}\``,
    `- Git：\`${(event.payload.git || task.requestGit || task.resultGit)?.branch || task.branch}@${((event.payload.git || task.requestGit || task.resultGit)?.commit || "unknown").slice(0, 12)}\``,
  ].join("\n");
}

async function processPeerControlMessage(msg, route, content) {
  if (content.startsWith("/agent-event")) {
    const decoded = decodeAgentEvent(content);
    const event = validateIncomingAgentEvent(decoded, { config, peer: route.peer, chatId: msg.chatId });
    const recorded = await teamTaskStore.recordInboundEvent(event, {
      peer: route.peer,
      chatId: msg.chatId,
      localProjectId: config.project.id,
    });
    if (recorded.duplicate) {
      log(`duplicate Agent event ${event.eventId} ignored for ${event.taskId}`);
      await audit("agent_event.duplicate", `peer:${route.peer.agentId}`, {
        taskId: event.taskId,
        details: { eventId: event.eventId, kind: event.kind },
      });
      return true;
    }
    await audit("agent_event.accepted", `peer:${route.peer.agentId}`, {
      taskId: event.taskId,
      details: { eventId: event.eventId, kind: event.kind, chatId: msg.chatId },
    });
    if (event.kind === "task.request") {
      const current = teamTaskStore.get(event.taskId);
      const { plan, mode } = await landingPlanForTask(current);
      await replyCommand(msg, buildTaskLandingMarkdown(current, plan, mode));
      if (mode === "auto") {
        void enqueueWork(() => executeInboundTask(event.taskId, {
          approvedByOpenId: "auto",
          landingChoice: "auto",
        }));
      }
      log(`Agent task request accepted from ${route.peer.agentId} for ${event.taskId} in ${mode} mode`);
      return true;
    }
    await replyCommand(msg, inboundEventMarkdown(event, recorded.task));
    if (event.kind === "task.result" && recorded.task.resultMode === "resume") {
      void enqueueWork(async () => {
        try { await resumeOutboundResult(teamTaskStore.get(event.taskId)); }
        catch (error) {
          await audit("task.result_resume_blocked", `agent:${config.agent.id}`, {
            taskId: event.taskId,
            details: { errorCode: safeErrorCode(error) },
          });
          await channel.send(msg.chatId, {
            markdown: `协作结果已收到，但自动继续被本地安全检查阻塞。请查看 \`/team-tasks\` 和 \`/audit\` 后人工处理。`,
          }, {
            mentions: [{ key: "requester", openId: recorded.task.requesterHumanOpenId, name: "请求者" }],
          });
          log(`task result resume blocked for ${event.taskId}: ${safeError(error)}`);
        }
      });
    }
    log(`Agent event ${event.kind} accepted from ${route.peer.agentId} for ${event.taskId}`);
    return true;
  }
  const request = parsePeerControlMessage(content);
  if (request.error) {
    log(`peer control ${msg.messageId} rejected: ${request.error}`);
    return false;
  }
  if (request.githubRepository !== config.collaboration.githubRepository) {
    log(`peer control ${msg.messageId} rejected: repository_mismatch`);
    return false;
  }
  await replyCommand(msg, buildPeerControlReply(config, route.peer, request));
  await audit("peer_control.accepted", `peer:${route.peer.agentId}`, {
    details: { action: request.action, requestId: request.requestId },
  });
  log(`peer control ${request.action} accepted from ${route.peer.agentId} for ${config.project.id}`);
  return true;
}

channel.on("message", async (msg) => {
  const route = classifyInboundMessage(msg, config, connectedBotOpenId);
  if (completed.has(msg.messageId)) return;
  const content = String(msg.content || "").trim();
  if (!content) return;

  if (route.kind === "peer") {
    await processPeerControlMessage(msg, route, content).catch(async (error) => {
      log(`peer control ${msg.messageId} failed: ${safeError(error)}`);
      await audit("agent_event.rejected", `peer:${route.peer.agentId}`, {
        details: { messageId: msg.messageId, errorCode: safeErrorCode(error) },
      }).catch((auditError) => log(`peer rejection audit failed: ${safeError(auditError)}`));
    });
    return;
  }
  if (route.kind === "ignore" && msg.senderIsBot && msg.mentionedBot) {
    await audit("peer_route.rejected", `bot:${msg.senderId || "unknown"}`, {
      details: { messageId: msg.messageId, reason: route.reason || "unknown", chatId: msg.chatId },
    }).catch((error) => log(`peer route rejection audit failed: ${safeError(error)}`));
  }
  if (route.kind !== "human") return;

  if (immediateCommands.has(commandName(content))) {
    await processMessage(msg, content, activeThreadId);
    return;
  }
  const targetThreadId = await resolveMessageThreadId();
  await workQueue.enqueue(targetThreadId, () => processQueuedMessage(msg, content, targetThreadId));
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
  void retryPendingAgentEvents();
  void scanCollaborationInbox();
});

let stopResolve;
const stopPromise = new Promise((resolve) => { stopResolve = resolve; });
let stopping = false;
async function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping Channel SDK bridge (${reason})`);
  try { await audit("bridge.stop_requested", `agent:${config.agent.id}`, { details: { reason } }); }
  finally { stopResolve(); }
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
const agentEventRetryTimer = setInterval(
  () => void retryPendingAgentEvents(),
  Math.max(15_000, Number(config.deliveryRetryMs) || 60_000),
);
const collaborationInboxTimer = setInterval(
  () => void scanCollaborationInbox().catch((error) => log(`collaboration inbox scan failed: ${safeError(error)}`)),
  1_000,
);

try {
  await channel.connect();
  channelConnected = true;
  const identity = channel.getBotIdentity();
  if (config.agent.botOpenId && config.agent.botOpenId !== identity.openId) {
    throw new Error(`Configured bot open_id does not match the connected Channel identity`);
  }
  connectedBotOpenId = identity.openId;
  await audit("channel.connected", `bot:${identity.openId}`, { details: { botName: identity.name || undefined } });
  log(`READY: Channel SDK connected as ${identity.name || identity.openId}`);
  void retryPendingDeliveries();
  void retryPendingAgentEvents();
  void scanCollaborationInbox();
  await stopPromise;
} finally {
  channelConnected = false;
  clearInterval(stopWatcher);
  clearInterval(deliveryRetryTimer);
  clearInterval(agentEventRetryTimer);
  clearInterval(collaborationInboxTimer);
  await channel.disconnect().catch(() => {});
  await audit("bridge.stopped", `agent:${config.agent.id}`).catch((error) => log(`final audit append failed: ${safeError(error)}`));
  await fs.rm(pidPath, { force: true });
  await fs.rm(stopPath, { force: true });
  log("Channel SDK bridge stopped");
}
