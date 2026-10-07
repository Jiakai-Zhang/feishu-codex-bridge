import assert from "node:assert/strict";
import test from "node:test";
import { fetchFeishuQuotedMessage } from "../../../src/feishu/feishu-quoted-message.mjs";
import { isSessionPromptAddressed } from "../../../src/relay/session-relay-core.mjs";

const message = { messageId: "om_request", replyToMessageId: "om_quote", chatId: "oc_test", chatType: "group" };

function channelFor(parent) {
  const requests = [];
  return {
    requests,
    botIdentity: { openId: "ou_test_bot", name: "Test Bot" },
    rawClient: { im: { v1: { message: { get: async (request) => {
      requests.push(request);
      return { code: 0, data: { items: parent ? [parent] : [] } };
    } } } } },
  };
}

function parentMessage(overrides = {}) {
  return {
    message_id: "om_quote", chat_id: "oc_test", msg_type: "image",
    sender: { id: "ou_test_member", sender_type: "user" },
    body: { content: JSON.stringify({ image_key: "img_test_quote" }) },
    ...overrides,
  };
}

test("does not read history when no message is quoted", async () => {
  const channel = channelFor(parentMessage());
  assert.equal(await fetchFeishuQuotedMessage({ ...message, replyToMessageId: undefined }, channel), undefined);
  assert.equal(channel.requests.length, 0);
});

test("normalizes the directly quoted image and retains its source conversation", async () => {
  const channel = channelFor(parentMessage({ parent_id: "om_older", root_id: "om_root" }));
  const quote = await fetchFeishuQuotedMessage(message, channel);
  assert.equal(quote.chatId, message.chatId);
  assert.equal(quote.messageId, message.replyToMessageId);
  assert.equal(quote.senderIsBot, false);
  assert.deepEqual(quote.resources, [{ type: "image", fileKey: "img_test_quote" }]);
  assert.equal(channel.requests.length, 1);
  assert.equal(quote.replyToMessageId, undefined);
  // Quoting another member is not itself an @Bot in a multi-person group.
  assert.equal(isSessionPromptAddressed(message, { humanMemberCount: 2, replyToBot: quote.senderIsBot }), false);
  assert.equal(isSessionPromptAddressed({ ...message, mentionedBot: true }, { humanMemberCount: 2 }), true);
});

test("retains bot identity for reply-to-bot wakeups", async () => {
  const quote = await fetchFeishuQuotedMessage(message, channelFor(parentMessage({
    msg_type: "text", sender: { id: "ou_test_bot", sender_type: "app" },
    body: { content: JSON.stringify({ text: "previous answer" }) },
  })));
  assert.equal(quote.senderIsBot, true);
  assert.equal(quote.content, "previous answer");
  assert.equal(isSessionPromptAddressed(message, { humanMemberCount: 2, replyToBot: quote.senderIsBot }), true);
});

test("does not expand quoted stickers, cards or merged-forward history", async () => {
  for (const msg_type of ["sticker", "interactive", "merge_forward"]) {
    const channel = channelFor(parentMessage({ msg_type }));
    const quote = await fetchFeishuQuotedMessage(message, channel);
    assert.equal(quote.content, "");
    assert.deepEqual(quote.resources, []);
    assert.equal(channel.requests.length, 1);
  }
});

test("fails closed on unavailable, deleted, wrong-message and cross-chat quotes", async () => {
  for (const parent of [undefined, parentMessage({ deleted: true }), parentMessage({ message_id: "om_other" }),
    parentMessage({ chat_id: "oc_other" }), parentMessage({ chat_id: undefined })]) {
    await assert.rejects(fetchFeishuQuotedMessage(message, channelFor(parent)), { code: "quoted_message_unavailable" });
  }
});

test("does not leak raw API error details in its public error message", async () => {
  const channel = channelFor(undefined);
  channel.rawClient.im.v1.message.get = async () => { throw new Error("private-test-credential"); };
  await assert.rejects(fetchFeishuQuotedMessage(message, channel), (error) => (
    error.code === "quoted_message_unavailable" && !error.message.includes("private-test-credential")
  ));
});
