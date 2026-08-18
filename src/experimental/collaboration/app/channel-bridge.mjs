import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createLarkChannel } from "@larksuite/channel";
import { AgentEventOutbox } from "../persistence/agent-event-outbox.mjs";
import { CollaborationGitHandoff, writeCollaborationRegistration } from "../git/collaboration-git.mjs";
import { CollaborationRequestInbox } from "../protocol/collaboration-request-inbox.mjs";
import { startCodexProjectThread } from "../../../codex/codex-app-server.mjs";
import { AuditLog } from "../persistence/audit-log.mjs";
import {
  readLatestRolloutSnapshot,
} from "../codex/codex-status.mjs";
import { DeliveryOutbox } from "../../../persistence/delivery-outbox.mjs";
import { createSerializedFileWriter } from "../../../persistence/serialized-json-file.mjs";
import { createExecutor } from "../codex/executor-registry.mjs";
import { KnowledgeHub } from "../persistence/knowledge-hub.mjs";
import { runProcess } from "../runtime/process-runner.mjs";
import { createRolloutCompletionWatcher } from "../codex/rollout-completion.mjs";
import { ProjectContext } from "../git/project-context.mjs";
import { loadBridgeConfig, sdkGroupAllowlist } from "../config/team-config.mjs";
import { TeamTaskStore } from "../persistence/team-task-store.mjs";
import { TaskLeaseStore } from "../persistence/task-lease-store.mjs";
import { ThreadWorkQueue } from "../../../runtime/thread-work-queue.mjs";
import { commandName, createCommandRouter, immediateCommands } from "./command-router.mjs";
import { compactTitle, createStatusRenderer, safeProgressUpdate, sanitizeProgressNote } from "./progress-renderer.mjs";
import { createOutboundDelivery } from "./outbound-delivery.mjs";
import { registerInboundHandlers } from "./inbound-handler.mjs";
import { createSessionTurnOrchestrator } from "./session-turn-orchestrator.mjs";
import { createCollaborationOrchestrator } from "./collaboration-orchestrator.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../../../..");
const config = await loadBridgeConfig(path.join(repositoryRoot, "bridge.config.json"));
const projectContext = new ProjectContext(config.project);
const userProfile = process.env.USERPROFILE || process.env.HOME || os.homedir();
if (!userProfile) throw new Error("The user home directory is required to locate the Codex state database");
const runtimeDir = path.join(config.workspace, "work", "feishu-codex-bridge");
const pidPath = path.join(runtimeDir, "bridge.pid");
const readyPath = path.join(runtimeDir, "bridge-ready.json");
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

await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
await fs.rm(stopPath, { force: true });
await fs.rm(readyPath, { force: true });
await fs.writeFile(pidPath, String(process.pid), { encoding: "utf8", mode: 0o600 });
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
const enqueueWork = (callback) => workQueue.enqueue("collaboration", callback);
const writeCompleted = createSerializedFileWriter(statePath);
let connectedBotOpenId = config.agent.botOpenId;
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

