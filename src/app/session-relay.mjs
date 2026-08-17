import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { basenameFsPath } from "../runtime/shared/fs-paths.mjs";
import { createLarkChannel } from "@larksuite/channel";
import { setCodexThreadName, startCodexProjectThread } from "../codex/codex-app-server.mjs";
import { extractCodexAnswerMedia } from "../codex/codex-answer-media.mjs";
import { CodexDesktopCatalog } from "../codex/codex-desktop-catalog.mjs";
import { CodexSessionController, isFeishuMessageClientId } from "../codex/codex-session-controller.mjs";
import { CodexSessionStore } from "../codex/codex-session-store.mjs";
import {
  buildExternalTurnPost,
  buildFinalAnswerReplyPost,
  buildGoalTurnPost,
  buildSessionProgressPost,
  externalTurnDeliveryId,
} from "../codex/codex-session-observer.mjs";
import { DeliveryOutbox, deliveryIdempotencyKey } from "../persistence/delivery-outbox.mjs";
import { createSerializedFileWriter } from "../persistence/serialized-json-file.mjs";
import {
  FEISHU_FILE_MAX_BYTES,
  FEISHU_IMAGE_MAX_BYTES,
  buildNativeAttachmentDeliveries,
  buildNativeAttachmentMessage,
  classifyFeishuImageSize,
  inspectFeishuNativeAttachment,
  uploadFeishuNativeAttachment,
} from "../feishu/feishu-native-attachment.mjs";
import { FeishuFeedGroupManager } from "../feishu/feishu-feed-group.mjs";
import {
  FeishuInboundAttachmentStore,
  prepareFeishuPrompt,
} from "../feishu/feishu-inbound-attachment.mjs";
import {
  buildLongAnswerDocumentMarkdown,
  buildLongAnswerDocumentTitle,
  FeishuLongAnswerDocumentManager,
  LongAnswerDocumentStore,
  shouldCreateLongAnswerDocument,
} from "../feishu/feishu-long-answer-document.mjs";
import { FeishuSessionChatManager } from "../feishu/feishu-session-chat.mjs";
import { SessionAddFlow } from "../relay/session-add-flow.mjs";
import {
  buildCalendarSchedulingPrompt,
  parseCalendarSchedulingCommand,
} from "../relay/calendar-scheduling-command.mjs";
import {
  SessionAttachmentDraftStore,
  shouldStageAttachmentPrompt,
} from "../persistence/session-attachment-drafts.mjs";
import { SessionBindingInbox } from "../persistence/session-binding-inbox.mjs";
import { SessionBindingProvisioner } from "../relay/session-binding-provisioner.mjs";
import { SessionBindingRemover } from "../relay/session-binding-remover.mjs";
import { SessionBindingRegistry } from "../persistence/session-binding-registry.mjs";
import { SessionDeleteFlow } from "../relay/session-delete-flow.mjs";
import { SessionInputLedger } from "../persistence/session-input-ledger.mjs";
import {
  executeGlobalSettingsCommand,
  executeSessionCommand,
  parseQueueAction,
  parseSessionCommand,
  parseSteerAction,
  publicCommandFailure,
} from "../relay/session-relay-commands.mjs";
import {
  assertRelayMessage,
  assertSoloGroup,
  planSessionNameSync,
  resolveCompletedTurnRoute,
  SessionRelayError,
} from "../relay/session-relay-core.mjs";
import { SessionPromptQueue } from "../persistence/session-prompt-queue.mjs";
import { TemporaryChatStore } from "../persistence/temporary-chat-store.mjs";
import { loadSessionRelayConfig } from "../relay/session-relay-config.mjs";
import { SessionRelaySettingsStore } from "../persistence/session-relay-settings.mjs";
import { parseTemporaryChatCommand } from "../relay/temporary-chat-command.mjs";
import {
  buildSessionStreamCard,
  buildSessionStreamCardFollowups,
  SessionStreamCardStore,
} from "../feishu/session-stream-card.mjs";
import { ThreadWorkQueue } from "../runtime/thread-work-queue.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");
const configPath = path.join(repositoryRoot, "bridge.config.json");
const config = await loadSessionRelayConfig(configPath);
const userProfile = process.env.USERPROFILE || process.env.HOME || os.homedir();
if (!userProfile) throw new Error("The user home directory is required to locate Codex state");

const runtimeDir = path.join(config.workspace, "work", "feishu-codex-bridge");
const pidPath = path.join(runtimeDir, "bridge.pid");
const readyPath = path.join(runtimeDir, "bridge-ready.json");
const stopPath = path.join(runtimeDir, "stop.request");
const completedPath = path.join(runtimeDir, "session-relay-completed.json");
const deliveryOutboxPath = path.join(runtimeDir, "session-relay-pending-deliveries.json");
const inputLedgerPath = path.join(runtimeDir, "session-relay-input-ledger.json");
const promptQueuePath = path.join(runtimeDir, "session-relay-prompt-queue.json");
const relaySettingsPath = path.join(runtimeDir, "session-relay-settings.json");
const longAnswerDocumentsPath = path.join(runtimeDir, "session-relay-long-answer-documents.json");
const streamCardsPath = path.join(runtimeDir, "session-relay-stream-cards.json");
const inboundAttachmentsPath = path.join(runtimeDir, "session-relay-inbound-attachments");
const attachmentDraftsPath = path.join(runtimeDir, "session-relay-attachment-drafts.json");
const temporaryChatsPath = path.join(runtimeDir, "session-relay-temporary-chats.json");
const bindingInboxPath = path.join(runtimeDir, "session-binding-requests");
const restartRequestPath = path.join(runtimeDir, "restart.request");
const supervisorPidPath = path.join(runtimeDir, "bridge-supervisor.pid");
const sessionStore = new CodexSessionStore({
  stateDbPath: path.join(userProfile, ".codex", "state_5.sqlite"),
  sessionIndexPath: path.join(userProfile, ".codex", "session_index.jsonl"),
});
const bindingsByChat = new Map(config.sessionRelay.bindings.map((binding) => [binding.groupChatId, binding]));
const supportedPromptImageExtensions = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".ico", ".tif", ".tiff", ".heic",
]);
const maxFinalAnswerMediaItems = Number.MAX_SAFE_INTEGER;

const appSecret = process.env.LARK_APP_SECRET;
delete process.env.LARK_APP_SECRET;
if (!appSecret) throw new Error("LARK_APP_SECRET was not supplied by the secure launcher");

await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
await fs.rm(stopPath, { force: true });
await fs.rm(readyPath, { force: true });
await fs.writeFile(pidPath, String(process.pid), { encoding: "utf8", mode: 0o600 });
let sessionController;
const deliveryOutbox = await DeliveryOutbox.open(deliveryOutboxPath);
const inputLedger = await SessionInputLedger.open(inputLedgerPath);
const relaySettings = await SessionRelaySettingsStore.open(relaySettingsPath, {
  legacyInstall: config.sessionRelay.bindings.length > 0,
});
const temporaryChats = await TemporaryChatStore.open(temporaryChatsPath);
const longAnswerDocuments = await LongAnswerDocumentStore.open(longAnswerDocumentsPath);
const longAnswerDocumentManager = config.larkCliEntry
  ? new FeishuLongAnswerDocumentManager({
      nodeExecutable: config.nodeExecutable,
      larkCliEntry: config.larkCliEntry,
      cwd: repositoryRoot,
    })
  : undefined;
const streamCards = await SessionStreamCardStore.open(streamCardsPath);
const queuedWriterConflictNotices = new Set();
const inboundAttachmentStore = new FeishuInboundAttachmentStore(
  inboundAttachmentsPath,
  config.sessionRelay.inboundAttachments,
);
const attachmentDrafts = await SessionAttachmentDraftStore.open(attachmentDraftsPath, {
  maxItems: config.sessionRelay.inboundAttachments.maxItems,
  maxTotalBytes: config.sessionRelay.inboundAttachments.maxTotalBytes,
});
const promptQueue = await SessionPromptQueue.open(promptQueuePath, {
  getController: () => sessionController,
  onAccepted: async (queued, result) => {
    queuedWriterConflictNotices.delete(queued.messageId);
    await inputLedger.put({
      messageId: queued.messageId,
      chatId: queued.chatId,
      threadId: queued.feishuThreadId,
      kind: `queued:${result?.kind || "accepted"}`,
      createdAt: queued.createdAt,
    });
    await tryAdoptQueuedStreamCard({
      threadId: queued.sessionThreadId,
      turnId: result?.turnId,
      chatId: queued.chatId,
      queuedMessageId: queued.messageId,
    });
  },
  onError: (error, queued) => {
    log(`queued prompt dispatch deferred for ${queued?.messageId || "unknown"}: ${safeError(error)}`);
    if (error?.code === "session_writer_conflict") void showQueuedWriterConflict(error, queued);
  },
});
await attachmentDrafts.reconcile({
  isPromptAccepted: (messageId) => inputLedger.has(messageId) || promptQueue.has(messageId),
});
await inboundAttachmentStore.prune({
  protectedMessageIds: [
    ...promptQueue.list().map(({ messageId }) => messageId),
    ...attachmentDrafts.protectedMessageIds(),
  ],
  protectedAttachmentPaths: [
    ...promptQueue.list().flatMap(({ attachments }) => attachments.map(({ localPath }) => localPath)),
    ...attachmentDrafts.protectedAttachmentPaths(),
  ],
}).catch((error) => log(`inbound attachment cache cleanup deferred: ${safeError(error)}`));
for (const queued of promptQueue.list()) {
  if (inputLedger.has(queued.messageId)) continue;
  await inputLedger.put({
    messageId: queued.messageId,
    chatId: queued.chatId,
    threadId: queued.feishuThreadId,
    kind: "queued:recovered",
    createdAt: queued.createdAt,
  });
}
const bindingRegistry = new SessionBindingRegistry({ configPath });
const desktopCatalog = new CodexDesktopCatalog({
  codexHome: path.join(userProfile, ".codex"),
});
const feedGroupManager = config.sessionRelay.feedGroup.enabled
  ? new FeishuFeedGroupManager({
      nodeExecutable: config.nodeExecutable,
      larkCliEntry: config.larkCliEntry,
      agentName: config.sessionRelay.feedGroup.agentName,
      cwd: repositoryRoot,
    })
  : undefined;
