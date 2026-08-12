import assert from "node:assert/strict";
import test from "node:test";
import { classifyInboundMessage } from "./team-router.mjs";

const config = {
  agent: {
    ownerOpenId: "ou_owner",
    botOpenId: "ou_localbot",
    allowedHumanOpenIds: ["ou_owner"],
  },
  project: { id: "local-project" },
  collaboration: {
    enabled: true,
    groupChatId: "oc_team",
    groupHumanMessageMode: "owner",
    trustedPeers: [{
      agentId: "alice",
      botOpenId: "ou_alicebot",
      humanOpenId: "ou_alice",
      enabled: true,
    }],
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

test("delivers the owner's ordinary group dialogue to their Agent", () => {
  const route = classifyInboundMessage({
    ...base,
    chatType: "group",
    chatId: "oc_team",
    mentionedBot: false,
  }, config);
  assert.equal(route.kind, "human");
  assert.equal(route.addressedBy, "owner-message");
});

test("mention mode requires a real Bot mention", () => {
  const mentionConfig = {
    ...config,
    collaboration: { ...config.collaboration, groupHumanMessageMode: "mention" },
  };
  assert.equal(classifyInboundMessage({
    ...base,
    chatType: "group",
    chatId: "oc_team",
    mentionedBot: true,
  }, mentionConfig).kind, "human");
  assert.equal(classifyInboundMessage({
    ...base,
    chatType: "group",
    chatId: "oc_team",
    mentionedBot: false,
  }, mentionConfig).reason, "not_mentioned");
});

test("rejects another group or untrusted human", () => {
  assert.equal(classifyInboundMessage({
    ...base,
    chatType: "group",
    chatId: "oc_other",
    mentionedBot: true,
  }, config).reason, "untrusted_group");
  assert.equal(classifyInboundMessage({
    ...base,
    chatType: "group",
    chatId: "oc_team",
    senderId: "ou_other",
    mentionedBot: true,
  }, config).reason, "untrusted_human");
});

test("peer bots must be trusted and explicitly mention the local Bot", () => {
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
  assert.equal(classifyInboundMessage({ ...peerMessage, mentionedBot: false }, config).reason, "not_mentioned");
  assert.equal(classifyInboundMessage({ ...peerMessage, senderId: "ou_localbot" }, config).reason, "self_message");
  assert.equal(classifyInboundMessage({ ...peerMessage, senderId: "ou_unknown" }, config).reason, "untrusted_peer");
});