async function persistCompleted(messageId) {
  completed.add(messageId);
  const recent = [...completed].slice(-1000);
  completed = new Set(recent);
  await writeCompleted(JSON.stringify(recent, null, 2));
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

const { retryPendingDeliveries } = createOutboundDelivery({
  channel,
  deliveryOutbox,
  isConnected: () => channelConnected,
  persistCompleted,
  log,
  safeError,
});

async function replyCommand(msg, markdown) {
  await channel.reply(msg, { markdown });
  await persistCompleted(msg.messageId);
}

async function startTemporaryChat(msg, firstMessage) {
  if (temporaryChat) {
    if (firstMessage) {
      const threadId = await resolveMessageThreadId();
      await workQueue.enqueue(threadId, () => processQueuedMessage(msg, firstMessage, threadId));
      return;
    }
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
      markdown: firstMessage
        ? "⏳ 正在创建临时 Chat，随后直接处理这条消息…"
        : "⏳ 正在创建临时 Chat…",
    });
    const thread = await createCodexThread("飞书临时 Chat");
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
    if (!firstMessage) {
      await persistCompleted(msg.messageId);
      await channel.reply(msg, { markdown: [
        "临时 Chat 已就绪。",
        "",
        "现在可以随时发送消息。它与原任务使用独立队列，可以并行处理。",
        "发送 `/endchat`（或 `/end`）即可立即返回原任务；已发出的临时 Chat 消息仍会在后台完成。",
      ].join("\n") });
    }
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
  if (firstMessage) {
    await workQueue.enqueue(session.threadId, () => processQueuedMessage(msg, firstMessage, session.threadId));
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

const {
  trustedPeer,
  requireTaskApprover,
  sendTaskEvent,
  dispatchCollaborationRequest,
  scanCollaborationInbox,
  retryPendingAgentEvents,
  landingPlanForTask,
  executeInboundTask,
  processPeerControlMessage,
} = createCollaborationOrchestrator({
  config,
  channel,
  agentEventOutbox,
  audit,
  log,
  safeError,
  safeErrorCode,
  collaborationGit,
  projectContext,
  getThread,
  collaborationInbox,
  teamTaskStore,
  enqueueWork,
  taskLeaseStore,
  executor,
  selectThread,
  replyCommand,
  listProjectThreads,
  isChannelConnected: () => channelConnected,
  updateActiveWork,
});

const { buildStatusMarkdown, buildCurrentMarkdown } = createStatusRenderer({
  config,
  projectContext,
  activeWorks,
  getActiveThreadId: () => activeThreadId,
  isChannelConnected: () => channelConnected,
  bridgeStartedAt,
  getQueuedCount: () => workQueue.queuedCount,
  deliveryOutbox,
  agentEventOutbox,
  auditLog,
  taskLeaseStore,
  getTemporaryChat: () => temporaryChat,
  getLastWork: () => lastWork,
  getThread,
});

const handleCommand = createCommandRouter({
  config, projectContext, codexHome, channel, audit, auditLog, teamTaskStore,
  knowledgeHub, deliveryOutbox, agentEventOutbox, taskLeaseStore, executor,
  getChannelConnected: () => channelConnected,
  getQueuedWorkCount: () => workQueue.queuedCount,
  getConnectedBotOpenId: () => connectedBotOpenId,
  getActiveThreadId: () => activeThreadId,
  getTemporaryChat: () => temporaryChat,
  getThread, listProjectThreads, activeProjectThread, getThreadSnapshot,
  buildStatusMarkdown, buildCurrentMarkdown,
  replyCommand, landingPlanForTask, requireTaskApprover, trustedPeer, normalizeCwd,
  dispatchCollaborationRequest, executeInboundTask, sendTaskEvent, selectThread,
  persistCompleted, log, startTemporaryChat, endTemporaryChat,
});

const { processMessage, processQueuedMessage } = createSessionTurnOrchestrator({
  config,
  channel,
  executor,
  activeWorks,
  setLastWork: (work) => { lastWork = work; },
  updateActiveWork,
  deliveryOutbox,
  log,
  handleCommand,
  projectContext,
  getThread,
  replyCommand,
  audit,
  persistCompleted,
  retryPendingDeliveries,
  safeError,
  safeErrorCode,
});

registerInboundHandlers({
  channel,
  config,
  getConnectedBotOpenId: () => connectedBotOpenId,
  isCompleted: (messageId) => completed.has(messageId),
  immediateCommands,
  commandName,
  processPeerControlMessage,
  safeError,
  safeErrorCode,
  audit,
  log,
  handleCommand: processMessage,
  getActiveThreadId: () => activeThreadId,
  resolveMessageThreadId,
  enqueueThreadWork: (threadId, callback) => workQueue.enqueue(threadId, callback),
  processQueuedMessage,
  setChannelConnected: (connected) => { channelConnected = connected; },
  retryPendingAgentEvents,
  scanCollaborationInbox,
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
  await fs.writeFile(readyPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    mode: "channel-bridge",
    readyAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
  await fs.rm(readyPath, { force: true });
  await fs.rm(pidPath, { force: true });
  await fs.rm(stopPath, { force: true });
  log("Channel SDK bridge stopped");
}
