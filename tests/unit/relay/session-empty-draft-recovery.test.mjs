import assert from "node:assert/strict";
import test from "node:test";
import { planEmptyDraftRecovery, commitEmptyDraftRecovery } from "../../../src/relay/session-empty-draft-recovery.mjs";
function fixture() {
  return {
    fromThreadId: "empty-draft", toThreadId: "durable-task",
    config: { privateConfig: "preserve", sessionRelay: { bindings: [
      { groupChatId: "group-one", threadId: "empty-draft", ownerOpenId: "owner-one" },
      { groupChatId: "group-other", threadId: "other", ownerOpenId: "owner-other" },
    ] } },
    queue: [
      { sessionThreadId: "empty-draft", messageId: "message-one", chatId: "group-one", text: "original prompt", createdAt: 123, attachments: [{ localPath: "/example/file" }] },
      { sessionThreadId: "other", messageId: "message-other", text: "other prompt" },
    ],
    settings: { version: 4, defaults: { inputMode: "queue" }, sessions: [
      { threadId: "empty-draft", sandboxMode: "danger-full-access", inputMode: "queue" }, { threadId: "other" },
    ] },
    cards: [{ threadId: "empty-draft", turnId: "queued:message-one", sourceMessageId: "message-one", messageId: "existing-card", chatId: "group-one" }],
    ledger: [{ messageId: "message-one", kind: "queued", chatId: "group-one" }],
  };
}
test("preserves group, owner, prompt order, attachments, permissions, card and message identities", () => {
  const input = fixture(); const original = structuredClone(input); const next = planEmptyDraftRecovery(input);
  assert.deepEqual(input, original);
  assert.deepEqual(next.config.sessionRelay.bindings[0], { ...input.config.sessionRelay.bindings[0], threadId: "durable-task" });
  assert.deepEqual(next.queue[0], { ...input.queue[0], sessionThreadId: "durable-task" });
  assert.deepEqual(next.settings.sessions[0], { ...input.settings.sessions[0], threadId: "durable-task" });
  assert.deepEqual(next.cards[0], { ...input.cards[0], threadId: "durable-task" });
  assert.deepEqual(next.ledger, input.ledger); assert.deepEqual(next.queue[1], input.queue[1]);
  assert.deepEqual(next.config.sessionRelay.bindings[1], input.config.sessionRelay.bindings[1]);
});
test("supports legacy settings arrays without changing their format", () => {
  const input = fixture(); input.settings = input.settings.sessions;
  assert.equal(planEmptyDraftRecovery(input).settings[0].threadId, "durable-task");
});
test("refuses previously accepted input and non-queued execution cards", () => {
  for (const ledger of [
    [{ sessionThreadId: "empty-draft", kind: "queued:started", turnId: "turn-one" }],
    [{ sessionThreadId: "empty-draft", kind: "prompt" }],
  ]) { const input = fixture(); input.ledger = ledger; assert.throws(() => planEmptyDraftRecovery(input), /previously accepted/); }
  const input = fixture(); input.cards[0].turnId = "turn-one";
  assert.throws(() => planEmptyDraftRecovery(input), /execution cards/);
});
test("refuses conflicting bindings, groups, replacement state or unsupported schemas", () => {
  for (const mutate of [
    x => { x.config.sessionRelay.bindings[0].threadId = "changed"; },
    x => { x.config.sessionRelay.bindings[1].threadId = x.toThreadId; },
    x => { x.queue[0].chatId = "different-group"; },
    x => { x.settings.sessions.push({ threadId: x.toThreadId }); },
    x => { x.cards[0].sourceMessageId = "unrelated"; },
    x => { x.queue = {}; }, x => { x.settings = {}; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => planEmptyDraftRecovery(input)); }
});
test("backs up originals before writes and commits the binding last", async () => {
  const calls = []; const entries = [{ filePath: "queue", before: "old queue", after: "new queue" }, { filePath: "binding", before: "old binding", after: "new binding" }];
  await commitEmptyDraftRecovery({ entries, backupPath: "backup", writeSnapshot: async (file, text) => calls.push([file, text]) });
  assert.deepEqual(calls.map(x => x[0]), ["backup", "queue", "binding", "backup"]);
  assert.deepEqual(JSON.parse(calls[0][1]).entries, entries); assert.equal(JSON.parse(calls.at(-1)[1]).state, "committed");
});
test("an interrupted commit restores every original snapshot", async () => {
  const entries = [{ filePath: "queue", before: "old queue", after: "new queue" }, { filePath: "binding", before: "old binding", after: "new binding" }];
  const state = new Map(entries.map(x => [x.filePath, x.before])); let failed = false;
  await assert.rejects(commitEmptyDraftRecovery({ entries, backupPath: "backup", writeSnapshot: async (file, text) => {
    if (file === "binding" && !failed) { failed = true; throw new Error("simulated write failure"); } state.set(file, text);
  } }), { code: "draft_recovery_rolled_back" });
  for (const entry of entries) assert.equal(state.get(entry.filePath), entry.before);
});
test("backup failure writes no live state; rollback failure is explicit", async () => {
  const entries = [{ filePath: "queue", before: "old", after: "new" }]; const calls = [];
  await assert.rejects(commitEmptyDraftRecovery({ entries, backupPath: "backup", writeSnapshot: async file => { calls.push(file); throw new Error("failure"); } }));
  assert.deepEqual(calls, ["backup"]);
  await assert.rejects(commitEmptyDraftRecovery({ entries, backupPath: "backup", writeSnapshot: async file => { if (file !== "backup") throw new Error("failure"); } }), { code: "draft_recovery_rollback_incomplete" });
});

test("a failed final backup checkpoint rolls back the live files", async () => {
  const entries = [{ filePath: "queue", before: "old", after: "new" }];
  const state = new Map([["queue", "old"]]);
  await assert.rejects(commitEmptyDraftRecovery({ entries, backupPath: "backup", writeSnapshot: async (file, text) => {
    if (file === "backup" && JSON.parse(text).state === "committed") throw new Error("checkpoint failure");
    state.set(file, text);
  } }), { code: "draft_recovery_rolled_back" });
  assert.equal(state.get("queue"), "old");
});

test("refuses a backup path that would overwrite a live file", async () => {
  await assert.rejects(commitEmptyDraftRecovery({
    entries: [{ filePath: "queue", before: "old", after: "new" }], backupPath: "queue",
    writeSnapshot: async () => assert.fail("must not write"),
  }), /Unique recovery files/);
});