const sessionChatManager = config.larkCliEntry
  ? new FeishuSessionChatManager({
      nodeExecutable: config.nodeExecutable,
      larkCliEntry: config.larkCliEntry,
      ownerOpenId: config.agent.ownerOpenId,
      cwd: repositoryRoot,
    })
  : undefined;

let completed = new Set();
try {
  const saved = JSON.parse(await fs.readFile(completedPath, "utf8"));
  completed = new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const writeCompleted = createSerializedFileWriter(completedPath);
let connectedBotOpenId = config.agent.botOpenId;
let channelConnected = false;
let deliveryRetryInFlight = false;
const inFlightMessageIds = new Set();
const turnOutputTails = new Map();
const inboundWorkQueue = new ThreadWorkQueue();

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function safeError(error) {
  const code = error?.response?.data?.code ?? error?.code ?? error?.cause?.response?.data?.code ?? error?.cause?.code;
  const rawMessage = error?.response?.data?.msg ?? error?.message ?? error?.cause?.response?.data?.msg ?? error?.cause?.message;
  const message = String(rawMessage || "")
    .replace(/[A-Za-z]:[\\/][^\r\n]*/g, "<local-path>")
    .replace(/(?:\\\\|\/\/)[^\s\\/]+[\\/][^\r\n]*/g, "<local-path>")
    .slice(0, 180);
  if (code !== undefined && code !== null) {
    return `code=${String(code).slice(0, 80)}${message ? `; message=${message}` : ""}`;
  }
  if (message) return message;
  return error instanceof Error ? error.name : "unknown";
}

function temporaryBinding(record) {
  if (!record) return undefined;
  return Object.freeze({
    groupChatId: record.conversationId,
    threadId: record.threadId,
    ownerOpenId: config.agent.ownerOpenId,
    temporary: true,
    chatType: record.chatType,
    cwd: record.cwd,
    baseBinding: bindingsByChat.get(record.conversationId),
  });
}

function resolveRelayBinding(chatId, threadId) {
  if (threadId) {
    const temporary = temporaryChats.getByThread(threadId);
    if (temporary?.conversationId === chatId) return temporaryBinding(temporary);
    const fixed = bindingsByChat.get(chatId);
    return fixed?.threadId === threadId ? fixed : undefined;
  }
  return temporaryBinding(temporaryChats.getActive(chatId)) || bindingsByChat.get(chatId);
}

async function inspectDeliveryTarget(chatId) {
  const fixed = bindingsByChat.get(chatId);
  if (fixed) return inspectBinding(fixed);
  if (!temporaryChats.hasPrivateConversation(chatId)) {
    throw new Error("Delivery has no configured Session conversation");
  }
  return undefined;
}

function dispatchQueuedPrompts(threadId) {
  void promptQueue.dispatch(threadId).catch((error) => {
    log(`queued prompt retry deferred for ${threadId}: ${safeError(error)}`);
  });
}

function dispatchAllQueuedPrompts() {
  void promptQueue.dispatchAll().catch((error) => {
    log(`queued prompt retry scan deferred: ${safeError(error)}`);
  });
}

function createSessionController(targets) {
  return new CodexSessionController({
    appServerUrl: config.sessionRelay.appServerUrl,
    targets,
    sandboxMode: config.sandboxMode,
    onTurnCompleted: async (record) => {
      dispatchQueuedPrompts(record.threadId);
      await enqueueTurnOutput(record.threadId, async () => {
        await processCompletedTurn(record);
        await retireEndedTemporaryChat(record.threadId);
      });
    },
    onTurnProgress: async (record) => enqueueTurnOutput(
      record.threadId,
      () => processTurnProgress(record),
    ),
    log,
  });
}

async function ensureSessionControllerTarget(target) {
  if (!sessionController) {
    sessionController = createSessionController([target]);
    await sessionController.start();
    return;
  }
  await sessionController.addTarget(target);
}

async function retireEndedTemporaryChat(threadId) {
  const record = temporaryChats.getByThread(threadId);
  if (!record || record.status !== "ended" || promptQueue.count(threadId) > 0) return false;
  const status = await sessionController?.getStatus(threadId, { refresh: false }).catch(() => undefined);
  if (status?.status?.type === "active" || status?.goal?.status === "active") return false;
  const deliveryPrefix = `codex-turn:${threadId}:`;
  if (deliveryOutbox.list().some(({ deliveryId }) => deliveryId.startsWith(deliveryPrefix))) return false;
  sessionController?.removeTarget(threadId);
  await temporaryChats.remove(threadId);
  return true;
}

function inboundAttachmentPruneProtection(extraMessageIds = []) {
  const queued = promptQueue.list();
  return {
    protectedMessageIds: [
      ...extraMessageIds,
      ...queued.map(({ messageId }) => messageId),
      ...attachmentDrafts.protectedMessageIds(),
    ],
    protectedAttachmentPaths: [
      ...queued.flatMap(({ attachments }) => (attachments || []).map(({ localPath }) => localPath)),
      ...attachmentDrafts.protectedAttachmentPaths(),
    ],
  };
}

async function pruneInboundAttachmentCache(extraMessageIds = []) {
  await inboundAttachmentStore.prune(inboundAttachmentPruneProtection(extraMessageIds));
}

function enqueueTurnOutput(threadId, work) {
  const key = String(threadId);
  const previous = turnOutputTails.get(key) || Promise.resolve();
  const running = previous.catch(() => {}).then(work);
  const tail = running.catch(() => {}).finally(() => {
    if (turnOutputTails.get(key) === tail) turnOutputTails.delete(key);
  });
  turnOutputTails.set(key, tail);
  return running;
}

async function persistCompleted(messageId) {
  completed.add(messageId);
  if (completed.size > 10_000) completed = new Set([...completed].slice(-8_000));
  const snapshot = JSON.stringify([...completed], null, 2);
  await writeCompleted(snapshot);
}

async function resolveNativeFileDelivery(record) {
  if (record.fileKey && (record.mediaType !== "video" || record.coverImageKey)) return record;
  const uploaded = await uploadFeishuNativeAttachment(channel.rawClient, record);
  const updated = {
    ...record,
    fileKey: uploaded.fileKey,
    coverImageKey: uploaded.coverImageKey,
    durationMs: uploaded.durationMs,
    fileName: uploaded.fileName,
    fileSize: uploaded.fileSize,
    modifiedAtMs: uploaded.modifiedAtMs,
    mediaType: uploaded.mediaType,
  };
  await deliveryOutbox.put(updated);
  return updated;
}

async function deliverPendingRecord(record) {
  if (record.kind === "file") {
    await inspectDeliveryTarget(record.chatId);
    const delivery = await resolveNativeFileDelivery(record);
    const message = buildNativeAttachmentMessage(delivery);
    const content = JSON.stringify(message.content);
    const response = delivery.messageId
      ? await channel.rawClient.im.message.reply({
        data: {
          content,
          msg_type: message.msgType,
          reply_in_thread: Boolean(delivery.threadId),
          uuid: deliveryIdempotencyKey(delivery.deliveryId),
        },
        path: { message_id: delivery.messageId },
      })
      : await channel.rawClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: delivery.chatId,
          content,
          msg_type: message.msgType,
          uuid: deliveryIdempotencyKey(delivery.deliveryId),
        },
      });
    if (response?.code !== undefined && response.code !== 0) {
      throw new Error(`Feishu native attachment send failed with code ${response.code}`);
    }
    return response?.data?.message_id || response?.data?.message?.message_id;
  }
  if (record.kind === "send") {
    await inspectDeliveryTarget(record.chatId);
    const response = await channel.rawClient.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: record.chatId,
        content: JSON.stringify(record.post),
        msg_type: "post",
        uuid: deliveryIdempotencyKey(record.deliveryId),
      },
    });
    if (response?.code !== undefined && response.code !== 0) {
      throw new Error(`Feishu send failed with code ${response.code}`);
    }
    return response?.data?.message_id || response?.data?.message?.message_id;
  }
  if (!record.publicStatus) await inspectDeliveryTarget(record.chatId);
  const response = await channel.rawClient.im.message.reply({
    data: {
      content: JSON.stringify(record.post || {
        zh_cn: { content: [[{ tag: "md", text: record.markdown }]] },
      }),
      msg_type: "post",
      reply_in_thread: Boolean(record.threadId),
      uuid: deliveryIdempotencyKey(record.deliveryId),
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
      if (record.dependsOn && deliveryOutbox.has(record.dependsOn)) continue;
      try {
        await deliverPendingRecord(record);
        await persistCompleted(record.deliveryId);
        await deliveryOutbox.remove(record.deliveryId);
        const label = record.kind === "file"
          ? "native attachment"
          : record.kind === "send" ? "proactive final answer" : "final reply";
        log(`deferred ${label} delivered for ${record.deliveryId}`);
      } catch (error) {
        await deliveryOutbox.markFailure(record.deliveryId, error);
        log(`deferred delivery failed for ${record.deliveryId}: ${safeError(error)}`);
      }
    }
  } finally {
    deliveryRetryInFlight = false;
    for (const temporaryChat of temporaryChats.list()) {
      if (temporaryChat.status === "ended") {
        await retireEndedTemporaryChat(temporaryChat.threadId).catch(() => {});
      }
    }
  }
}

