import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLarkChannel } from "@larksuite/channel";
import { setCodexThreadName, startCodexProjectThread } from "./codex-app-server.mjs";
import { extractCodexAnswerMedia } from "./codex-answer-media.mjs";
import { CodexDesktopCatalog } from "./codex-desktop-catalog.mjs";
import { CodexSessionController, isFeishuMessageClientId } from "./codex-session-controller.mjs";
import { CodexSessionStore } from "./codex-session-store.mjs";
import {
  buildExternalTurnPost,
  buildFinalAnswerReplyPost,
  buildGoalTurnPost,
  externalTurnDeliveryId,
} from "./codex-session-observer.mjs";
import { DeliveryOutbox, deliveryIdempotencyKey } from "./delivery-outbox.mjs";
import { FeishuFeedGroupManager } from "./feishu-feed-group.mjs";
import { FeishuSessionChatManager } from "./feishu-session-chat.mjs";
import { SessionAddFlow } from "./session-add-flow.mjs";
import { SessionBindingInbox } from "./session-binding-inbox.mjs";
import { SessionBindingProvisioner } from "./session-binding-provisioner.mjs";
import { SessionBindingRemover } from "./session-binding-remover.mjs";
import { SessionBindingRegistry } from "./session-binding-registry.mjs";
import { SessionDeleteFlow } from "./session-delete-flow.mjs";
import { SessionInputLedger } from "./session-input-ledger.mjs";
import {
  executeSessionCommand,
  parseQueueAction,
  parseSessionCommand,
  publicCommandFailure,
} from "./session-relay-commands.mjs";
import {
  assertRelayMessage,
  assertSoloGroup,
  planSessionNameSync,
  resolveCompletedTurnRoute,
  SessionRelayError,
} from "./session-relay-core.mjs";
import { SessionPromptQueue } from "./session-prompt-queue.mjs";
import { loadSessionRelayConfig } from "./session-relay-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(scriptDir, "bridge.config.json");
const config = await loadSessionRelayConfig(configPath);
const userProfile = process.env.USERPROFILE;
if (!userProfile) throw new Error("USERPROFILE is required to locate Codex state");

const runtimeDir = path.join(config.workspace, "work", "feishu-codex-bridge");
const pidPath = path.join(runtimeDir, "bridge.pid");
const stopPath = path.join(runtimeDir, "stop.request");
const completedPath = path.join(runtimeDir, "session-relay-completed.json");
const deliveryOutboxPath = path.join(runtimeDir, "session-relay-pending-deliveries.json");
const inputLedgerPath = path.join(runtimeDir, "session-relay-input-ledger.json");
const promptQueuePath = path.join(runtimeDir, "session-relay-prompt-queue.json");
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
const maxFinalAnswerImages = 10;

const appSecret = process.env.LARK_APP_SECRET;
delete process.env.LARK_APP_SECRET;
if (!appSecret) throw new Error("LARK_APP_SECRET was not supplied by the secure launcher");

await fs.mkdir(runtimeDir, { recursive: true });
await fs.rm(stopPath, { force: true });
await fs.writeFile(pidPath, String(process.pid), "utf8");
let sessionController;
const deliveryOutbox = await DeliveryOutbox.open(deliveryOutboxPath);
const inputLedger = await SessionInputLedger.open(inputLedgerPath);
const promptQueue = await SessionPromptQueue.open(promptQueuePath, {
  getController: () => sessionController,
  onAccepted: async (queued, result) => inputLedger.put({
    messageId: queued.messageId,
    chatId: queued.chatId,
    threadId: queued.feishuThreadId,
    kind: `queued:${result?.kind || "accepted"}`,
    createdAt: queued.createdAt,
  }),
  onError: (error, queued) => log(
    `queued prompt dispatch deferred for ${queued?.messageId || "unknown"}: ${safeError(error)}`,
  ),
});
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
      cwd: scriptDir,
    })
  : undefined;
const sessionChatManager = config.larkCliEntry
  ? new FeishuSessionChatManager({
      nodeExecutable: config.nodeExecutable,
      larkCliEntry: config.larkCliEntry,
      ownerOpenId: config.agent.ownerOpenId,
      cwd: scriptDir,
    })
  : undefined;

