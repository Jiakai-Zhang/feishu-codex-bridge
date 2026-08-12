import assert from "node:assert/strict";
import test from "node:test";
import { createExecutor } from "./executor-registry.mjs";

test("selects the configured Codex adapter behind a stable executor interface", async () => {
  const executor = createExecutor({ type: "codex" }, {
    codex: {
      createThread: async () => "thread",
      runTurn: async () => "answer",
    },
  });
  assert.equal(executor.type, "codex");
  assert.equal(await executor.createThread(), "thread");
  assert.equal(await executor.runTurn(), "answer");
});

test("fails closed when a future executor has not been installed", () => {
  assert.throws(() => createExecutor({ type: "other-agent" }, {
    codex: { createThread() {}, runTurn() {} },
  }), /Unsupported agent executor/);
});