async function inspectBinding(binding, { syncName = true } = {}) {
  if (binding?.temporary === true) {
    if (binding.chatType === "group" && !binding.baseBinding) {
      throw new SessionRelayError("session_unavailable", "The temporary group Chat lost its base binding");
    }
    if (binding.baseBinding) await inspectBinding(binding.baseBinding, { syncName });
    const session = await sessionStore.get(binding.threadId);
    return {
      session: session || Object.freeze({
        id: binding.threadId,
        title: "Feishu temporary Chat",
        cwd: binding.cwd,
      }),
      chatInfo: undefined,
    };
  }
  const session = await sessionStore.get(binding.threadId);
  if (!session) {
    throw new SessionRelayError("session_unavailable", "The bound Codex session is missing or archived");
  }

  let chatInfo;
  let members;
  let bots;
  try {
    [chatInfo, members, bots] = await Promise.all([
      channel.getChatInfo(binding.groupChatId),
      channel.getChatMembers(binding.groupChatId, { force: true, idType: "open_id", pageSize: 100, maxPages: 2 }),
      channel.getChatBots(binding.groupChatId, { force: true }),
    ]);
  } catch (error) {
    throw new SessionRelayError(
      "roster_unavailable",
      "The Bridge Bot cannot verify the bound group's complete membership",
      { cause: error },
    );
  }
  assertSoloGroup({ chatInfo, members, bots, binding, connectedBotOpenId });

  const groupName = String(chatInfo.name || "").trim();
  const nameSync = planSessionNameSync(config.sessionRelay.nameSync, groupName, session.title);
  if (nameSync.renameSessionTo) {
    if (!syncName) {
      throw new SessionRelayError("name_mismatch", "The group and Codex session names do not match");
    }
    try {
      await setCodexThreadName({
        codexExecutable: config.codexExecutable,
        cwd: session.cwd,
        threadId: session.id,
        name: nameSync.renameSessionTo,
        appServerUrl: config.sessionRelay.appServerUrl,
      });
      log("synchronized a bound Codex session name from its Feishu group");
    } catch (error) {
      throw new SessionRelayError("name_sync_failed", "The Codex session name could not be synchronized", { cause: error });
    }
    return { session: Object.freeze({ ...session, title: nameSync.renameSessionTo }), chatInfo };
  }
  return { session, chatInfo };
}

async function createIndependentSession({ name, cwd }) {
  const requested = String(cwd || "").trim();
  if (!path.isAbsolute(requested)) {
    throw new SessionRelayError("independent_cwd_invalid", "Independent task cwd must be an absolute path");
  }
  let realCwd;
  try {
    realCwd = await fs.realpath(path.resolve(requested));
    const stat = await fs.stat(realCwd);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new SessionRelayError(
      "independent_cwd_invalid",
      "Independent task cwd does not exist or is not a directory",
      { cause: error },
    );
  }
  const thread = await startCodexProjectThread({
    codexExecutable: config.codexExecutable,
    cwd: realCwd,
    name,
    sandboxMode: config.sandboxMode,
    appServerUrl: config.sessionRelay.appServerUrl,
  });
  return Object.freeze({
    id: thread.id,
    title: thread.name,
    cwd: realCwd,
    kind: "independent",
  });
}

async function createProjectSession({ name, project }) {
  let realCwd;
  for (const root of Array.isArray(project?.rootPaths) ? project.rootPaths : []) {
    const requested = String(root || "").trim();
    if (!requested || !path.isAbsolute(requested)) continue;
    try {
      const candidate = await fs.realpath(path.resolve(requested));
      const stat = await fs.stat(candidate);
      if (!stat.isDirectory()) continue;
      realCwd = candidate;
      break;
    } catch {
      // Try the next Desktop Project root without exposing local paths to Feishu.
    }
  }
  if (!realCwd) {
    throw new SessionRelayError(
      "project_cwd_unavailable",
      "The selected Desktop Project has no available registered working directory",
    );
  }
  const thread = await startCodexProjectThread({
    codexExecutable: config.codexExecutable,
    cwd: realCwd,
    name,
    sandboxMode: config.sandboxMode,
    appServerUrl: config.sessionRelay.appServerUrl,
  });
  return Object.freeze({
    id: thread.id,
    title: thread.name,
    cwd: realCwd,
    kind: "project",
    projectId: project.id,
    projectName: project.name,
  });
}

async function verifyCreatedGroup({ binding, groupName }) {
  const [chatInfo, members, bots] = await Promise.all([
    channel.getChatInfo(binding.groupChatId),
    channel.getChatMembers(binding.groupChatId, { force: true, idType: "open_id", pageSize: 100, maxPages: 2 }),
    channel.getChatBots(binding.groupChatId, { force: true }),
  ]);
  assertSoloGroup({ chatInfo, members, bots, binding, connectedBotOpenId });
  if (String(chatInfo?.name || "").trim() !== groupName) {
    throw new SessionRelayError("created_group_name_mismatch", "Feishu returned a different group name");
  }
}

async function sendBindingWelcome({ chatId, groupName, feedGroupName, settings }) {
  const inputMode = settings?.inputMode === "queue" ? "queue（排队新 Turn）" : "steer（调整当前回答）";
  await channel.send(chatId, {
    markdown: [
      "### Codex Session 已绑定",
      "",
      `- 群名：${groupName}`,
      `- 标签：${feedGroupName}`,
      "- 本群固定对应一个 Codex 任务",
      `- 普通消息默认：${inputMode}`,
      `- 公开进度：${settings?.publicProgress ? "开启" : "关闭"}`,
      `- 最终回答提醒：${settings?.finalMention === false ? "关闭" : "开启（@你）"}`,
      "",
      "Bridge 重载后，可直接发送 Prompt，无需 @Bot。使用 `/settings` 调整普通消息方式、公开进度和最终回答 @提醒。",
    ].join("\n"),
  });
}

function publicBindingFailure(error) {
  switch (error?.code) {
    case "binding_delete_busy":
      return "当前 Codex 任务仍在回答或运行 Goal。请先等待完成，或使用 `/goal pause`、`/stop`，然后再次发送 `/delete confirm`。";
    case "binding_delete_queued":
      return "当前 Session 仍有待执行 Prompt。请先发送 `/queue` 查看，并用 `/queue remove <序号>` 或 `/queue clear` 处理后，再次发送 `/delete confirm`。";
    case "binding_tag_remove_failed":
      return "未能移除当前群的 Agent 标签，因此绑定保持不变。请确认 `im:feed_group_v1:write` 用户授权可用后重试 `/delete confirm`。";
    case "binding_changed":
      return "群与 Session 的绑定已经发生变化，没有执行解除。请重新发送 `/delete` 查看当前状态。";
    case "binding_remove_failed":
      return "本机绑定配置写入失败；Bridge 已尝试恢复 Agent 标签，当前群仍按原绑定处理。请检查本机配置后重试。";
    case "feed_group_auth_required":
      return "自动建群需要当前飞书用户授权 `im:feed_group_v1:read/write`，用于创建并应用 Agent 标签。请完成增量 OAuth 授权后重试 `/add`。";
    case "feed_group_name_conflict":
    case "feed_group_name_ambiguous":
      return "Agent 标签名称存在冲突，尚未创建群。请在飞书中保留唯一的普通标签后重试 `/add`。";
    case "feed_group_cli_unavailable":
      return "本机飞书 CLI 当前不可用，尚未创建群。请先恢复 CLI 后重试 `/add`。";
    case "chat_create_auth_required":
      return "自动建群尚缺少 Bot 权限 `im:chat:create`。请在飞书开放平台为当前应用开通并发布后重试 `/add`；不需要重新授权用户 Feed 标签权限。";
    case "created_group_tag_failed":
      return "飞书群已创建，但未能自动应用 Agent 标签，因此没有写入 Session 绑定。请检查 `im:feed_group_v1:read/write` 用户授权后重新开始。";
    case "session_not_bindable":
      return "该任务不存在、已归档，或不在 Codex Desktop 的 Project/独立清单中，因此没有建群。";
    case "session_already_bound":
      return "该 Codex 任务已经绑定飞书群，没有重复创建。";
    case "independent_cwd_invalid":
      return "独立任务的工作目录必须是本机已存在的绝对目录，请重新发送 `/add`。";
    case "project_cwd_unavailable":
      return "所选 Project 没有可用的已登记工作目录，因此没有创建任务或群。请先在 Codex Desktop 修复 Project 目录，再重新发送 `/add`。";
    case "created_group_verification_failed":
      return "新群没有通过“仅你 + 当前 Bot”的成员校验，因此没有写入绑定。";
    case "binding_persist_failed":
      return "新群和标签已创建，但本机绑定配置写入失败。Bridge 没有把该群当作可用 Session 群，请在本机检查配置。";
    case "settings_persist_failed":
      return "新群和标签已创建，但新绑定默认设置无法在本机持久化，因此没有继续写入 Session 绑定。请检查本机工作目录后重试。";
    default:
      return "创建 Session 群失败，未改投到其他 Codex 任务。请稍后重新发送 `/add`。";
  }
}

async function syncConfiguredFeedGroups() {
  if (!feedGroupManager || !channelConnected) return;
  try {
    const bindings = await bindingRegistry.list();
    await feedGroupManager.ensureChats(bindings.map(({ groupChatId }) => groupChatId));
  } catch (error) {
    log(`Feed group retry unavailable: ${safeError(error)}`);
  }
}

