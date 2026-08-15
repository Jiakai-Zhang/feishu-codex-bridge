import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLog } from "../../../../../src/experimental/collaboration/persistence/audit-log.mjs";

test("persists and verifies an append-only audit hash chain", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-audit-"));
  const file = path.join(directory, "audit.jsonl");
  try {
    const audit = await AuditLog.open(file, { now: () => 1_800_000_000_000 });
    await audit.append({ type: "bridge.started", actor: "local-codex", projectId: "bridge" });
    await audit.append({ type: "task.accepted", actor: "human:ou_owner", projectId: "bridge", taskId: "task:12345678", details: { branch: "task/x" } });
    assert.equal(audit.size(), 2);
    assert.match(audit.headHash(), /^[a-f0-9]{64}$/);
    const reopened = await AuditLog.open(file);
    assert.equal(reopened.tail(1)[0].type, "task.accepted");

    const lines = (await fs.readFile(file, "utf8")).trim().split(/\r?\n/);
    const tampered = JSON.parse(lines[0]);
    tampered.actor = "mallory";
    lines[0] = JSON.stringify(tampered);
    await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
    await assert.rejects(() => AuditLog.open(file), /hash chain mismatch/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("bounds audit details and tail queries", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-audit-"));
  try {
    const audit = await AuditLog.open(path.join(directory, "audit.jsonl"));
    await assert.rejects(() => audit.append({ type: "task.failed", actor: "agent", projectId: "bridge", details: { value: "x".repeat(9_000) } }), /too large/);
    await audit.append({ type: "task.failed", actor: "agent", projectId: "bridge", details: { code: "EFAIL" } });
    assert.equal(audit.tail(1000).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
