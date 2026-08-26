import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionInputLedger } from "../../../src/persistence/session-input-ledger.mjs";

test("persists accepted input independently from final-answer delivery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-input-ledger-"));
  const file = path.join(directory, "ledger.json");
  try {
    const ledger = await SessionInputLedger.open(file);
    await ledger.put({
      messageId: "om_prompt",
      chatId: "oc_group",
      threadId: "omt_topic",
      senderOpenId: "ou_member",
      sessionThreadId: "codex-thread",
      turnId: "turn-a",
      turnInitiator: true,
      kind: "started",
    });
    assert.equal(ledger.has("om_prompt"), true);
    assert.deepEqual((await SessionInputLedger.open(file)).get("om_prompt"), {
      messageId: "om_prompt",
      chatId: "oc_group",
      threadId: "omt_topic",
      senderOpenId: "ou_member",
      sessionThreadId: "codex-thread",
      turnId: "turn-a",
      turnInitiator: true,
      kind: "started",
      createdAt: ledger.get("om_prompt").createdAt,
    });
    assert.equal(ledger.findTurnInitiator("codex-thread", "turn-a").senderOpenId, "ou_member");
    await ledger.remove("om_prompt");
    assert.equal((await SessionInputLedger.open(file)).has("om_prompt"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("bounds old accepted inputs while retaining the newest entries", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-input-ledger-"));
  const file = path.join(directory, "ledger.json");
  try {
    const ledger = await SessionInputLedger.open(file, { maxEntries: 5 });
    for (let index = 0; index < 7; index += 1) {
      await ledger.put({ messageId: `om_${index}`, createdAt: index + 1 });
    }
    assert.equal(ledger.has("om_0"), false);
    assert.equal(ledger.has("om_6"), true);
    assert.ok(ledger.list().length <= 5);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
