import assert from "node:assert/strict";
import test from "node:test";
import { classifyInboundMessage } from "./team-router.mjs";

const config = {
  agent: {
    botOpenId: "ou_localbot",
    allowedHumanOpenIds: ["ou_owner"],
  },
  collaboration: {
    enabled: true,
    groupChatIds: ["oc_team"],
    trustedPeers: [{ agentId: "alice", botOpenId: "ou_alicebot", enabled: true }],
  },
};

const base = {
  rawContentType: "text",
  senderType: "user",
  senderIsBot: false,
  senderId: "ou_owner",
  messageId: "om_1",
};

test("accepts only configured humans in direct messages", () => {
  assert.equal(classifyInboundMessage({ ...base, chatType: "p2p" }, config).kind, "human");
  assert.equal(classifyInboundMessage({ ...base, chatType: "p2p", senderId: "ou_other" }, config).reason, "untrusted_human");
});

test("requires a real mention in a configured collaboration group", () => {
  assert.equal(classifyInboundMessage({
    ...base,
    chatType: "group",
    chatId: "oc_team",
    mentionedBot: true,
  }, config).kind, "human");
  assert.equal(classifyInboundMessage({
    ...base,
    chatType: "group",
    chatId: "oc_team",
    mentionedBot: false,
  }, config).reason, "not_mentioned");
  assert.equal(classifyInboundMessage({
    ...base,
    chatType: "group",
    chatId: "oc_other",
    mentionedBot: true,
  }, config).reason, "untrusted_group");
});

test("accepts configured peer bots and rejects self or unknown bots", () => {
  const peerMessage = {
    ...base,
    chatType: "group",
    chatId: "oc_team",
    mentionedBot: true,
    senderType: "bot",
    senderIsBot: true,
    senderId: "ou_alicebot",
  };
  assert.equal(classifyInboundMessage(peerMessage, config).kind, "peer");
  assert.equal(classifyInboundMessage({ ...peerMessage, senderId: "ou_localbot" }, config).reason, "self_message");
  assert.equal(classifyInboundMessage({ ...peerMessage, senderId: "ou_unknown" }, config).reason, "untrusted_peer");
});