let completed = new Set();
try {
  const saved = JSON.parse(await fs.readFile(completedPath, "utf8"));
  completed = new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
let completedWriteTail = Promise.resolve();
let connectedBotOpenId = config.agent.botOpenId;
let channelConnected = false;
let deliveryRetryInFlight = false;
const inFlightMessageIds = new Set();

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function safeError(error) {
  if (error && typeof error === "object" && "code" in error) return `code=${String(error.code).slice(0, 80)}`;
  return error instanceof Error ? error.name : "unknown";
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

async function persistCompleted(messageId) {
  completed.add(messageId);
  if (completed.size > 10_000) completed = new Set([...completed].slice(-8_000));
  const snapshot = JSON.stringify([...completed], null, 2);
  completedWriteTail = completedWriteTail.then(
    () => fs.writeFile(completedPath, snapshot, "utf8"),
    () => fs.writeFile(completedPath, snapshot, "utf8"),
  );
  await completedWriteTail;
}

async function deliverPendingRecord(record) {
  if (record.kind === "send") {
    const binding = bindingsByChat.get(record.chatId);
    if (!binding) throw new Error("Proactive delivery has no configured group binding");
    await inspectBinding(binding);
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
  const binding = bindingsByChat.get(record.chatId);
  if (!binding) throw new Error("Reply delivery has no configured group binding");
  if (!record.publicStatus) await inspectBinding(binding);
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
      try {
        await deliverPendingRecord(record);
        await persistCompleted(record.deliveryId);
        await deliveryOutbox.remove(record.deliveryId);
        log(`deferred ${record.kind === "send" ? "proactive final answer" : "final reply"} delivered for ${record.deliveryId}`);
      } catch (error) {
        await deliveryOutbox.markFailure(record.deliveryId, error);
        log(`deferred delivery failed for ${record.deliveryId}: ${safeError(error)}`);
      }
    }
  } finally {
    deliveryRetryInFlight = false;
  }
}

async function inspectBinding(binding, { syncName = true } = {}) {
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

async function sendBindingWelcome({ chatId, groupName, feedGroupName }) {
  await channel.send(chatId, {
    markdown: [
      "### Codex Session 已绑定",
      "",
      `- 群名：${groupName}`,
      `- 标签：${feedGroupName}`,
      "- 本群固定对应一个 Codex 任务",
      "",
      "Bridge 重载后，可直接发送 Prompt，无需 @Bot。",
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
    case "created_group_verification_failed":
      return "新群没有通过“仅你 + 当前 Bot”的成员校验，因此没有写入绑定。";
    case "binding_persist_failed":
      return "新群和标签已创建，但本机绑定配置写入失败。Bridge 没有把该群当作可用 Session 群，请在本机检查配置。";
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
    case "session_busy":
      return "绑定的 Codex 任务在等待时限内没有恢复空闲。请等待当前回答完成或中断后重试。";
    case "codex_app_server_unavailable":
      return "本机共享 Codex 服务当前未连接。请先重新启动 Bridge，再重试本消息。";
    case "unsupported_message":
      return "当前 Session Relay 只接收文本消息。";
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

async function queueDelivery(record, successLog) {
  if (completed.has(record.deliveryId)) return;
  await deliveryOutbox.put(record);
  if (!channelConnected) return;
  try {
    const pending = deliveryOutbox.list().find((item) => item.deliveryId === record.deliveryId);
    if (!pending) return;
    await deliverPendingRecord(pending);
    await persistCompleted(record.deliveryId);
    await deliveryOutbox.remove(record.deliveryId);
    if (successLog) log(successLog);
  } catch (error) {
    await deliveryOutbox.markFailure(record.deliveryId, error);
    log(`delivery deferred for ${record.deliveryId}: ${safeError(error)}`);
  }
}

async function processPromptMessage(msg, binding, content) {
  const startedAt = Date.now();
  log(`accepted relay message ${msg.messageId}`);
  try {
    const result = await sessionController.submitPrompt({
      threadId: binding.threadId,
      text: content,
      clientUserMessageId: msg.messageId,
    });
    await inputLedger.put({
      messageId: msg.messageId,
      chatId: msg.chatId,
      threadId: msg.threadId,
      kind: result.kind,
      createdAt: Date.now(),
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
  } catch (error) {
    log(`relay message ${msg.messageId} failed: ${safeError(error)}`);
    await replyFailure(msg, error);
  }
}

async function processCommandMessage(msg, binding, command) {
  log(`accepted session command /${command.name} from ${msg.messageId}`);
  try {
    await inspectBinding(binding);
    let markdown;
    let queueAction;
    try {
      queueAction = command.name === "queue" ? parseQueueAction(command.args) : undefined;
      markdown = await executeSessionCommand(command, {
        controller: sessionController,
        threadId: binding.threadId,
        promptQueue,
        enqueuePrompt: async (text) => promptQueue.enqueue({
          messageId: msg.messageId,
          sessionThreadId: binding.threadId,
          chatId: msg.chatId,
          feishuThreadId: msg.threadId,
          text,
          createdAt: Date.now(),
        }, {
          afterPersist: async (queued) => inputLedger.put({
            messageId: queued.messageId,
            chatId: queued.chatId,
            threadId: queued.feishuThreadId,
            kind: "queued",
            createdAt: queued.createdAt,
          }),
        }),
      });
    } catch (error) {
      markdown = publicCommandFailure(error);
      log(`session command /${command.name} failed: ${safeError(error)}`);
    }
    if (!inputLedger.has(msg.messageId)) {
      await inputLedger.put({
        messageId: msg.messageId,
        chatId: msg.chatId,
        threadId: msg.threadId,
        kind: `command:${command.name}`,
        createdAt: Date.now(),
      });
    }
    await queueDelivery({
      kind: "reply",
      deliveryId: `command:${msg.messageId}`,
      messageId: msg.messageId,
      chatId: msg.chatId,
      threadId: msg.threadId,
      markdown,
      publicStatus: queueAction?.action === "enqueue",
      createdAt: Date.now(),
    }, `session command /${command.name} replied for ${msg.messageId}`);
    if (queueAction?.action === "enqueue") dispatchQueuedPrompts(binding.threadId);
  } catch (error) {
    log(`session command /${command.name} could not be processed: ${safeError(error)}`);
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
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 10 * 1024 * 1024) {
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

async function uploadFinalAnswerSegments(answer) {
  const extracted = extractCodexAnswerMedia(answer, { maxImages: maxFinalAnswerImages });
  const uploadedByPath = new Map();
  const segments = [];

  for (const segment of extracted.segments) {
    if (segment.type === "text") {
      segments.push(Object.freeze({ type: "text", text: segment.text }));
      continue;
    }

    let imageKey = uploadedByPath.get(segment.path);
    try {
      if (!imageKey) {
        if (!path.isAbsolute(segment.path) || !supportedPromptImageExtensions.has(path.extname(segment.path).toLowerCase())) {
          throw new Error("unsupported final answer image path");
        }
        const stat = await fs.lstat(segment.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 10 * 1024 * 1024) {
          throw new Error("final answer image does not satisfy Feishu upload limits");
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
      segments.push(Object.freeze({
        type: "text",
        text: "（图片未能上传到飞书；可在绑定的 Codex 任务中查看。）",
      }));
      log(`final answer image could not be embedded: ${safeError(error)}`);
    }
  }

  if (extracted.strippedDirectiveCount > 0) {
    log(`stripped ${extracted.strippedDirectiveCount} Codex Desktop visualize directive(s) from final answer`);
  }
  if (extracted.strippedMetadataBlockCount > 0) {
    log(`stripped ${extracted.strippedMetadataBlockCount} renderer metadata block(s) from final answer`);
  }
  return Object.freeze(segments);
}

async function processCompletedTurn(record) {
  const deliveryId = externalTurnDeliveryId(record.threadId, record.turnId);
  if (completed.has(deliveryId)) return;
  if (deliveryOutbox.has(deliveryId)) {
    void retryPendingDeliveries();
    return;
  }
  const sourcePromptEntries = Array.isArray(record.promptEntries) ? record.promptEntries : [];
  if (sourcePromptEntries.length === 0 && record.goal) {
    const answerSegments = await uploadFinalAnswerSegments(record.answer);
    await queueDelivery({
      kind: "send",
      deliveryId,
      chatId: record.chatId,
      threadId: record.threadId,
      post: buildGoalTurnPost({
        goal: record.goal,
        answerSegments,
        completedAtMs: record.completedAtMs,
        durationMs: record.durationMs,
        tokenUsage: record.tokenUsage,
        timeZone: config.sessionRelay.displayTimeZone,
        maxReplyChars: config.maxReplyChars,
      }),
      createdAt: Date.now(),
    }, `Goal result delivered for ${deliveryId}`);
    return;
  }
  if (sourcePromptEntries.length === 0) {
    log(`completed turn ${deliveryId} had no user prompt or Goal; skipped`);
    return;
  }
  const route = resolveCompletedTurnRoute(record, {
    getInput: (messageId) => inputLedger.get(messageId),
    isFeishuClientId: isFeishuMessageClientId,
  });
  const answerSegments = await uploadFinalAnswerSegments(record.answer);
  if (route.kind === "reply" && !route.showPromptTimeline) {
    await queueDelivery({
      kind: "reply",
      deliveryId,
      messageId: route.messageId,
      chatId: route.chatId,
      threadId: route.threadId,
      post: buildFinalAnswerReplyPost({
        answerSegments,
        completedAtMs: record.completedAtMs,
        durationMs: record.durationMs,
        tokenUsage: record.tokenUsage,
        timeZone: config.sessionRelay.displayTimeZone,
        maxReplyChars: config.maxReplyChars,
      }),
      createdAt: Date.now(),
    }, `final answer delivered for Feishu turn ${record.turnId}`);
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
  await queueDelivery({
    kind: route.kind,
    deliveryId,
    messageId: route.messageId,
    chatId: route.chatId,
    threadId: route.threadId,
    post: buildExternalTurnPost({
      promptEntries,
      answerSegments,
      promptAtMs: record.promptAtMs,
      completedAtMs: record.completedAtMs,
      durationMs: record.durationMs,
      tokenUsage: record.tokenUsage,
      timeZone: config.sessionRelay.displayTimeZone,
      maxPromptChars: config.sessionRelay.promptPreviewChars,
      maxReplyChars: config.maxReplyChars,
    }),
    createdAt: Date.now(),
  }, `${route.kind === "reply" ? "cross-client final reply" : "proactive final answer"} delivered for ${deliveryId}`);
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
    if (msg.rawContentType === "text") {
      const setupHandled = await processBindingSetupMessage(msg, String(msg.content || ""), binding);
      if (setupHandled) return;
    }
    if (!binding) {
      await channel.reply(msg, { markdown: "发送 `/add` 创建并绑定一个 Codex Session 群。" });
      await persistCompleted(msg.messageId);
      return;
    }
    const content = assertRelayMessage(msg, binding);
    if (content.length > config.maxInputChars) {
      throw new SessionRelayError("input_too_long", "Message exceeds the configured input limit");
    }
    const command = parseSessionCommand(content);
    if (command) await processCommandMessage(msg, binding, command);
    else await processPromptMessage(msg, binding, content);
  } catch (error) {
    await replyFailure(msg, error);
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
  const controllerTargets = [];
  for (const binding of config.sessionRelay.bindings) {
    try {
      const { session } = await inspectBinding(binding);
      readyBindings += 1;
      controllerTargets.push({
        threadId: binding.threadId,
        chatId: binding.groupChatId,
        cwd: session.cwd,
      });
    } catch (error) {
      log(`binding blocked during startup: ${safeError(error)}`);
    }
  }
  if (feedGroupManager && controllerTargets.length > 0) {
    try {
      const result = await feedGroupManager.ensureChats(controllerTargets.map(({ chatId }) => chatId));
      log(`Feed group synchronized: ${result.groupName}; chats=${controllerTargets.length}`);
    } catch (error) {
      log(`Feed group synchronization unavailable: ${safeError(error)}`);
    }
  }
  if (controllerTargets.length > 0) {
    sessionController = new CodexSessionController({
      appServerUrl: config.sessionRelay.appServerUrl,
      targets: controllerTargets,
      sandboxMode: config.sandboxMode,
      onTurnCompleted: async (record) => {
        dispatchQueuedPrompts(record.threadId);
        await processCompletedTurn(record);
      },
      log,
    });
    await sessionController.start();
    log(`Codex session controller subscribed to ${controllerTargets.length} bound task(s)`);
    dispatchAllQueuedPrompts();
  }
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
  await fs.rm(pidPath, { force: true });
  await fs.rm(stopPath, { force: true });
  log("Session Relay stopped");
  if (normalStop) {
    await new Promise((resolve) => process.stdout.write("", resolve));
    process.exit(0);
  }
}
