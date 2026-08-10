import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runProcess } from "./process-runner.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.unref = () => {};
  return child;
}

test("durable completion resolves even when an exited child never emits close", async () => {
  const child = fakeChild();
  child.exitCode = 0;
  const answer = "durably persisted answer";
  const result = await runProcess("codex", [], {
    spawnProcess: () => child,
    stopProcessTreeImpl: async () => {},
    completionProbe: async () => ({ answer }),
    completionPollMs: 5,
  });

  assert.equal(result.code, 0);
  assert.equal(result.logicalCompletionSeen, true);
  assert.equal(result.forcedAfterLogicalCompletion, true);
  assert.equal(result.recoveredAnswer, answer);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test("turn.completed settles after the grace period without a close event", async () => {
  const child = fakeChild();
  const resultPromise = runProcess("codex", [], {
    spawnProcess: () => child,
    stopProcessTreeImpl: async () => { child.exitCode = 1; },
    logicalCompletionGraceMs: 5,
    onStdoutLine: (line) => JSON.parse(line).type === "turn.completed",
  });
  child.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  const result = await resultPromise;

  assert.equal(result.code, 1);
  assert.equal(result.logicalCompletionSeen, true);
  assert.equal(result.forcedAfterLogicalCompletion, true);
});

test("normal close keeps the real exit code", async () => {
  const child = fakeChild();
  const resultPromise = runProcess("codex", [], { spawnProcess: () => child });
  child.exitCode = 7;
  child.emit("close", 7);
  const result = await resultPromise;

  assert.equal(result.code, 7);
  assert.equal(result.logicalCompletionSeen, false);
  assert.equal(result.forcedAfterLogicalCompletion, false);
});
