import { classifyInboundMessage } from "../protocol/team-router.mjs";

export function registerInboundHandlers({
  channel,
  config,
  getConnectedBotOpenId,
  isCompleted,
  immediateCommands,
  commandName,
  processPeerControlMessage,
  safeError,
  safeErrorCode,
  audit,
  log,
  handleCommand,
  getActiveThreadId,
  resolveMessageThreadId,
  enqueueThreadWork,
  processQueuedMessage,
  setChannelConnected,
  retryPendingAgentEvents,
  scanCollaborationInbox,
}) {
  channel.on("message", async (msg) => {
    const route = classifyInboundMessage(msg, config, getConnectedBotOpenId());
    if (isCompleted(msg.messageId)) return;
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
      await handleCommand(msg, content, getActiveThreadId());
      return;
    }
    const targetThreadId = await resolveMessageThreadId();
    await enqueueThreadWork(targetThreadId, () => processQueuedMessage(msg, content, targetThreadId));
  });

  channel.on("reject", (event) => log(`rejected message ${event.messageId}: ${event.reason}`));
  channel.on("error", (error) => log(`channel error: ${safeError(error)}`));
  channel.on("reconnecting", () => {
    setChannelConnected(false);
    log("Channel SDK reconnecting");
  });
  channel.on("reconnected", () => {
    setChannelConnected(true);
    log("Channel SDK reconnected");
    void retryPendingAgentEvents();
    void scanCollaborationInbox();
  });
}
