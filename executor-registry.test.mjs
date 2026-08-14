import assert from "node:assert/strict";
import test from "node:test";
import { createExecutor } from "./executor-registry.mjs";

test("selects the configured Codex adapter behind a stable executor interface", async () => {
  const executor = createExecutor({ type: "codex" }, {
    codex: {
      capabilities: { persistentThreads: true, projectCwd: true, progressUpdates: true },
      createThread: async () => "thread",
      runTurn: async () => "answer",
    },
  });
  assert.equal(executor.type, "codex");
  assert.equal(executor.capabilities.projectCwd, true);
  assert.equal(await executor.createThread(), "thread");
  assert.equal(await executor.runTurn(), "answer");
});

test("fails closed when a future executor has not been installed", () => {
  assert.throws(() => createExecutor({ type: "other-agent" }, {
    codex: {
      capabilities: { persistentThreads: true, projectCwd: true, progressUpdates: true },
      createThread() {},
      runTurn() {},
    },
  }), /Unsupported agent executor/);
});

test("accepts a future executor only with the full Project safety contract", () => {
  assert.throws(() => createExecutor({ type: "future" }, {
    future: { capabilities: { persistentThreads: true }, createThread() {}, runTurn() {} },
  }), /projectCwd, progressUpdates/);
  const executor = createExecutor({ type: "future" }, {
    future: {
      capabilities: { persistentThreads: true, projectCwd: true, progressUpdates: true, cancellation: true },
      createThread() {},
      runTurn() {},
      cancelTurn() {},
    },
  });
  assert.equal(executor.type, "future");
  assert.equal(executor.capabilities.cancellation, true);
});
