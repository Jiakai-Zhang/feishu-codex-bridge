import assert from "node:assert/strict";
import test from "node:test";
import { SessionDeleteFlow } from "./session-delete-flow.mjs";

const binding = Object.freeze({
  groupChatId: "oc_session",
  threadId: "019ff5b8-decb-7ca3-802c-f115f2f196de",
});

test("requires a scoped confirmation before unbinding the current group", async () => {
  const removed = [];
  let now = 1_000;
  const flow = new SessionDeleteFlow({
    remove: async (value) => { removed.push(value); return { binding: value }; },
    now: () => now,
  });

  const preview = await flow.handle({
    conversationId: "oc_session",
    text: "/delete",
    binding,
    sessionTitle: "Project/task `one`",
  });
  assert.equal(preview.handled, true);
  assert.match(preview.reply, /不会删除飞书群/);
  assert.match(preview.reply, /queue clear/);
  assert.match(preview.reply, /Project\/task 'one'/);
  assert.equal(removed.length, 0);

  const result = await flow.handle({
    conversationId: "oc_session",
    text: "/delete@relay confirm",
    binding,
  });
  assert.equal(result.restart, true);
  assert.equal(removed.length, 1);
  assert.match(result.reply, /绑定已解除/);
});

test("does not unbind from a Bot DM or after confirmation expires", async () => {
  let now = 5_000;
  const flow = new SessionDeleteFlow({
    remove: async () => { throw new Error("must not run"); },
    now: () => now,
    ttlMs: 100,
  });

  const dm = await flow.handle({ conversationId: "oc_dm", text: "/delete" });
  assert.match(dm.reply, /只能在要解除绑定的 Session 群中使用/);

  await flow.handle({ conversationId: "oc_session", text: "/delete", binding });
  now += 101;
  const expired = await flow.handle({
    conversationId: "oc_session",
    text: "/delete confirm",
    binding,
  });
  assert.match(expired.reply, /确认已失效/);
});

test("leaves unrelated text and other slash commands for normal relay routing", async () => {
  const flow = new SessionDeleteFlow({ remove: async () => {} });
  assert.deepEqual(
    await flow.handle({ conversationId: "oc_session", text: "/status", binding }),
    { handled: false },
  );
  assert.deepEqual(
    await flow.handle({ conversationId: "oc_session", text: "delete this code", binding }),
    { handled: false },
  );
});
