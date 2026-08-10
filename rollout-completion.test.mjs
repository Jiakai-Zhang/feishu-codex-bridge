import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRolloutCompletionWatcher } from "./rollout-completion.mjs";

function line(type, payload) {
  return `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
}

async function withRollout(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rollout-watcher-"));
  const rollout = path.join(directory, "rollout.jsonl");
  try {
    await fs.writeFile(rollout, [
      line("event_msg", { type: "agent_message", message: "旧答案" }),
      line("event_msg", { type: "task_complete" }),
    ].join(""), "utf8");
    await callback(rollout);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("ignores terminal events that existed before the watcher started", async () => {
  await withRollout(async (rollout) => {
    const watcher = await createRolloutCompletionWatcher(rollout, { stableMs: 0 });
    assert.equal(await watcher.poll(), undefined);
  });
});

test("returns the last assistant message after a new stable task_complete", async () => {
  await withRollout(async (rollout) => {
    let clock = 1_000;
    const watcher = await createRolloutCompletionWatcher(rollout, {
      stableMs: 15_000,
      now: () => clock,
      chunkBytes: 1,
    });
    await fs.appendFile(rollout, [
      line("event_msg", { type: "agent_message", message: "处理中" }),
      line("event_msg", { type: "agent_message", message: "最终答案" }),
      line("event_msg", { type: "task_complete" }),
    ].join(""), "utf8");

    assert.equal(await watcher.poll(), undefined);
    clock += 15_000;
    assert.equal((await watcher.poll()).answer, "最终答案");
  });
});

test("does not rescan the existing rollout on idle polls", async () => {
  await withRollout(async (rollout) => {
    const watcher = await createRolloutCompletionWatcher(rollout, { stableMs: 0 });
    const initialOffset = watcher.offset;
    await watcher.poll();
    await watcher.poll();
    assert.equal(watcher.offset, initialOffset);
  });
});
