import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionInputLedger } from "./session-input-ledger.mjs";

test("persists accepted input independently from final-answer delivery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-input-ledger-"));
  const file = path.join(directory, "ledger.json");
  try {
    const ledger = await SessionInputLedger.open(file);
    await ledger.put({ messageId: "om_prompt", chatId: "oc_group", threadId: "omt_topic", kind: "started" });
    assert.equal(ledger.has("om_prompt"), true);
    assert.deepEqual((await SessionInputLedger.open(file)).get("om_prompt"), {
      messageId: "om_prompt",
      chatId: "oc_group",
      threadId: "omt_topic",
      kind: "started",
      createdAt: ledger.get("om_prompt").createdAt,
    });
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
