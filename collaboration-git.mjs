import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalGitHubRepository } from "./collaboration-request-inbox.mjs";
import { isPathInside, normalizeFsPath } from "./project-context.mjs";

const SHA = /^[0-9a-f]{40}$/i;
const REMOTE = /^[A-Za-z0-9._-]+$/;

function requiredString(value, field, max = 2_000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} is too long`);
  return normalized;
}

function normalizeGitSpec(value, expectedRemote) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Git handoff is required");
  const remote = requiredString(value.remote, "git.remote", 100);
  const branch = requiredString(value.branch, "git.branch", 200);
  const commit = requiredString(value.commit, "git.commit", 40).toLowerCase();
  if (!REMOTE.test(remote)) throw new TypeError("git.remote is invalid");
  if (remote !== expectedRemote) throw new Error(`Git handoff remote must be ${expectedRemote}`);
  if (!SHA.test(commit)) throw new TypeError("git.commit must be a full Git SHA");
  return { remote, branch, commit };
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, filePath);
}

export class CollaborationGitHandoff {
  constructor(projectContext, {
    githubRepository,
    remote,
    canonicalizeRemote = canonicalGitHubRepository,
  }) {
    this.projectContext = projectContext;
    this.githubRepository = canonicalGitHubRepository(githubRepository);
    this.remote = requiredString(remote, "collaboration.remote", 100);
    if (!REMOTE.test(this.remote)) throw new TypeError("collaboration.remote is invalid");
    if (!projectContext.project.allowedRemotes.includes(this.remote)) {
      throw new Error(`Collaboration remote ${this.remote} is outside project.allowedRemotes`);
    }
    this.canonicalizeRemote = canonicalizeRemote;
  }

  async verifyBinding() {
    const url = (await this.projectContext.git(["remote", "get-url", this.remote])).trim();
    const actual = this.canonicalizeRemote(url);
    if (actual !== this.githubRepository) {
      throw new Error(`Remote ${this.remote} is ${actual}, not the bound GitHub repository ${this.githubRepository}`);
    }
    return { remote: this.remote, url, githubRepository: actual };
  }

  async inspectWorktree(cwd, {
    expectedBranch,
    expectedCommit,
    requireWritable = true,
  } = {}) {
    const candidate = normalizeFsPath(cwd);
    const snapshot = await this.projectContext.refresh();
    const worktree = this.projectContext.matchCwd(candidate, snapshot);
    if (!worktree) throw new Error("Collaboration cwd is outside the bound Bridge Project worktrees");
    const [realCwd, realWorktree] = await Promise.all([
      fs.realpath(candidate),
      fs.realpath(worktree.path),
    ]);
    if (!isPathInside(realWorktree, realCwd)) throw new Error("Resolved collaboration cwd escapes its Project worktree");
    const [topLevelText, branchText, headText, status] = await Promise.all([
      this.projectContext.git(["rev-parse", "--show-toplevel"], { cwd: realCwd }),
      this.projectContext.git(["branch", "--show-current"], { cwd: realCwd }),
      this.projectContext.git(["rev-parse", "HEAD"], { cwd: realCwd }),
      this.projectContext.git(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: realCwd }),
    ]);
    const topLevel = normalizeFsPath(topLevelText.trim());
    const branch = branchText.trim();
    const commit = headText.trim().toLowerCase();
    if (topLevel.toLowerCase() !== normalizeFsPath(worktree.path).toLowerCase()) {
      throw new Error("Git top-level does not match the registered Project worktree");
    }
    if (!branch || worktree.detached) throw new Error("Detached HEAD cannot participate in collaboration");
    if (worktree.locked) throw new Error(`Worktree for ${branch} is locked`);
    if (status.trim()) throw new Error("Collaboration requires a clean worktree; commit only the intended changes first");
    if (expectedBranch && branch !== expectedBranch) throw new Error(`Collaboration branch changed from ${expectedBranch} to ${branch}`);
    if (expectedCommit && commit !== String(expectedCommit).toLowerCase()) {
      throw new Error(`Collaboration commit changed from ${expectedCommit} to ${commit}`);
    }
    if (requireWritable && this.projectContext.project.protectDefaultBranch
      && branch === this.projectContext.project.defaultBranch) {
      throw new Error(`Protected default branch ${branch} cannot be used for collaboration writes`);
    }
    return { cwd: realCwd, worktree, branch, commit };
  }

  async remoteHead(branch) {
    try { await this.projectContext.git(["check-ref-format", "--branch", branch]); }
    catch { throw new TypeError(`Invalid collaboration branch: ${branch}`); }
    const output = await this.projectContext.git([
      "ls-remote", "--heads", this.remote, `refs/heads/${branch}`,
    ]);
    const match = output.trim().match(/^([0-9a-f]{40})\s+refs\/heads\//i);
    return match?.[1]?.toLowerCase();
  }

  async assertRemoteCommit(branch, commit) {
    const remoteCommit = await this.remoteHead(branch);
    if (remoteCommit !== commit.toLowerCase()) {
      throw new Error(`Remote ${this.remote}/${branch} does not contain the handoff commit ${commit}`);
    }
  }

  async publishRequest(request) {
    await this.verifyBinding();
    const expected = normalizeGitSpec({
      remote: request.source.remote,
      branch: request.source.branch,
      commit: request.source.head,
    }, this.remote);
    const inspected = await this.inspectWorktree(request.source.cwd, {
      expectedBranch: expected.branch,
      expectedCommit: expected.commit,
    });
    if (request.action.gitSyncMode === "push") {
      await this.projectContext.git([
        "push", "--porcelain", "--set-upstream", this.remote,
        `HEAD:refs/heads/${expected.branch}`,
      ], { cwd: inspected.cwd });
    }
    await this.assertRemoteCommit(expected.branch, expected.commit);
    return expected;
  }

  async fetchExact(git) {
    const spec = normalizeGitSpec(git, this.remote);
    await this.verifyBinding();
    try { await this.projectContext.git(["check-ref-format", "--branch", spec.branch]); }
    catch { throw new TypeError(`Invalid collaboration branch: ${spec.branch}`); }
    await this.projectContext.git([
      "fetch", "--no-tags", this.remote, `refs/heads/${spec.branch}`,
    ]);
    const fetched = (await this.projectContext.git(["rev-parse", "FETCH_HEAD"])).trim().toLowerCase();
    if (fetched !== spec.commit) {
      throw new Error(`Fetched ${this.remote}/${spec.branch} at ${fetched}, expected ${spec.commit}`);
    }
    return spec;
  }

  async isAncestor(ancestor, descendant) {
    try {
      await this.projectContext.git(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  async prepareIncoming(git) {
    const spec = await this.fetchExact(git);
    let snapshot = await this.projectContext.refresh();
    const existingWorktree = snapshot.worktrees.find(({ branch }) => branch === spec.branch);
    if (existingWorktree) {
      const current = await this.inspectWorktree(existingWorktree.path, {
        expectedBranch: spec.branch,
        requireWritable: true,
      });
      if (current.commit !== spec.commit) {
        if (!await this.isAncestor(current.commit, spec.commit)) {
          throw new Error(`Local branch ${spec.branch} has diverged from the collaboration commit`);
        }
        // Advance to the already verified FETCH_HEAD commit without a second
        // network lookup. --ff-only cannot create a merge commit or reconcile
        // divergence, so the exact signed handoff SHA remains the authority.
        await this.projectContext.git([
          "merge", "--ff-only", spec.commit,
        ], { cwd: current.cwd });
      }
      const verified = await this.inspectWorktree(existingWorktree.path, {
        expectedBranch: spec.branch,
        expectedCommit: spec.commit,
      });
      return { ...verified.worktree, path: verified.worktree.path, created: false, commit: verified.commit };
    }
    const excluded = snapshot.excludedWorktrees.find(({ branch }) => branch === spec.branch);
    if (excluded) throw new Error(`Branch ${spec.branch} is checked out outside project.allowedWorktreeRoots`);

    const local = snapshot.branches.find(({ kind, name }) => kind === "local" && name === spec.branch);
    if (local && local.head.toLowerCase() !== spec.commit) {
      if (!await this.isAncestor(local.head, spec.commit)) {
        throw new Error(`Local branch ${spec.branch} has diverged from the collaboration commit`);
      }
      await this.projectContext.git([
        "update-ref", `refs/heads/${spec.branch}`, spec.commit, local.head,
      ]);
    }
    const worktree = await this.projectContext.prepareWorktree(spec.branch, {
      startPoint: local ? undefined : spec.commit,
    });
    const verified = await this.inspectWorktree(worktree.path, {
      expectedBranch: spec.branch,
      expectedCommit: spec.commit,
    });
    snapshot = await this.projectContext.refresh();
    const registered = snapshot.worktrees.find(({ branch }) => branch === spec.branch);
    return { ...registered, created: worktree.created, commit: verified.commit };
  }

  async publishResult({ cwd, branch }) {
    await this.verifyBinding();
    const inspected = await this.inspectWorktree(cwd, { expectedBranch: branch, requireWritable: true });
    await this.projectContext.git([
      "push", "--porcelain", "--set-upstream", this.remote,
      `HEAD:refs/heads/${inspected.branch}`,
    ], { cwd: inspected.cwd });
    await this.assertRemoteCommit(inspected.branch, inspected.commit);
    return { remote: this.remote, branch: inspected.branch, commit: inspected.commit };
  }
}

export async function collaborationRegistrationPath(projectContext) {
  const commonText = (await projectContext.git(["rev-parse", "--git-common-dir"])).trim();
  const commonDir = path.resolve(projectContext.project.repoRoot, commonText);
  return path.join(commonDir, "feishu-codex-bridge", "collaboration.json");
}

export async function writeCollaborationRegistration(projectContext, registration) {
  const filePath = await collaborationRegistrationPath(projectContext);
  await writeJsonAtomic(filePath, registration);
  return filePath;
}
