export function classifyInboundMessage(msg, config, localBotOpenId = config.agent.botOpenId) {
  if (!msg || msg.rawContentType !== "text") return { kind: "ignore", reason: "non_text" };
  const senderIsBot = msg.senderIsBot === true || msg.senderType === "bot";

  if (msg.chatType === "p2p") {
    if (senderIsBot) return { kind: "ignore", reason: "bot_dm" };
    if (!config.agent.allowedHumanOpenIds.includes(msg.senderId)) {
      return { kind: "ignore", reason: "untrusted_human" };
    }
    return { kind: "human", scope: "dm" };
  }

  if (msg.chatType !== "group" && msg.chatType !== "topic") {
    return { kind: "ignore", reason: "unsupported_chat" };
  }
  if (!config.collaboration.enabled) return { kind: "ignore", reason: "collaboration_disabled" };
  if (!config.collaboration.groupChatIds.includes(msg.chatId)) {
    return { kind: "ignore", reason: "untrusted_group" };
  }
  if (msg.mentionAll) return { kind: "ignore", reason: "mention_all" };
  if (!msg.mentionedBot) return { kind: "ignore", reason: "not_mentioned" };

  if (senderIsBot) {
    if (localBotOpenId && msg.senderId === localBotOpenId) {
      return { kind: "ignore", reason: "self_message" };
    }
    const peer = config.collaboration.trustedPeers.find(
      (candidate) => candidate.enabled && candidate.botOpenId === msg.senderId,
    );
    if (!peer) return { kind: "ignore", reason: "untrusted_peer" };
    if (!peer.allowedProjectIds.includes(config.project.id)) {
      return { kind: "ignore", reason: "peer_project_denied", peer };
    }
    return { kind: "peer", scope: "group", peer };
  }

  if (!config.agent.allowedHumanOpenIds.includes(msg.senderId)) {
    return { kind: "ignore", reason: "untrusted_human" };
  }
  return { kind: "human", scope: "group" };
}