function publicFailure(error) {
  if (error?.publicMessage) return String(error.publicMessage);
  switch (error?.code) {
    case "session_system_error":
      return "绑定的 Codex 任务当前处于系统错误状态。请先在 Codex Desktop 中查看并恢复该任务。";
    case "codex_app_server_timeout":
    case "codex_app_server_error":
      return "本机 Codex 服务没有接受这次操作；消息未被改投到其他任务。请发送 `/status` 确认状态后重试。";
    case "roster_unavailable":
      return "群绑定尚未就绪：Bridge 无法用 Bot 身份核验群成员。请为该飞书应用开通 `im:chat:readonly` 与 `im:chat.members:read` 并发布新版本。为安全起见，本消息没有进入 Codex。";
    case "not_solo":
    case "wrong_bot":
      return "已停止转发：这个群不再严格只有你和当前 Bridge Bot。为安全起见，本消息没有进入 Codex。";
    case "session_unavailable":
      return "群绑定的 Codex 任务不存在或已归档。本消息没有进入其他任务。";
    case "name_mismatch":
    case "name_sync_failed":
    case "group_name_missing":
    case "session_name_missing":
      return "群绑定尚未就绪：飞书群名与 Codex 任务名无法保持一致。本消息没有进入 Codex。";
    case "input_too_long":
      return `消息超过当前 ${config.maxInputChars} 字符上限，本消息没有进入 Codex。`;
    case "attachment_disabled":
      return "当前 Bridge 配置未启用飞书图片与附件输入；本消息没有进入 Codex。";
    case "attachment_unsupported":
      return "这条飞书消息包含当前接口无法下载的资源类型（例如表情包或合并转发子消息）；本消息没有进入 Codex。请改为发送普通图片或文件。";
    case "attachment_cache_unsafe":
      return "Bridge 的本机附件缓存目录未通过安全检查；本消息没有进入 Codex。请在本机检查 Bridge 运行目录。";
    case "attachment_too_many":
      return `单条消息最多接收 ${config.sessionRelay.inboundAttachments.maxItems} 个图片或附件；请拆分后重新发送。`;
    case "attachment_too_large":
      return `单个图片或附件不能超过 ${Math.floor(config.sessionRelay.inboundAttachments.maxFileBytes / 1024 / 1024)} MiB；请压缩或拆分后重新发送。`;
    case "attachment_total_too_large":
      return `单条消息的图片和附件总计不能超过 ${Math.floor(config.sessionRelay.inboundAttachments.maxTotalBytes / 1024 / 1024)} MiB；请拆分后重新发送。`;
    case "attachment_draft_full":
      return `当前暂存区最多接收 ${config.sessionRelay.inboundAttachments.maxItems} 个附件。请先发送文字 Prompt，或使用 \`/attachments clear\` 清空后重试。`;
    case "attachment_draft_total_too_large":
      return `当前暂存附件总计不能超过 ${Math.floor(config.sessionRelay.inboundAttachments.maxTotalBytes / 1024 / 1024)} MiB。请先发送文字 Prompt，或使用 \`/attachments clear\` 清空后重试。`;
    case "attachment_draft_busy":
      return "上一条文字 Prompt 正在接收暂存附件，请稍后重试；附件不会被改投到其他任务。";
    case "attachment_draft_conflict":
      return "这条飞书附件消息已经关联到另一份暂存记录，没有重复加入。";
    case "attachment_download_failed":
      return "Bridge 无法下载这条飞书附件。请确认应用已开通并发布 `im:message`（或 `im:message:readonly`），且消息未设为保密、群未开启防泄密模式；然后重新发送附件。";
    case "session_busy":
      return "绑定的 Codex 任务在等待时限内没有恢复空闲。请等待当前回答完成或中断后重试。";
    case "codex_app_server_unavailable":
      return "本机共享 Codex 服务当前未连接。请先重新启动 Bridge，再重试本消息。";
    case "unsupported_message":
      return "当前 Session Relay 接收文本、图片和普通附件；暂不支持这种飞书消息类型。";
    default:
      return "Codex 本轮处理失败，未能生成最终回复。请稍后重试。";
  }
}

async function replyFailure(msg, error) {
  try {
    await channel.reply(msg, { text: publicFailure(error) });
    await persistCompleted(msg.messageId);
  } catch (replyError) {
    log(`failure reply could not be delivered for ${msg.messageId}: ${safeError(replyError)}`);
  }
}

async function queueDeliveryBundle(records, successLog) {
  const pendingRecords = (Array.isArray(records) ? records : [])
    .filter((record) => record?.deliveryId && !completed.has(record.deliveryId));
  if (pendingRecords.length === 0) return;
  await deliveryOutbox.putMany(pendingRecords);
  if (!channelConnected) return;
  let deliveredAll = true;
  for (const record of pendingRecords) {
    if (record.dependsOn && deliveryOutbox.has(record.dependsOn)) {
      deliveredAll = false;
      continue;
    }
    try {
      const pending = deliveryOutbox.list().find((item) => item.deliveryId === record.deliveryId);
      if (!pending) continue;
      await deliverPendingRecord(pending);
      await persistCompleted(record.deliveryId);
      await deliveryOutbox.remove(record.deliveryId);
    } catch (error) {
      deliveredAll = false;
      await deliveryOutbox.markFailure(record.deliveryId, error);
      log(`delivery deferred for ${record.deliveryId}: ${safeError(error)}`);
    }
  }
  if (deliveredAll && successLog) log(successLog);
}

async function queueDelivery(record, successLog) {
  await queueDeliveryBundle([record], successLog);
}

async function ensureTurnStreamCard({ threadId, turnId, chatId }) {
  if (!threadId || !turnId || !chatId) return undefined;
  if (!relaySettings.get(threadId).publicProgress || !channelConnected) return undefined;
  const existing = streamCards.get(threadId, turnId);
  if (existing) return existing;
  const binding = resolveRelayBinding(chatId, threadId);
  if (!binding) return undefined;
  await inspectBinding(binding);
  const deliveryId = `codex-stream-card:${threadId}:${turnId}`;
  const startedAtMs = Date.now();
  const response = await channel.rawClient.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      content: JSON.stringify(buildSessionStreamCard({ startedAtMs, nowMs: startedAtMs })),
      msg_type: "interactive",
      uuid: deliveryIdempotencyKey(deliveryId),
    },
  });
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu stream card creation failed with code ${response.code}`);
  }
  const messageId = response?.data?.message_id || response?.data?.message?.message_id;
  if (!messageId) throw new Error("Feishu stream card creation returned no message id");
  const created = await streamCards.start({
    threadId,
    turnId,
    chatId,
    messageId,
    createdAt: startedAtMs,
  });
  log("created one persistent stream card for a Codex turn");
  return created;
}

function queuedStreamCardTurnId(messageId) {
  return `queued:${String(messageId)}`;
}

async function ensureQueuedStreamCard({ queued, position, alreadyQueued = false }) {
  const { sessionThreadId: threadId, chatId, messageId } = queued;
  const turnId = queuedStreamCardTurnId(messageId);
  const existing = streamCards.get(threadId, turnId);
  const card = buildSessionStreamCard({ queued: { position, alreadyQueued } });
  if (existing) {
    await channel.updateCard(existing.messageId, card);
    return existing;
  }
  if (!channelConnected) throw new Error("Feishu channel is disconnected while creating the queue card");
  const binding = resolveRelayBinding(chatId, threadId);
  if (!binding) throw new Error("Queued prompt has no available Session binding");
  await inspectBinding(binding);
  const response = await channel.rawClient.im.message.reply({
    data: {
      content: JSON.stringify(card),
      msg_type: "interactive",
      reply_in_thread: Boolean(queued.feishuThreadId),
      uuid: deliveryIdempotencyKey(`codex-queue-card:${messageId}`),
    },
    path: { message_id: messageId },
  });
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu queue card creation failed with code ${response.code}`);
  }
  const cardMessageId = response?.data?.message_id || response?.data?.message?.message_id;
  if (!cardMessageId) throw new Error("Feishu queue card creation returned no message id");
  const created = await streamCards.start({
    threadId,
    turnId,
    chatId,
    messageId: cardMessageId,
    createdAt: Date.now(),
  });
  log("created a queue card that can become the turn stream card");
  return created;
}

async function showQueuedWriterConflict(error, queued) {
  if (!queued?.messageId || !channelConnected) return;
  const current = streamCards.get(
    queued.sessionThreadId,
    queuedStreamCardTurnId(queued.messageId),
  );
  if (!current || queuedWriterConflictNotices.has(queued.messageId)) return;
  queuedWriterConflictNotices.add(queued.messageId);
  try {
    await channel.updateCard(current.messageId, buildSessionStreamCard({
      queued: { status: "blocked", reason: publicFailure(error) },
    }));
  } catch (updateError) {
    queuedWriterConflictNotices.delete(queued.messageId);
    log(`queue writer-conflict notice could not be delivered: ${safeError(updateError)}`);
  }
}

async function tryAdoptQueuedStreamCard({ threadId, turnId, chatId, queuedMessageId }) {
  if (!threadId || !turnId || !chatId || !queuedMessageId) {
    return tryEnsureTurnStreamCard({ threadId, turnId, chatId });
  }
  try {
    const startedAtMs = Date.now();
    const adopted = await streamCards.reassign(
      threadId,
      queuedStreamCardTurnId(queuedMessageId),
      turnId,
      { createdAt: startedAtMs },
    );
    if (!adopted) return tryEnsureTurnStreamCard({ threadId, turnId, chatId });
    if (channelConnected) {
      await channel.updateCard(adopted.messageId, buildSessionStreamCard({
        startedAtMs,
        nowMs: startedAtMs,
      }));
    }
    log("queue card adopted as the turn stream card");
    return adopted;
  } catch (error) {
    log(`queue card could not be adopted: ${safeError(error)}`);
    return tryEnsureTurnStreamCard({ threadId, turnId, chatId });
  }
}

async function retireQueuedStreamCard(queued, reason) {
  if (!queued) return;
  queuedWriterConflictNotices.delete(queued.messageId);
  const current = streamCards.get(queued.sessionThreadId, queuedStreamCardTurnId(queued.messageId));
  if (!current) return;
  try {
    if (channelConnected) {
      await channel.updateCard(current.messageId, buildSessionStreamCard({
        queued: { status: "cancelled", reason },
      }));
    }
  } catch (error) {
    log(`removed queue card could not be updated: ${safeError(error)}`);
  }
  await streamCards.remove(queued.sessionThreadId, queuedStreamCardTurnId(queued.messageId));
}

async function reconcilePendingQueueCards() {
  for (const queued of promptQueue.list().filter((record) => !record.dispatchReady)) {
    const position = promptQueue.list(queued.sessionThreadId)
      .findIndex((record) => record.messageId === queued.messageId) + 1;
    try {
      await ensureQueuedStreamCard({ queued, position });
      await promptQueue.markDispatchReady(queued.messageId);
    } catch (error) {
      log(`pending queue card reconciliation deferred: ${safeError(error)}`);
    }
  }
}

async function tryEnsureTurnStreamCard(record) {
  try {
    return await ensureTurnStreamCard(record);
  } catch (error) {
    log(`stream card could not be created: ${safeError(error)}`);
    return undefined;
  }
}

async function tryFinalizeTurnStreamCard(record, answerSegments) {
  const current = streamCards.get(record.threadId, record.turnId);
  if (!current || !channelConnected) return false;
  try {
    await channel.updateCard(current.messageId, buildSessionStreamCard({
      answer: record.answer,
      answerSegments,
      completedAtMs: record.completedAtMs,
      durationMs: record.durationMs,
      tokenUsage: record.tokenUsage,
      timeZone: config.sessionRelay.displayTimeZone,
      maxAnswerChars: config.maxReplyChars,
    }));
    log("final answer replaced progress in the original stream card");
    return true;
  } catch (error) {
    log(`stream card final update failed; using durable final delivery: ${safeError(error)}`);
    return false;
  }
}

async function queueStreamCardFollowups(baseRecord, attachments, mentionOpenId) {
  const records = buildSessionStreamCardFollowups(baseRecord, attachments, { mentionOpenId });
  await queueDeliveryBundle(records, "stream card final delivery completed");
}

