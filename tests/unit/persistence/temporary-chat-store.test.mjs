import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TemporaryChatStore } from "../../../src/persistence/temporary-chat-store.mjs";

test("persists active and ended temporary Chats per Feishu conversation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "temporary-chat-store-"));
  const filePath = path.join(directory, "temporary-chats.json");
  const store = await TemporaryChatStore.open(filePath);

  await store.start({
    conversationId: "conversation-a",
    threadId: "thread-chat-a",
    cwd: "C:\\workspace",
    chatType: "p2p",
    createdAt: 100,
  });
  assert.equal(store.getActive("conversation-a").threadId, "thread-chat-a");
  assert.equal(store.hasPrivateConversation("conversation-a"), true);
  await assert.rejects(() => store.start({
    conversationId: "conversation-a",
    threadId: "thread-chat-b",
    cwd: "C:\\workspace",
  }), /already has an active/);

  await store.end("conversation-a", 200);
  assert.equal(store.getActive("conversation-a"), undefined);
  assert.equal(store.getByThread("thread-chat-a").status, "ended");

  const reopened = await TemporaryChatStore.open(filePath);
  assert.equal(reopened.hasConversation("conversation-a"), true);
  assert.equal(reopened.getByThread("thread-chat-a").endedAt, 200);
  assert.equal(await reopened.remove("thread-chat-a"), true);
  assert.equal(reopened.hasConversation("conversation-a"), false);
});
