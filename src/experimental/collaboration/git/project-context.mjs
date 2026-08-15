import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

export function normalizeFsPath(value) {
  const stripped = String(value || "").replace(/^\\\\\?\\/, "");
  return path.resolve(stripped);
}

export function isPathInside(basePath, candidatePath, { allowEqual = true } = {}) {
  const base = normalizeFsPath(basePath);
  const candidate = normalizeFsPath(candidatePath);
  const relative = path.relative(base, candidate);
  if (!relative) return allowEqual;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function parseWorktreePorcelain(text) {
  const records = [];
  let current;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) records.push(current);
      current = undefined;
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? true : line.slice(separator + 1);
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: normalizeFsPath(value) };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") {
      current.branchRef = value;
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") current.locked = value === true ? true : value;
    else if (key === "prunable") current.prunable = value === true ? true : value;
  }
  if (current) records.push(current);
  return records;
}

function parseBranchRefs(text) {
  return String(text || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, head = "", upstream = ""] = line.split("\t");
    const local = ref.startsWith("refs/heads/");
    const remote = ref.startsWith("refs/remotes/");
    const name = local
      ? ref.slice("refs/heads/".length)
      : remote
        ? ref.slice("refs/remotes/".length)
        : ref;
    return { ref, name, head, upstream, kind: local ? "local" : remote ? "remote" : "other" };
  }).filter(({ name }) => !name.endsWith("/HEAD"));
}

function safeWorktreeSlug(branch) {
  const slug = branch.replaceAll("/", "__").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  if (!slug) throw new TypeError("Branch name cannot be mapped to a safe worktree directory");
  const digest = createHash("sha256").update(branch, "utf8").digest("hex").slice(0, 8);
  return `${slug.slice(0, 80)}-${digest}`;
}

export class ProjectContext {
  constructor(project, { gitExecutable = "git", execFileImpl = execFileAsync } = {}) {
    this.project = project;
    this.gitExecutable = gitExecutable;
    this.execFileImpl = execFileImpl;
  }