async function tryCompleteTurnStreamCard(record, baseDelivery, media, mentionOpenId) {
  if (!await tryFinalizeTurnStreamCard(record, media.segments)) return false;
  await queueStreamCardFollowups(baseDelivery, media.attachments, mentionOpenId);
  await persistCompleted(baseDelivery.deliveryId);
  await streamCards.remove(record.threadId, record.turnId);
  return true;
}

async function enqueuePromptMessage(msg, binding, text, attachments = []) {
  return promptQueue.enqueue({
    messageId: msg.messageId,
    sessionThreadId: binding.threadId,
    chatId: msg.chatId,
    feishuThreadId: msg.threadId,
    text,
    attachments,
    dispatchReady: false,
    createdAt: Date.now(),
  }, {
    afterPersist: async (queued) => inputLedger.put({
      messageId: queued.messageId,
      chatId: queued.chatId,
      threadId: queued.feishuThreadId,
      kind: "queued",
      createdAt: queued.createdAt,
    }),
  });
}

async function processPromptMessage(msg, binding, prompt, { inputModeOverride } = {}) {
  const startedAt = Date.now();
  let accepted = false;
  log(`accepted relay message ${msg.messageId}`);
  try {
    const content = String(prompt?.text || "");
    const attachments = Array.isArray(prompt?.attachments) ? prompt.attachments : [];
    const settings = relaySettings.get(binding.threadId);
    const inputMode = inputModeOverride || settings.inputMode;
    if (inputMode === "queue") {
      await inspectBinding(binding);
      const queued = await enqueuePromptMessage(msg, binding, content, attachments);
      await ensureQueuedStreamCard({
        queued: queued.record,
        position: queued.position,
        alreadyQueued: queued.alreadyQueued,
      });
      await promptQueue.markDispatchReady(msg.messageId);
      accepted = true;
      dispatchQueuedPrompts(binding.threadId);
      log(`queued relay message ${msg.messageId}; position=${queued.position}; elapsedMs=${Date.now() - startedAt}`);
      return true;
    }
    const result = await sessionController.submitPrompt({
      threadId: binding.threadId,
      text: content,
      attachments,
      clientUserMessageId: msg.messageId,
    });
    accepted = true;
    await inputLedger.put({
      messageId: msg.messageId,
      chatId: msg.chatId,
      threadId: msg.threadId,
      kind: result.kind,
      createdAt: Date.now(),
    });
    await tryEnsureTurnStreamCard({
      threadId: binding.threadId,
      turnId: result.turnId,
      chatId: msg.chatId,
    });
    if (result.kind === "steered") {
      await queueDelivery({
        kind: "reply",
        deliveryId: `steer:${msg.messageId}`,
        messageId: msg.messageId,
        chatId: msg.chatId,
        threadId: msg.threadId,
        markdown: "已作为**调整方向**加入当前回答。",
        publicStatus: true,
        createdAt: Date.now(),
      }, `steer acknowledged for ${msg.messageId}`);
    } else if (result.boundaryChanged) {
      await queueDelivery({
        kind: "reply",
        deliveryId: `boundary:${msg.messageId}`,
        messageId: msg.messageId,
        chatId: msg.chatId,
        threadId: msg.threadId,
        markdown: "上一轮在提交瞬间已经结束；这条消息已明确作为**新一轮 Prompt**开始处理。",
        publicStatus: true,
        createdAt: Date.now(),
      }, `turn boundary notice delivered for ${msg.messageId}`);
    }
    log(`${result.kind} relay message ${msg.messageId} on turn ${result.turnId}; elapsedMs=${Date.now() - startedAt}`);
    return true;
  } catch (error) {
    log(`relay message ${msg.messageId} failed: ${safeError(error)}`);
    if (!accepted) await replyFailure(msg, error);
    else log(`relay message ${msg.messageId} was accepted before a follow-up operation failed`);
    return accepted;
  }
}

async function stageAttachmentMessage(msg, binding, prompt) {
  await inspectBinding(binding);
  const staged = await attachmentDrafts.stage({
    messageId: msg.messageId,
    sessionThreadId: binding.threadId,
    chatId: msg.chatId,
    feishuThreadId: msg.threadId,
    attachments: prompt.attachments,
    createdAt: Date.now(),
  });
  await inputLedger.put({
    messageId: msg.messageId,
    chatId: msg.chatId,
    threadId: msg.threadId,
    kind: "attachment:staged",
    createdAt: Date.now(),
  });
  const names = staged.record.attachments
    .map(({ name }) => String(name || "未命名附件").replace(/[\r\n`]/g, " "))
    .map((name) => `- ${name}`);
  await queueDelivery({
    kind: "reply",
    deliveryId: `attachment-staged:${msg.messageId}`,
    messageId: msg.messageId,
    chatId: msg.chatId,
    threadId: msg.threadId,
    markdown: [
      `### ${staged.alreadyStaged ? "附件已经暂存" : "附件已暂存"}`,
      "",
      ...names,
      "",
      `当前累计：${staged.attachmentCount} 个附件。`,
      "",
      "继续发送附件可以追加；发送第一条普通文字 Prompt 后，Bridge 会把全部暂存附件合并为一次 Codex 输入。",
      "",
      "> `/status`、`/model` 等命令不会消费附件；使用 `/attachments` 查看，或 `/attachments clear` 放弃。",
    ].join("\n"),
    publicStatus: true,
    createdAt: Date.now(),
  }, `staged ${staged.record.attachments.length} inbound attachment(s) from ${msg.messageId}`);
}

async function processPreparedPrompt(msg, binding, prompt) {
  const hasPendingDraft = attachmentDrafts.hasPending(binding.threadId);
  if (shouldStageAttachmentPrompt(prompt, { hasPendingDraft })) {
    await stageAttachmentMessage(msg, binding, prompt);
    return;
  }
  if (!String(prompt?.text || "").trim() || !hasPendingDraft) {
    await processPromptMessage(msg, binding, prompt);
    return;
  }

  const claim = await attachmentDrafts.claim(binding.threadId, msg.messageId, {
    additionalAttachments: prompt.attachments,
  });
  const accepted = await processPromptMessage(msg, binding, {
    ...prompt,
    attachments: claim.attachments,
  });
  try {
    if (accepted) await attachmentDrafts.completeClaim(msg.messageId);
    else await attachmentDrafts.releaseClaim(msg.messageId);
  } catch (error) {
    log(`attachment draft settlement deferred for ${msg.messageId}: ${safeError(error)}`);
  }
}

async function processCommandMessage(msg, binding, command) {
  log(`accepted session command /${command.name} from ${msg.messageId}`);
  try {
    await inspectBinding(binding);
    let markdown;
    let queueAction;
    let steerAction;
    let draftClaim;
    let queuedAccepted = false;
    let queuedResult;
    let steerHandled = false;
    let steerAccepted = false;
    let commandFailed = false;
    let queuedCardsToRetire = [];
    try {
      queueAction = command.name === "queue" ? parseQueueAction(command.args) : undefined;
      steerAction = command.name === "steer" ? parseSteerAction(command.args) : undefined;
      queuedCardsToRetire = queueAction?.action === "remove"
        ? [promptQueue.list(binding.threadId)[Number(queueAction.position) - 1]].filter(Boolean)
        : queueAction?.action === "clear" ? promptQueue.list(binding.threadId) : [];
      if (queueAction?.action === "enqueue" || steerAction?.action === "submit") {
        draftClaim = await attachmentDrafts.claim(binding.threadId, msg.messageId);
      }
      markdown = await executeSessionCommand(command, {
        controller: sessionController,
        threadId: binding.threadId,
        promptQueue,
        attachmentDraftStore: attachmentDrafts,
        settingsStore: relaySettings,
        enqueuePrompt: async (text) => {
          const queued = await enqueuePromptMessage(msg, binding, text, draftClaim?.attachments || []);
          queuedAccepted = true;
          queuedResult = queued;
          return queued;
        },
        steerPrompt: async (text) => {
          steerHandled = true;
          steerAccepted = await processPromptMessage(msg, binding, {
            text,
            attachments: draftClaim?.attachments || [],
          }, { inputModeOverride: "steer" });
          return { accepted: steerAccepted };
        },
      });
    } catch (error) {
      commandFailed = true;
      markdown = publicCommandFailure(error);
      log(`session command /${command.name} failed: ${safeError(error)}`);
    }
    if (draftClaim) {
      try {
        if (queuedAccepted || steerAccepted) await attachmentDrafts.completeClaim(msg.messageId);
        else await attachmentDrafts.releaseClaim(msg.messageId);
      } catch (error) {
        log(`attachment draft settlement deferred for prompt command ${msg.messageId}: ${safeError(error)}`);
      }
    }
    if (steerHandled) return;
    if (!inputLedger.has(msg.messageId)) {
      await inputLedger.put({
        messageId: msg.messageId,
        chatId: msg.chatId,
        threadId: msg.threadId,
        kind: `command:${command.name}`,
        createdAt: Date.now(),
      });
    }
    if (queuedResult && !commandFailed) {
      await ensureQueuedStreamCard({
        queued: queuedResult.record,
        position: queuedResult.position,
        alreadyQueued: queuedResult.alreadyQueued,
      });
      await promptQueue.markDispatchReady(msg.messageId);
    } else {
      await queueDelivery({
        kind: "reply",
        deliveryId: `command:${msg.messageId}`,
        messageId: msg.messageId,
        chatId: msg.chatId,
        threadId: msg.threadId,
        markdown,
        createdAt: Date.now(),
      }, `session command /${command.name} replied for ${msg.messageId}`);
    }
    if (!commandFailed && queueAction?.action === "remove") {
      await retireQueuedStreamCard(queuedCardsToRetire[0], "这条 Prompt 已通过 `/queue remove` 删除。");
    } else if (!commandFailed && queueAction?.action === "clear") {
      for (const queued of queuedCardsToRetire) {
        await retireQueuedStreamCard(queued, "队列已通过 `/queue clear` 清空。");
      }
    }
    if (queueAction?.action === "enqueue") dispatchQueuedPrompts(binding.threadId);
  } catch (error) {
    log(`session command /${command.name} could not be processed: ${safeError(error)}`);
    await replyFailure(msg, error);
  }
}

