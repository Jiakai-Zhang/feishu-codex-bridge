import assert from "node:assert/strict";
import test from "node:test";
import { buildLandingPlan, effectiveReceiveMode, resolveLandingChoice } from "../../../../../src/experimental/collaboration/git/collaboration-landing.mjs";

test("uses the stricter sender and receiver automation policy", () => {
  assert.equal(effectiveReceiveMode("auto", "auto"), "auto");
  assert.equal(effectiveReceiveMode("auto", "recommend"), "recommend");
  assert.equal(effectiveReceiveMode("recommend", "manual"), "manual");
  assert.throws(() => effectiveReceiveMode("always", "auto"), /Receive mode/);
});

test("prefers a recent branch thread, then a new thread, then a new worktree", () => {
  const snapshot = { worktrees: [{ branch: "task/x", path: "C:/wt/x" }] };
  const threads = [
    { id: "thread-old", title: "Old", updated_at_ms: 10, worktree: snapshot.worktrees[0] },
    { id: "thread-new", title: "New", updated_at_ms: 20, worktree: snapshot.worktrees[0] },
  ];
  const existing = buildLandingPlan({ branch: "task/x", threads, snapshot });
  assert.deepEqual(existing.recommendation, {
    landing: "existing-thread",
    threadId: "thread-new",
    worktreePath: "C:/wt/x",
    title: "New",
  });
  assert.equal(resolveLandingChoice(existing, "thread:thread-old").threadId, "thread-old");
  assert.equal(resolveLandingChoice(existing, "new-thread").landing, "new-thread");

  const noThreads = buildLandingPlan({ branch: "task/x", threads: [], snapshot });
  assert.equal(noThreads.recommendation.landing, "new-thread");
  const newWorktree = buildLandingPlan({ branch: "task/y", threads: [], snapshot });
  assert.equal(newWorktree.recommendation.landing, "new-worktree");
  assert.throws(() => resolveLandingChoice(newWorktree, "new-thread"), /not available/);
});