  async git(args, { cwd = this.project.repoRoot } = {}) {
    const result = await this.execFileImpl(this.gitExecutable, args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 5_000_000,
    });
    return typeof result === "string" ? result : result.stdout;
  }

  async refresh() {
    const repoRoot = normalizeFsPath(this.project.repoRoot);
    const [topLevelText, worktreeText, branchText, remoteText] = await Promise.all([
      this.git(["rev-parse", "--show-toplevel"]),
      this.git(["worktree", "list", "--porcelain"]),
      this.git(["for-each-ref", "--format=%(refname)%09%(objectname)%09%(upstream:short)", "refs/heads", "refs/remotes"]),
      this.git(["remote"]),
    ]);
    const topLevel = normalizeFsPath(topLevelText.trim());
    if (topLevel.toLowerCase() !== repoRoot.toLowerCase()) {
      throw new Error(`project.repoRoot must be the Git top-level directory: ${topLevel}`);
    }

    const allWorktrees = parseWorktreePorcelain(worktreeText);
    const worktrees = allWorktrees.filter((worktree) => this.project.allowedWorktreeRoots.some(
      (root) => isPathInside(root, worktree.path),
    ));
    const excludedWorktrees = allWorktrees.filter((candidate) => !worktrees.includes(candidate));
    const branches = parseBranchRefs(branchText);
    const remotes = remoteText.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean);
    const disallowedRemotes = remotes.filter((remote) => !this.project.allowedRemotes.includes(remote));
    return { repoRoot, topLevel, worktrees, excludedWorktrees, branches, remotes, disallowedRemotes };
  }

  matchCwd(cwd, snapshot) {
    const candidate = normalizeFsPath(cwd);
    return [...snapshot.worktrees]
      .filter((worktree) => isPathInside(worktree.path, candidate))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }

  annotateThread(thread, snapshot) {
    if (!thread?.cwd) return undefined;
    const worktree = this.matchCwd(thread.cwd, snapshot);
    if (!worktree) return undefined;
    return { ...thread, projectId: this.project.id, worktree };
  }

  async validateThread(thread, snapshot) {
    const annotated = this.annotateThread(thread, snapshot);
    if (!annotated) return undefined;
    const recordedBranch = typeof thread.git_branch === "string" ? thread.git_branch.trim() : "";
    const actualBranch = annotated.worktree.branch || "";
    if ((actualBranch && recordedBranch !== actualBranch) || (!actualBranch && recordedBranch)) return undefined;
    try {
      const [realCwd, realWorktree] = await Promise.all([
        fs.realpath(normalizeFsPath(thread.cwd)),
        fs.realpath(annotated.worktree.path),
      ]);
      if (!isPathInside(realWorktree, realCwd)) return undefined;
      return {
        ...annotated,
        branchBindingVerified: Boolean(actualBranch && recordedBranch === actualBranch),
        resolvedCwd: realCwd,
        resolvedWorktreePath: realWorktree,
      };
    } catch {
      return undefined;
    }
  }

  effectiveSandbox(worktree, configuredSandbox) {
    return !worktree?.branch || worktree.detached || worktree.locked || (
      this.project.protectDefaultBranch && worktree.branch === this.project.defaultBranch
    )
      ? "read-only"
      : configuredSandbox;
  }

  async prepareWorktree(branch, { startPoint } = {}) {
    const requestedBranch = String(branch || "").trim();
    if (!requestedBranch) throw new TypeError("A branch name is required");
    try { await this.git(["check-ref-format", "--branch", requestedBranch]); }
    catch { throw new TypeError(`Invalid branch name: ${requestedBranch}`); }
    const requestedStartPoint = startPoint ? String(startPoint).trim().toLowerCase() : undefined;
    if (requestedStartPoint && !/^[0-9a-f]{40}$/.test(requestedStartPoint)) {
      throw new TypeError("Worktree startPoint must be a full Git commit SHA");
    }
    if (requestedStartPoint) {
      try { await this.git(["cat-file", "-e", `${requestedStartPoint}^{commit}`]); }
      catch { throw new Error(`Worktree startPoint is not available locally: ${requestedStartPoint}`); }
    }
    if (this.project.protectDefaultBranch && requestedBranch === this.project.defaultBranch) {
      throw new Error(`The protected default branch ${requestedBranch} cannot be prepared as a writable task worktree`);
    }
    if (!this.project.worktreeRoot) throw new Error("project.worktreeRoot is required to create task worktrees");

    let snapshot = await this.refresh();
    const existing = snapshot.worktrees.find((worktree) => worktree.branch === requestedBranch);
    if (existing) return { ...existing, created: false };
    const excluded = snapshot.excludedWorktrees.find((worktree) => worktree.branch === requestedBranch);
    if (excluded) {
      throw new Error(`Branch ${requestedBranch} is checked out in a worktree outside project.allowedWorktreeRoots`);
    }

    const target = path.join(normalizeFsPath(this.project.worktreeRoot), safeWorktreeSlug(requestedBranch));
    if (!this.project.allowedWorktreeRoots.some((root) => isPathInside(root, target))) {
      throw new Error(`Derived worktree path is outside project.allowedWorktreeRoots: ${target}`);
    }
    try {
      await fs.access(target);
      throw new Error(`Worktree target already exists and will not be overwritten: ${target}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const [realWorktreeRoot, realParent] = await Promise.all([
      fs.realpath(normalizeFsPath(this.project.worktreeRoot)),
      fs.realpath(path.dirname(target)),
    ]);
    if (!isPathInside(realWorktreeRoot, realParent)) {
      throw new Error(`Resolved worktree parent escapes project.worktreeRoot: ${realParent}`);
    }

    const local = snapshot.branches.find(({ kind, name }) => kind === "local" && name === requestedBranch);
    if (local) {
      await this.git(["worktree", "add", target, requestedBranch]);
    } else {
      const remoteCandidate = snapshot.branches.find(({ kind, name }) => {
        if (kind !== "remote") return false;
        const separator = name.indexOf("/");
        const remote = separator < 0 ? "" : name.slice(0, separator);
        const remoteBranch = separator < 0 ? name : name.slice(separator + 1);
        return this.project.allowedRemotes.includes(remote) && remoteBranch === requestedBranch;
      });
      const defaultRemoteRef = this.project.allowedRemotes
        .map((remote) => `${remote}/${this.project.defaultBranch}`)
        .find((ref) => snapshot.branches.some(({ kind, name }) => kind === "remote" && name === ref));
      const localDefault = snapshot.branches.some(
        ({ kind, name }) => kind === "local" && name === this.project.defaultBranch,
      ) ? this.project.defaultBranch : undefined;
      const baseRef = requestedStartPoint || remoteCandidate?.name || defaultRemoteRef || localDefault;
      if (!baseRef) throw new Error(`No allowed base ref was found for ${requestedBranch}`);
      await this.git(["worktree", "add", "-b", requestedBranch, target, baseRef]);
    }

    snapshot = await this.refresh();
    const created = snapshot.worktrees.find((worktree) => worktree.branch === requestedBranch);
    if (!created) throw new Error(`Git did not register the new worktree for ${requestedBranch}`);
    return { ...created, created: true };
  }
}