async function processGlobalSettingsMessage(msg, command) {
  log(`accepted global Session settings command from ${msg.messageId}`);
  let markdown;
  try {
    markdown = await executeGlobalSettingsCommand(command, { settingsStore: relaySettings });
  } catch (error) {
    markdown = publicCommandFailure(error);
    log(`global Session settings command failed: ${safeError(error)}`);
  }
  await channel.reply(msg, { markdown });
  await persistCompleted(msg.messageId);
}

async function temporaryChatCwd(baseBinding) {
  if (baseBinding) return (await inspectBinding(baseBinding)).session.cwd;
  const cwd = await fs.realpath(config.workspace);
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) throw new Error("The default Codex working directory is unavailable");
  return cwd;
}

async function startTemporaryChat(msg, baseBinding, firstPrompt) {
  if (firstPrompt.length > config.maxInputChars) {
    throw new SessionRelayError("input_too_long", "Message exceeds the configured input limit");
  }
  const current = temporaryChats.getActive(msg.chatId);
  if (current) {
    const binding = temporaryBinding(current);
    if (firstPrompt) {
      await processPreparedPrompt(msg, binding, { text: firstPrompt, attachments: [] });
      return;
    }
    await channel.reply(msg, {
      markdown: "当前已经处于临时 Chat。直接发送消息继续，或发送 `/endchat` 结束。",
    });
    await persistCompleted(msg.messageId);
    return;
  }

  await channel.reply(msg, {
    markdown: firstPrompt
      ? "正在创建临时 Chat，随后处理这条消息……"
      : "正在创建临时 Chat……",
  });
  const cwd = await temporaryChatCwd(baseBinding);
  const thread = await startCodexProjectThread({
    codexExecutable: config.codexExecutable,
    cwd,
    name: "飞书临时 Chat",
    sandboxMode: config.sandboxMode,
    appServerUrl: config.sessionRelay.appServerUrl,
  });
  const record = await temporaryChats.start({
    conversationId: msg.chatId,
    threadId: thread.id,
    cwd,
    chatType: msg.chatType,
    baseThreadId: baseBinding?.threadId,
    createdAt: Date.now(),
  });
  try {
    await ensureSessionControllerTarget({
      threadId: record.threadId,
      chatId: record.conversationId,
      cwd: record.cwd,
    });
    await relaySettings.initialize(record.threadId);
  } catch (error) {
    sessionController?.removeTarget(record.threadId);
    await temporaryChats.remove(record.threadId).catch(() => {});
    throw error;
  }

  const binding = temporaryBinding(record);
  if (firstPrompt) {
    await processPreparedPrompt(msg, binding, { text: firstPrompt, attachments: [] });
    return;
  }
  await channel.reply(msg, {
    markdown: [
      "临时 Chat 已就绪，可以直接发送消息。",
      "",
      baseBinding
        ? "它与原任务使用独立上下文；发送 `/endchat` 后返回原任务。"
        : "发送 `/endchat` 可结束本次私聊上下文；之后可再次发送 `/chat` 新建一个。",
      "",
      "已经提交的消息会在后台继续完成。",
    ].join("\n"),
  });
  await persistCompleted(msg.messageId);
}

async function endTemporaryChat(msg) {
  const current = temporaryChats.getActive(msg.chatId);
  if (!current) {
    await channel.reply(msg, { markdown: "当前不在临时 Chat 中。发送 `/chat` 可以创建一个。" });
    await persistCompleted(msg.messageId);
    return;
  }
  await temporaryChats.end(msg.chatId);
  await retireEndedTemporaryChat(current.threadId);
  await channel.reply(msg, {
    markdown: current.baseThreadId
      ? "已结束临时 Chat，后续消息会继续使用原绑定任务的完整上下文。已提交的临时消息仍会完成并回复。"
      : "已结束临时 Chat。已提交的消息仍会完成并回复；发送 `/chat` 可开始新的私聊上下文。",
  });
  await persistCompleted(msg.messageId);
}

async function processTemporaryChatCommand(msg, baseBinding, command) {
  try {
    if (command.action === "start") await startTemporaryChat(msg, baseBinding, command.prompt);
    else if (command.prompt) {
      await channel.reply(msg, { markdown: "用法：`/endchat`" });
      await persistCompleted(msg.messageId);
    } else await endTemporaryChat(msg);
  } catch (error) {
    log(`temporary Chat command failed: ${safeError(error)}`);
    await replyFailure(msg, error);
  }
}

async function processCalendarSchedulingCommand(msg, baseBinding, command) {
  if (!command.request) {
    await channel.reply(msg, {
      markdown: "用法：`/schedule <自然语言日程需求>`\n\n例如：`/schedule 明天下午 3 点和张三开一小时评审会，有会议室就一起预定`",
    });
    await persistCompleted(msg.messageId);
    return;
  }
  try {
    await startTemporaryChat(
      msg,
      baseBinding,
      buildCalendarSchedulingPrompt(command.request),
    );
  } catch (error) {
    log(`calendar scheduling command failed: ${safeError(error)}`);
    await replyFailure(msg, error);
  }
}

async function uploadPromptImages(resources) {
  const uploaded = [];
  for (const resource of resources || []) {
    if (resource?.type !== "image" || resource.source !== "local" || !resource.path) continue;
    const filePath = String(resource.path);
    try {
      if (!path.isAbsolute(filePath) || !supportedPromptImageExtensions.has(path.extname(filePath).toLowerCase())) {
        throw new Error("unsupported prompt image path");
      }
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > FEISHU_IMAGE_MAX_BYTES) {
        throw new Error("prompt image does not satisfy Feishu upload limits");
      }
      const response = await channel.rawClient.im.image.create({
        data: {
          image_type: "message",
          image: createReadStream(filePath),
        },
      });
      const imageKey = response?.image_key || response?.data?.image_key;
      if (!imageKey) throw new Error("Feishu image upload returned no image_key");
      uploaded.push(Object.freeze({ imageKey: String(imageKey), name: String(resource.name || "图片") }));
    } catch (error) {
      log(`prompt image could not be embedded (${String(resource.name || "image").slice(0, 100)}): ${safeError(error)}`);
    }
  }
  return uploaded;
}

async function prepareFinalAnswerMedia(answer) {
  const extracted = extractCodexAnswerMedia(answer, {
    maxImages: maxFinalAnswerMediaItems,
    maxAttachments: maxFinalAnswerMediaItems,
  });
  const documentMarkdown = buildLongAnswerDocumentMarkdown(extracted.segments);
  const uploadedByPath = new Map();
  const segments = [];
  const deliveryNotices = [];
  const attachments = [];
  const attachmentsByPath = new Map();

  const addNativeAttachment = async ({ localPath, fileName }) => {
    const existing = attachmentsByPath.get(localPath);
    if (existing) return existing;
    const inspected = await inspectFeishuNativeAttachment(localPath, { name: fileName });
    attachments.push(inspected);
    attachmentsByPath.set(localPath, inspected);
    return inspected;
  };
  const addDeliveryNotice = (text) => {
    const notice = Object.freeze({ type: "text", text });
    segments.push(notice);
    deliveryNotices.push(notice);
  };

  for (const attachment of extracted.attachments) {
    try {
      await addNativeAttachment({ localPath: attachment.path, fileName: attachment.name });
    } catch (error) {
      addDeliveryNotice("（一个附件未能作为飞书群文件发送；可在绑定的 Codex 任务中查看。）");
      log(`final answer attachment could not be prepared: ${safeError(error)}`);
    }
  }

  for (const segment of extracted.segments) {
    if (segment.type === "text") {
      segments.push(Object.freeze({ type: "text", text: segment.text }));
      continue;
    }

    let stat;
    try {
      if (!path.isAbsolute(segment.path)) throw new Error("unsupported final answer image path");
      stat = await fs.lstat(segment.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
        throw new Error("final answer image must be a regular non-empty file");
      }
      const delivery = classifyFeishuImageSize(stat.size);
      if (delivery === "too_large") {
        addDeliveryNotice("（图片超过飞书群文件 30 MB 上限；可在绑定的 Codex 任务中查看。）");
        log(`final answer image exceeds native attachment limit (${stat.size} bytes)`);
        continue;
      }
      if (delivery === "file") {
        await addNativeAttachment({ localPath: segment.path, fileName: basenameFsPath(segment.path) });
        addDeliveryNotice("（图片已作为群内原生附件发送。）");
        continue;
      }

      let imageKey = uploadedByPath.get(segment.path);
      if (!imageKey) {
        if (!supportedPromptImageExtensions.has(path.extname(segment.path).toLowerCase())) {
          throw new Error("unsupported final answer image path");
        }
        const response = await channel.rawClient.im.image.create({
          data: {
            image_type: "message",
            image: createReadStream(segment.path),
          },
        });
        imageKey = response?.image_key || response?.data?.image_key;
        if (!imageKey) throw new Error("Feishu image upload returned no image_key");
        imageKey = String(imageKey);
        uploadedByPath.set(segment.path, imageKey);
      }
      segments.push(Object.freeze({ type: "image", imageKey }));
    } catch (error) {
      try {
        if (!stat || stat.size > FEISHU_FILE_MAX_BYTES) throw error;
        await addNativeAttachment({ localPath: segment.path, fileName: basenameFsPath(segment.path) });
        addDeliveryNotice("（图片未能内嵌，已改为群内原生附件。）");
        log(`final answer image fell back to a native attachment: ${safeError(error)}`);
      } catch (fallbackError) {
        addDeliveryNotice("（图片未能上传到飞书；可在绑定的 Codex 任务中查看。）");
        log(`final answer image could not be delivered: ${safeError(fallbackError)}`);
      }
    }
  }

  if (extracted.strippedDirectiveCount > 0) {
    log(`stripped ${extracted.strippedDirectiveCount} Codex Desktop visualize directive(s) from final answer`);
  }
  if (extracted.strippedMetadataBlockCount > 0) {
    log(`stripped ${extracted.strippedMetadataBlockCount} renderer metadata block(s) from final answer`);
  }
  return Object.freeze({
    segments: Object.freeze(segments),
    deliveryNotices: Object.freeze(deliveryNotices),
    attachments: Object.freeze(attachments),
    documentMarkdown,
  });
}

