import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ProjectContext, isPathInside, parseWorktreePorcelain } from "./project-context.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function withProject(callback) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-project-"));
  const root = await fs.realpath(temporaryRoot);
  const repo = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  await fs.mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "bridge-test@example.invalid"]);
  await git(repo, ["config", "user.name", "Bridge Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  const context = new ProjectContext({
    id: "bridge",
    name: "Bridge",
    repoRoot: repo,
    worktreeRoot,
    allowedWorktreeRoots: [repo, worktreeRoot],
    defaultBranch: "main",
    protectDefaultBranch: true,
    allowedRemotes: ["origin"],
  });
  try { await callback({ root, repo, worktreeRoot, context }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("parses worktree porcelain records", () => {
  const parsed = parseWorktreePorcelain("worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/wt\nHEAD def\ndetached\n");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].branch, "main");
  assert.equal(parsed[1].detached, true);
});

test("uses path-component boundaries", () => {
  assert.equal(isPathInside("C:/repo", "C:/repo/src"), true);
  assert.equal(isPathInside("C:/repo", "C:/repository"), false);
});

test("validates Codex threads against real paths and recorded branches", async () => {
  await withProject(async ({ repo, context }) => {
    const snapshot = await context.refresh();
    const inside = await context.validateThread({ id: "inside", cwd: repo, git_branch: "main" }, snapshot);
    assert.equal(inside.id, "inside");
    assert.equal(context.effectiveSandbox(inside.worktree, "danger-full-access"), "read-only");
    assert.equal(await context.validateThread({ id: "outside", cwd: path.dirname(repo), git_branch: "main" }, snapshot), undefined);
    assert.equal(await context.validateThread({ id: "missing", cwd: path.join(repo, "missing"), git_branch: "main" }, snapshot), undefined);
    assert.equal(await context.validateThread({ id: "stale", cwd: repo, git_branch: "task/old" }, snapshot), undefined);
    assert.equal(await context.validateThread({ id: "unbound", cwd: repo }, snapshot), undefined);
  });
});

test("forces detached or locked worktrees to read-only", async () => {
  await withProject(async ({ context }) => {
    assert.equal(context.effectiveSandbox({ detached: true }, "workspace-write"), "read-only");
    assert.equal(context.effectiveSandbox({ branch: "task/1", locked: true }, "workspace-write"), "read-only");
    assert.equal(context.effectiveSandbox({ branch: "task/1" }, "workspace-write"), "workspace-write");
  });
});

test("creates one task worktree per branch and reuses the registered path", async () => {
  await withProject(async ({ context, worktreeRoot }) => {
    const first = await context.prepareWorktree("task/LOGIN-123");
    assert.equal(first.created, true);
    assert.equal(first.branch, "task/LOGIN-123");
    assert.equal(isPathInside(worktreeRoot, first.path), true);
    assert.match(path.basename(first.path), /-[0-9a-f]{8}$/);
    const second = await context.prepareWorktree("task/LOGIN-123");
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);
  });
});

test("creates a task worktree at an exact fetched commit", async () => {
  await withProject(async ({ context }) => {
    const commit = (await context.git(["rev-parse", "HEAD"])).trim();
    const worktree = await context.prepareWorktree("task/exact", { startPoint: commit });
    assert.equal(worktree.head, commit);
    await assert.rejects(
      () => context.prepareWorktree("task/missing", { startPoint: "f".repeat(40) }),
      /not available locally/,
    );
  });
});

test("refuses a writable task worktree for the protected default branch", async () => {
  await withProject(async ({ context }) => {
    await assert.rejects(() => context.prepareWorktree("main"), /protected default branch/);
  });
});