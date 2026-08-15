import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCapacityMarkdown,
  buildModelMarkdown,
  capacityView,
  readLatestRolloutSnapshot,
} from "../../../../../src/experimental/collaboration/codex/codex-status.mjs";

async function withTempRollout(lines, callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-status-"));
  const file = path.join(dir, "rollout.jsonl");
  try {
    await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
    await callback(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("reads the latest token and lifecycle records from the rollout tail", async () => {
  const old = JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", payload: { type: "token_count", info: { model_context_window: 1 } } });
  const latest = JSON.stringify({
    timestamp: "2026-08-10T04:00:00Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 900000 },
        last_token_usage: { total_tokens: 220000 },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: { used_percent: 8, window_minutes: 10080, resets_at: 1786843935 },
        plan_type: "pro",
      },
    },
  });
  await withTempRollout([old, "x".repeat(5000), latest, JSON.stringify({ timestamp: "2026-08-10T04:01:00Z", payload: { type: "task_complete" } })], async (file) => {
    const snapshot = await readLatestRolloutSnapshot(file, { maxTailBytes: 4096 });
    assert.equal(snapshot.tokenCount.info.model_context_window, 258400);
    assert.equal(snapshot.lifecycle.type, "task_complete");
  });
});

test("computes both context and account remaining capacity", () => {
  const view = capacityView({
    tokenCount: {
      timestamp: "2026-08-10T04:00:00Z",
      info: {
        last_token_usage: { total_tokens: 220000 },
        model_context_window: 258400,
        total_token_usage: { total_tokens: 900000 },
      },
      rateLimits: {
        primary: { used_percent: 8, window_minutes: 10080, resets_at: 1786843935 },
        plan_type: "pro",
      },
    },
  });
  assert.equal(view.contextRemaining, 38400);
  assert.equal(view.accountRemainingPercent, 92);
  assert.equal(view.accountWindowMinutes, 10080);
});

test("capacity and model replies explicitly state that no model was called", () => {
  assert.match(buildCapacityMarkdown(undefined), /没有调用语言模型/);
  assert.match(buildModelMarkdown({
    id: "thread-1",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    model_provider: "openai",
    cli_version: "1.0.0",
  }), /gpt-5\.6-sol/);
  assert.match(buildModelMarkdown({ id: "thread-1" }), /没有调用语言模型/);
});