async function prepareFinalAnswerDelivery(record) {
  const media = await prepareFinalAnswerMedia(record.answer);
  if (!shouldCreateLongAnswerDocument(record.answer, config.maxReplyChars)) return media;
  if (!longAnswerDocumentManager || !media.documentMarkdown) {
    log("long final answer could not be moved to a Feishu document; using the normal reply fallback");
    return media;
  }

  try {
    let document = longAnswerDocuments.get(record.threadId, record.turnId);
    if (!document) {
      const created = await longAnswerDocumentManager.create({
        title: buildLongAnswerDocumentTitle(record.completedAtMs, config.sessionRelay.displayTimeZone),
        markdown: media.documentMarkdown,
      });
      document = await longAnswerDocuments.put({
        threadId: record.threadId,
        turnId: record.turnId,
        url: created.url,
        createdAt: Date.now(),
      });
    }
    const imageSegments = media.segments.filter((segment) => segment?.type === "image");
    return Object.freeze({
      ...media,
      segments: Object.freeze([
        Object.freeze({
          type: "text",
          text: `回答较长，已整理为飞书云文档：[打开完整结果](${document.url})`,
        }),
        ...media.deliveryNotices,
        ...imageSegments,
      ]),
      longAnswerDocument: true,
    });
  } catch (error) {
    log(`long final answer document creation failed; using the normal reply fallback: ${safeError(error)}`);
    return media;
  }
}

async function finishLongAnswerDocumentDelivery(record, media) {
  if (!media?.longAnswerDocument) return;
  await longAnswerDocuments.remove(record.threadId, record.turnId);
}

async function processTurnProgress(record) {
  if (!relaySettings.get(record.threadId).publicProgress) return;
  if (!channelConnected) {
    log("public progress skipped while Feishu channel is disconnected");
    return;
  }
  const binding = resolveRelayBinding(record.chatId, record.threadId);
  if (!binding) {
    log("public progress skipped because its Session binding is unavailable");
    return;
  }
  try {
    const current = await tryEnsureTurnStreamCard(record);
    if (current) {
      const updated = await streamCards.appendProgress(record.threadId, record.turnId, {
        sequence: record.sequence,
        text: record.text,
        createdAtMs: record.createdAtMs,
      });
      try {
        await channel.updateCard(updated.messageId, buildSessionStreamCard({
          progress: updated.progress,
          startedAtMs: updated.createdAt,
          nowMs: Date.now(),
        }));
        log("public Codex progress updated in the original stream card");
        return;
      } catch (error) {
        log(`stream card progress update failed; sending a fallback progress post: ${safeError(error)}`);
      }
    }
    await inspectBinding(binding);
    const deliveryId = `codex-progress:${record.threadId}:${record.turnId}:${record.itemId}`;
    const response = await channel.rawClient.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: record.chatId,
        content: JSON.stringify(buildSessionProgressPost({
          text: record.text,
          sequence: record.sequence,
          createdAtMs: record.createdAtMs,
          timeZone: config.sessionRelay.displayTimeZone,
          maxChars: Math.min(config.maxReplyChars, 4_000),
        })),
        msg_type: "post",
        uuid: deliveryIdempotencyKey(deliveryId),
      },
    });
    if (response?.code !== undefined && response.code !== 0) {
      throw new Error(`Feishu send failed with code ${response.code}`);
    }
    log("public Codex progress delivered to its bound Session group");
  } catch (error) {
    log(`public Codex progress was not delivered: ${safeError(error)}`);
  }
}

async function queueTurnDelivery(record, attachments, successLog) {
  const attachmentRecords = buildNativeAttachmentDeliveries(record, attachments);
  await queueDeliveryBundle([record, ...attachmentRecords], successLog);
}

async function processCompletedTurn(record) {
  const deliveryId = externalTurnDeliveryId(record.threadId, record.turnId);
  if (completed.has(deliveryId)) return;
  if (deliveryOutbox.has(deliveryId)) {
    void retryPendingDeliveries();
    return;
  }
  const temporaryChat = temporaryChats.getByThread(record.threadId);
  const mentionOpenId = temporaryChat?.chatType !== "p2p" && relaySettings.get(record.threadId).finalMention
    ? config.agent.ownerOpenId
    : undefined;
  const sourcePromptEntries = Array.isArray(record.promptEntries) ? record.promptEntries : [];
  if (sourcePromptEntries.length === 0 && record.goal) {
    const media = await prepareFinalAnswerDelivery(record);
    const delivery = {
      kind: "send",
      deliveryId,
      chatId: record.chatId,
      threadId: record.threadId,
      post: buildGoalTurnPost({
        goal: record.goal,
        answerSegments: media.segments,
        completedAtMs: record.completedAtMs,
        durationMs: record.durationMs,
        tokenUsage: record.tokenUsage,
        timeZone: config.sessionRelay.displayTimeZone,
        maxReplyChars: config.maxReplyChars,
        mentionOpenId,
      }),
      createdAt: Date.now(),
    };
    if (await tryCompleteTurnStreamCard(record, delivery, media, mentionOpenId)) {
      await finishLongAnswerDocumentDelivery(record, media);
      return;
    }
    await queueTurnDelivery(delivery, media.attachments, `Goal result delivered for ${deliveryId}`);
    await finishLongAnswerDocumentDelivery(record, media);
    await streamCards.remove(record.threadId, record.turnId);
    return;
  }
  if (sourcePromptEntries.length === 0) {
    await streamCards.remove(record.threadId, record.turnId);
    log(`completed turn ${deliveryId} had no user prompt or Goal; skipped`);
    return;
  }
  const route = resolveCompletedTurnRoute(record, {
    getInput: (messageId) => inputLedger.get(messageId),
    isFeishuClientId: isFeishuMessageClientId,
  });
  const media = await prepareFinalAnswerDelivery(record);
  if (route.kind === "reply" && !route.showPromptTimeline) {
    const delivery = {
      kind: "reply",
      deliveryId,
      messageId: route.messageId,
      chatId: route.chatId,
      threadId: route.threadId,
      post: buildFinalAnswerReplyPost({
        answerSegments: media.segments,
        completedAtMs: record.completedAtMs,
        durationMs: record.durationMs,
        tokenUsage: record.tokenUsage,
        timeZone: config.sessionRelay.displayTimeZone,
        maxReplyChars: config.maxReplyChars,
        mentionOpenId,
      }),
      createdAt: Date.now(),
    };
    if (await tryCompleteTurnStreamCard(record, delivery, media, mentionOpenId)) {
      await finishLongAnswerDocumentDelivery(record, media);
      return;
    }
    await queueTurnDelivery(delivery, media.attachments, `final answer delivered for Feishu turn ${record.turnId}`);
    await finishLongAnswerDocumentDelivery(record, media);
    await streamCards.remove(record.threadId, record.turnId);
    return;
  }
  const promptEntries = [];
  for (const entry of sourcePromptEntries) {
    const resources = Array.isArray(entry.resources) ? entry.resources : [];
    promptEntries.push(Object.freeze({
      text: String(entry.text || ""),
      uploadedImages: Object.freeze(await uploadPromptImages(resources)),
      hasPromptResources: resources.length > 0,
      promptAtMs: entry.promptAtMs,
      source: entry.source,
    }));
  }
  const delivery = {
    kind: route.kind,
    deliveryId,
    messageId: route.messageId,
    chatId: route.chatId,
    threadId: route.threadId,
    post: buildExternalTurnPost({
      promptEntries,
      answerSegments: media.segments,
      promptAtMs: record.promptAtMs,
      completedAtMs: record.completedAtMs,
      durationMs: record.durationMs,
      tokenUsage: record.tokenUsage,
      timeZone: config.sessionRelay.displayTimeZone,
      maxPromptChars: config.sessionRelay.promptPreviewChars,
      maxReplyChars: config.maxReplyChars,
      mentionOpenId,
    }),
    createdAt: Date.now(),
  };
  if (await tryCompleteTurnStreamCard(record, delivery, media, mentionOpenId)) {
    await finishLongAnswerDocumentDelivery(record, media);
    return;
  }
  await queueTurnDelivery(
    delivery,
    media.attachments,
    `${route.kind === "reply" ? "cross-client final reply" : "proactive final answer"} delivered for ${deliveryId}`,
  );
  await finishLongAnswerDocumentDelivery(record, media);
  await streamCards.remove(record.threadId, record.turnId);
}

const channel = createLarkChannel({
  appId: config.appId,
  appSecret,
  transport: "websocket",
  httpTimeoutMs: config.httpTimeoutMs,
  handshakeTimeoutMs: config.handshakeTimeoutMs,
  policy: {
    dmMode: "allowlist",
    dmAllowlist: [config.agent.ownerOpenId],
    groupAllowlist: config.sessionRelay.bindings.length > 0
      ? config.sessionRelay.bindings.map(({ groupChatId }) => groupChatId)
      : ["oc_no_configured_session_groups"],
    requireMention: false,
    respondToMentionAll: false,
    botLoopGuard: {
      enabled: true,
      windowMs: 60_000,
      maxBotMentions: 3,
      scope: "chat+sender",
      onTrip: "reject",
    },
  },
  safety: {
    dedup: { ttl: 3_600_000, maxEntries: 2000 },
    chatQueue: { enabled: false, mergeWhileBusy: false },
    staleMessageWindowMs: 300_000,
  },
  outbound: {
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
  source: "codex-feishu-session-relay",
});

const bindingProvisioner = feedGroupManager && sessionChatManager
  ? new SessionBindingProvisioner({
      catalog: desktopCatalog,
      registry: bindingRegistry,
      chatManager: sessionChatManager,
      feedGroupManager,
      ownerOpenId: config.agent.ownerOpenId,
      verifyGroup: verifyCreatedGroup,
      sendWelcome: sendBindingWelcome,
      settingsStore: relaySettings,
      onWarning: (error) => log(`new group welcome could not be delivered: ${safeError(error)}`),
    })
  : undefined;

async function provisionSession(threadId, options) {
  if (!bindingProvisioner) {
    throw new SessionRelayError(
      "binding_setup_disabled",
      "Automatic group creation requires the Feishu CLI and Feed group integration",
    );
  }
  return bindingProvisioner.provision(threadId, options);
}

const sessionAddFlow = new SessionAddFlow({
  loadCatalog: async () => desktopCatalog.load({ bindings: await bindingRegistry.list() }),
  provision: provisionSession,
  createIndependent: createIndependentSession,
  createProject: createProjectSession,
});

const bindingRemover = new SessionBindingRemover({
  registry: bindingRegistry,
  feedGroupManager,
  getStatus: async (threadId) => sessionController?.getStatus(threadId),
  getPendingQueueCount: async (threadId) => promptQueue.count(threadId),
  onWarning: (error) => log(`binding removal consistency warning: ${safeError(error)}`),
});
const sessionDeleteFlow = new SessionDeleteFlow({
  remove: async (binding) => bindingRemover.remove(binding),
});

const sessionBindingInbox = await new SessionBindingInbox({
  directory: bindingInboxPath,
  handleRequest: async ({ threadId }) => {
    const result = await provisionSession(threadId);
    return { ...result, restart: !result.alreadyBound };
  },
}).open();

let restartScheduled = false;
async function scheduleSelfRestart() {
  if (restartScheduled || stopping) return;
  try {
    const supervisorPid = Number(await fs.readFile(supervisorPidPath, "utf8"));
    if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) throw new Error("invalid supervisor pid");
    process.kill(supervisorPid, 0);
    await fs.writeFile(restartRequestPath, `${Date.now()}\n`, "utf8");
    restartScheduled = true;
    log("scheduled Bridge reload for a Session binding change");
    const timer = setTimeout(() => void requestStop("Session binding change"), 750);
    timer.unref?.();
  } catch (error) {
    restartScheduled = false;
    log(`Bridge kept running because its supervisor is unavailable: ${safeError(error)}`);
  }
}

