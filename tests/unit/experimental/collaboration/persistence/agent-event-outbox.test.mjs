import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentEventOutbox } from "../../../../../src/experimental/collaboration/persistence/agent-event-outbox.mjs";

test("persists Agent events before delivery and retries by stable eventId", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-agent-outbox-"));
  const file = path.join(directory, "pending.json");
  try {
    const outbox = await AgentEventOutbox.open(file);
    const record = {
      peerAgentId: "alice-codex",
      chatId: "oc_team",
      event: { schemaVersion: 1, eventId: "evt:12345678", kind: "task.progress" },
      createdAt: 10,
    };
    await outbox.put(record);
    await outbox.put(record);
    assert.equal(outbox.size(), 1);
    await assert.rejects(() => outbox.put({
      ...record,
      event: { ...record.event, kind: "task.result" },
    }), /eventId collision/);
    await outbox.markFailure(record.event.eventId, Object.assign(new Error("secret detail"), { code: "ECONNRESET" }), {
      now: 1000,
      baseDelayMs: 100,
      maxDelayMs: 500,
    });
    assert.equal(outbox.list()[0].lastErrorCode, "ECONNRESET");
    assert.equal(outbox.list({ dueAt: 1099 }).length, 0);
    assert.equal(outbox.list({ dueAt: 1100 }).length, 1);
    assert.equal((await AgentEventOutbox.open(file)).size(), 1);
    await outbox.remove(record.event.eventId);
    assert.equal(outbox.size(), 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
