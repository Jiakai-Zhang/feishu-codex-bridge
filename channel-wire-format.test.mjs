import assert from "node:assert/strict";
import test from "node:test";
import { normalize } from "@larksuite/channel";
import { createAgentEvent, decodeAgentEvent, encodeAgentEvent } from "./agent-protocol.mjs";
import { classifyInboundMessage } from "./team-router.mjs";

test("Channel SDK strips the Bot mention and preserves an exact text Agent wire", async () => {
  const now = Date.now();
  const event = createAgentEvent({
    kind: "task.request",
    groupChatId: "oc_team",
    githubRepository: "example/shared-repository",
    fromAgentId: "alice-codex",
    toAgentId: "local-codex",
    requesterAgentId: "alice-codex",
    executorAgentId: "local-codex",
    payload: {
      title: "Check wire",
      prompt: "Verify the exact Bot-to-Bot wire.",
      receiveMode: "recommend",
      resultMode: "notify",
      git: { remote: "origin", branch: "task/wire", commit: "a".repeat(40) },
    },
  }, { now, ttlMs: 60_000 });
  const wire = encodeAgentEvent(event);
  const normalized = await normalize({
    sender: {
      sender_id: { open_id: "ou_alice_bot" },
      sender_type: "bot",
    },
    message: {
      message_id: "om_wire_test",
      chat_id: "oc_team",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: `@_user_1 ${wire}` }),
      mentions: [{
        key: "@_user_1",
        id: { open_id: "ou_local_bot" },
        name: "Local Bot",
      }],
      create_time: String(now),
    },
  }, {
    botIdentity: { openId: "ou_local_bot" },
  });
  assert.equal(normalized.content, wire);
  assert.equal(normalized.rawContentType, "text");
  assert.equal(normalized.mentionedBot, true);
  assert.equal(normalized.senderIsBot, true);

  const config = {
    agent: { id: "local-codex", botOpenId: "ou_local_bot", ownerOpenId: "ou_owner", allowedHumanOpenIds: ["ou_owner"] },
    collaboration: {
      enabled: true,
      groupChatId: "oc_team",
      groupHumanMessageMode: "owner",
      trustedPeers: [{ agentId: "alice-codex", botOpenId: "ou_alice_bot", enabled: true }],
    },
  };
  const route = classifyInboundMessage(normalized, config, "ou_local_bot");
  assert.equal(route.kind, "peer");
  assert.equal(route.peer.agentId, "alice-codex");
  assert.equal(decodeAgentEvent(normalized.content).eventId, event.eventId);
});
