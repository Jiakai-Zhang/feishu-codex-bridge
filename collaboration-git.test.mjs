import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  CollaborationGitHandoff,
  collaborationRegistrationPath,
  writeCollaborationRegistration,
} from "./collaboration-git.mjs";
import { ProjectContext } from "./project-context.mjs";

const execFileAsync = promisify(execFile);
const githubRepository = "example/shared-repository";

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
  return String(result.stdout || "").trim();
}

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-collab-git-"));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  try {
    await fs.mkdir(repo);
    await git(root, ["init", "--bare", remote]);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "bridge-test@example.invalid"]);
    await git(repo, ["config", "user.name", "Bridge Test"]);
    await fs.writeFile(path.join(repo, "README.md"), "initial\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "-u", "origin", "main"]);
    const context = new ProjectContext({
      id: "local-project",
      name: "Local Project",
      repoRoot: repo,
      worktreeRoot,
      allowedWorktreeRoots: [repo, worktreeRoot],
      defaultBranch: "main",
      protectDefaultBranch: true,
      allowedRemotes: ["origin"],
    });
    const handoff = new CollaborationGitHandoff(context, {
      githubRepository,
      remote: "origin",
      canonicalizeRemote: () => githubRepository,
    });
    await run({ root, remote, repo, worktreeRoot, context, handoff });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("publishes a clean exact request and refuses dirty or protected worktrees", async () => fixture(async ({ repo, context, handoff }) => {
  const worktree = await context.prepareWorktree("task/handoff");
  await fs.writeFile(path.join(worktree.path, "handoff.txt"), "handoff\n");
  await git(worktree.path, ["add", "handoff.txt"]);
  await git(worktree.path, ["commit", "-m", "handoff"]);
  const head = await git(worktree.path, ["rev-parse", "HEAD"]);
  const request = {
    source: { cwd: worktree.path, remote: "origin", branch: "task/handoff", head },
    action: { gitSyncMode: "push" },
  };
  assert.deepEqual(await handoff.publishRequest(request), {
    remote: "origin", branch: "task/handoff", commit: head,
  });
  await fs.writeFile(path.join(worktree.path, "dirty.txt"), "dirty\n");
  await assert.rejects(() => handoff.publishRequest(request), /clean worktree/);
  await assert.rejects(() => handoff.inspectWorktree(repo), /Protected default branch/);
}));

test("fetches an exact remote commit into a new worktree and only fast-forwards", async () => fixture(async ({ root, remote, repo, context, handoff }) => {
  const source = path.join(root, "source");
  await git(root, ["clone", remote, source]);
  await git(source, ["config", "user.email", "source@example.invalid"]);
  await git(source, ["config", "user.name", "Source"]);
  await git(source, ["switch", "-c", "task/remote"]);
  await fs.writeFile(path.join(source, "remote.txt"), "one\n");
  await git(source, ["add", "remote.txt"]);
  await git(source, ["commit", "-m", "remote one"]);
  await git(source, ["push", "-u", "origin", "task/remote"]);
  const first = await git(source, ["rev-parse", "HEAD"]);
  const prepared = await handoff.prepareIncoming({ remote: "origin", branch: "task/remote", commit: first });
  assert.equal(prepared.created, true);
  assert.equal(await git(prepared.path, ["rev-parse", "HEAD"]), first);

  await fs.appendFile(path.join(source, "remote.txt"), "two\n");
  await git(source, ["add", "remote.txt"]);
  await git(source, ["commit", "-m", "remote two"]);
  await git(source, ["push"]);
  const second = await git(source, ["rev-parse", "HEAD"]);
  const advanced = await handoff.prepareIncoming({ remote: "origin", branch: "task/remote", commit: second });
  assert.equal(advanced.created, false);
  assert.equal(await git(advanced.path, ["rev-parse", "HEAD"]), second);

  await fs.writeFile(path.join(advanced.path, "local.txt"), "dirty\n");
  await assert.rejects(
    () => handoff.prepareIncoming({ remote: "origin", branch: "task/remote", commit: second }),
    /clean worktree/,
  );
  assert.equal((await context.refresh()).worktrees.some(({ branch }) => branch === "task/remote"), true);
  assert.equal(repo !== advanced.path, true);
}));

test("publishes results and writes one git-common-dir Project registration", async () => fixture(async ({ context, handoff }) => {
  const worktree = await context.prepareWorktree("task/result");
  await fs.writeFile(path.join(worktree.path, "result.txt"), "done\n");
  await git(worktree.path, ["add", "result.txt"]);
  await git(worktree.path, ["commit", "-m", "result"]);
  const result = await handoff.publishResult({ cwd: worktree.path, branch: "task/result" });
  assert.equal(result.commit, await git(worktree.path, ["rev-parse", "HEAD"]));
  const registration = {
    schemaVersion: 1,
    enabled: true,
    agentId: "local-codex",
    projectId: "local-project",
    groupChatId: "oc_team",
    githubRepository,
    remote: "origin",
    inboxPath: "C:/runtime/inbox",
  };
  const filePath = await writeCollaborationRegistration(context, registration);
  assert.equal(filePath, await collaborationRegistrationPath(context));
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), registration);
}));
