import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskLeaseStore } from "./task-lease-store.mjs";

test("serializes tasks per Project branch and releases ownership", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-task-lease-"));
  try {
    let now = 1000;
    const store = await TaskLeaseStore.open(path.join(directory, "leases.json"), { now: () => now });
    await store.acquire({ projectId: "bridge", branch: "task/x", taskId: "task:one", ownerAgentId: "local", leaseMs: 1000 });
    await assert.rejects(() => store.acquire({ projectId: "bridge", branch: "task/x", taskId: "task:two", ownerAgentId: "local", leaseMs: 1000 }), /leased by task task:one/);
    assert.equal(await store.release({ projectId: "bridge", branch: "task/x", taskId: "task:two" }), false);
    assert.equal(await store.release({ projectId: "bridge", branch: "task/x", taskId: "task:one" }), true);
    await store.acquire({ projectId: "bridge", branch: "task/x", taskId: "task:two", ownerAgentId: "local", leaseMs: 1000 });
    now = 2001;
    assert.equal(store.list().length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("serializes competing lease stores through an exclusive file lock", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-task-lease-"));
  const file = path.join(directory, "leases.json");
  try {
    const first = await TaskLeaseStore.open(file, { now: () => 1000 });
    const second = await TaskLeaseStore.open(file, { now: () => 1000 });
    const results = await Promise.allSettled([
      first.acquire({ projectId: "bridge", branch: "task/x", taskId: "task:one", ownerAgentId: "one", leaseMs: 1000 }),
      second.acquire({ projectId: "bridge", branch: "task/x", taskId: "task:two", ownerAgentId: "two", leaseMs: 1000 }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