async function processBindingSetupMessage(msg, content, binding) {
  let restart = false;
  try {
    let sessionTitle;
    if (binding) {
      try { sessionTitle = (await sessionStore.get(binding.threadId))?.title; }
      catch (error) { log(`could not describe binding before management command: ${safeError(error)}`); }
    }
    let result = await sessionDeleteFlow.handle({
      conversationId: msg.chatId,
      text: content,
      binding,
      sessionTitle,
    });
    if (result.handled) {
      sessionAddFlow.cancel(msg.chatId);
    } else {
      result = await sessionAddFlow.handle({
        conversationId: msg.chatId,
        text: content,
      });
      if (result.handled) sessionDeleteFlow.cancel(msg.chatId);
    }
    if (!result.handled) return false;
    restart = Boolean(result.restart);
    await channel.reply(msg, { markdown: result.reply });
    await persistCompleted(msg.messageId);
    log(`Session binding setup message handled in ${msg.chatType}`);
    return true;
  } catch (error) {
    sessionAddFlow.cancel(msg.chatId);
    log(`Session binding setup failed: ${safeError(error)}`);
    try {
      await channel.reply(msg, { markdown: publicBindingFailure(error) });
      await persistCompleted(msg.messageId);
    } catch (replyError) {
      log(`Session binding setup failure reply could not be delivered: ${safeError(replyError)}`);
    }
    return true;
  } finally {
    if (restart) await scheduleSelfRestart();
  }
}

async function pollSessionBindingInbox() {
  if (!channelConnected || restartScheduled) return;
  try {
    const completedRequests = await sessionBindingInbox.poll();
    if (completedRequests.some(({ response }) => response?.ok && response?.result?.restart)) {
      await scheduleSelfRestart();
    }
  } catch (error) {
    log(`Session binding inbox poll failed: ${safeError(error)}`);
  }
}

async function processInboundMessage(msg, baseBinding) {
  try {
    let binding = resolveRelayBinding(msg.chatId);
    if (msg.rawContentType === "text") {
      const rawContent = String(msg.content || "");
      const calendarCommand = parseCalendarSchedulingCommand(rawContent);
      if (calendarCommand) {
        await processCalendarSchedulingCommand(msg, baseBinding, calendarCommand);
        return;
      }
      const temporaryChatCommand = parseTemporaryChatCommand(rawContent);
      if (temporaryChatCommand) {
        await processTemporaryChatCommand(msg, baseBinding, temporaryChatCommand);
        return;
      }
      const directCommand = !binding && msg.chatType === "p2p"
        ? parseSessionCommand(rawContent)
        : undefined;
      if (directCommand?.name === "settings") {
        await processGlobalSettingsMessage(msg, directCommand);
        return;
      }
      if (!binding || !binding.temporary) {
        const setupHandled = await processBindingSetupMessage(msg, rawContent, baseBinding);
        if (setupHandled) return;
        binding = resolveRelayBinding(msg.chatId);
      }
    }
    if (!binding) {
      await channel.reply(msg, {
        markdown: "发送 `/chat` 开始私聊，发送 `/schedule <自然语言需求>` 预约日程，或发送 `/add` 创建并绑定一个 Codex Session 群。",
      });
      await persistCompleted(msg.messageId);
      return;
    }
    const content = assertRelayMessage(msg, binding);
    const hasResources = Array.isArray(msg.resources) && msg.resources.length > 0;
    if (!hasResources && content.length > config.maxInputChars) {
      throw new SessionRelayError("input_too_long", "Message exceeds the configured input limit");
    }
    const command = msg.rawContentType === "text" && !hasResources
      ? parseSessionCommand(content)
      : undefined;
    if (command) await processCommandMessage(msg, binding, command);
    else {
      if (hasResources) {
        await pruneInboundAttachmentCache([msg.messageId])
          .catch((error) => log(`inbound attachment cache cleanup deferred: ${safeError(error)}`));
      }
      const prompt = await prepareFeishuPrompt(msg, channel, inboundAttachmentStore, {
        enabled: config.sessionRelay.inboundAttachments.enabled,
      });
      if (prompt.text.length > config.maxInputChars) {
        throw new SessionRelayError("input_too_long", "Message exceeds the configured input limit");
      }
      await processPreparedPrompt(msg, binding, prompt);
    }
  } catch (error) {
    await replyFailure(msg, error);
  }
}

channel.on("message", async (msg) => {
  const binding = bindingsByChat.get(msg.chatId);
  if (msg.senderIsBot !== false || msg.senderId !== config.agent.ownerOpenId) return;
  if (
    completed.has(msg.messageId) ||
    inputLedger.has(msg.messageId) ||
    promptQueue.has(msg.messageId) ||
    inFlightMessageIds.has(msg.messageId)
  ) return;
  if (deliveryOutbox.has(msg.messageId)) {
    void retryPendingDeliveries();
    return;
  }
  inFlightMessageIds.add(msg.messageId);
  try {
    const activeTemporaryChat = temporaryChats.getActive(msg.chatId);
    await inboundWorkQueue.enqueue(activeTemporaryChat?.threadId || binding?.threadId || `chat:${msg.chatId}`, () => (
      processInboundMessage(msg, binding)
    ));
  } finally {
    inFlightMessageIds.delete(msg.messageId);
  }
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
  void retryPendingDeliveries();
  dispatchAllQueuedPrompts();
});

let stopResolve;
const stopPromise = new Promise((resolve) => { stopResolve = resolve; });
let stopping = false;
async function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping Session Relay (${reason})`);
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
const deliveryRetryTimer = setInterval(() => void retryPendingDeliveries(), config.deliveryRetryMs);
const feedGroupRetryTimer = setInterval(() => void syncConfiguredFeedGroups(), config.deliveryRetryMs);
const bindingInboxTimer = setInterval(() => void pollSessionBindingInbox(), 500);
const promptQueueTimer = setInterval(dispatchAllQueuedPrompts, 1_000);

try {
  await channel.connect();
  channelConnected = true;
  const identity = channel.getBotIdentity();
  if (config.agent.botOpenId && identity.openId !== config.agent.botOpenId) {
    throw new Error("Configured bot open_id does not match the connected Channel identity");
  }
  connectedBotOpenId = identity.openId;

  let readyBindings = 0;
  const boundControllerTargets = [];
  for (const binding of config.sessionRelay.bindings) {
    try {
      const { session } = await inspectBinding(binding);
      readyBindings += 1;
      boundControllerTargets.push({
        threadId: binding.threadId,
        chatId: binding.groupChatId,
        cwd: session.cwd,
      });
    } catch (error) {
      log(`binding blocked during startup: ${safeError(error)}`);
    }
  }
  if (feedGroupManager && boundControllerTargets.length > 0) {
    try {
      const result = await feedGroupManager.ensureChats(boundControllerTargets.map(({ chatId }) => chatId));
      log(`Feed group synchronized: ${result.groupName}; chats=${boundControllerTargets.length}`);
    } catch (error) {
      log(`Feed group synchronization unavailable: ${safeError(error)}`);
    }
  }
  const controllerTargets = [...boundControllerTargets];
  for (const temporaryChat of temporaryChats.list()) {
    if (temporaryChat.chatType === "group" && !bindingsByChat.has(temporaryChat.conversationId)) {
      log("temporary group Chat skipped because its base binding is unavailable");
      continue;
    }
    controllerTargets.push({
      threadId: temporaryChat.threadId,
      chatId: temporaryChat.conversationId,
      cwd: temporaryChat.cwd,
    });
  }
  if (controllerTargets.length > 0) {
    sessionController = createSessionController(controllerTargets);
    await sessionController.start();
    log(`Codex session controller subscribed to ${controllerTargets.length} bound task(s)`);
    await reconcilePendingQueueCards();
    dispatchAllQueuedPrompts();
  }
  await fs.writeFile(readyPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    mode: "session-relay",
    readyAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  log(`READY: Channel SDK connected; mode=session-relay; bindings=${config.sessionRelay.bindings.length}; ready=${readyBindings}`);
  void retryPendingDeliveries();
  void syncConfiguredFeedGroups();
  void pollSessionBindingInbox();
  await stopPromise;
} finally {
  const normalStop = stopping;
  channelConnected = false;
  clearInterval(stopWatcher);
  clearInterval(deliveryRetryTimer);
  clearInterval(feedGroupRetryTimer);
  clearInterval(bindingInboxTimer);
  clearInterval(promptQueueTimer);
  await sessionController?.stop().catch(() => {});
  await channel.disconnect().catch(() => {});
  await fs.rm(readyPath, { force: true });
  await fs.rm(pidPath, { force: true });
  await fs.rm(stopPath, { force: true });
  log("Session Relay stopped");
  if (normalStop) {
    await new Promise((resolve) => process.stdout.write("", resolve));
    process.exit(0);
  }
}
