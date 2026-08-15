import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBranchesMarkdown,
  buildProjectMarkdown,
  buildProjectThreadsMarkdown,
  parseNewCommandArgument,
  parseThreadsCommandArgument,
} from "../../../../../src/experimental/collaboration/commands/project-commands.mjs";

test("project output distinguishes the Bridge boundary from Desktop grouping", () => {
  const markdown = buildProjectMarkdown({
    project: {
      id: "bridge",
      name: "Bridge",
      repoRoot: "C:/repo",
      defaultBranch: "main",
      protectDefaultBranch: true,
      worktreeRoot: "C:/worktrees",
      allowedRemotes: ["origin"],
      desktopProjectId: "desktop-1",
    },
  }, {
    worktrees: [{ path: "C:/repo", branch: "main" }],
  }, {
    id: "thread-1",
    worktree: { path: "C:/repo", branch: "main" },
  }, {
    stateReadable: true,
    registered: true,
    configurationMatches: true,
    projectId: "desktop-1",
    name: "Bridge Desktop",
  });

  assert.match(markdown, /Bridge Project ID/);
  assert.match(markdown, /Codex Desktop Project/);
  assert.match(markdown, /desktop-1/);
  assert.match(markdown, /不是同一层对象/);
  assert.match(markdown, /独立 App Server/);
});

test("parses project-scoped new task arguments without invoking a shell", () => {
  assert.deepEqual(parseNewCommandArgument("修复登录问题"), { topic: "修复登录问题" });
  assert.deepEqual(parseNewCommandArgument("--branch task/LOGIN-123 修复登录问题"), {
    branch: "task/LOGIN-123",
    topic: "修复登录问题",
  });
  assert.deepEqual(parseNewCommandArgument("--branch=task/STORAGE-25 修复存储问题"), {
    branch: "task/STORAGE-25",
    topic: "修复存储问题",
  });
  assert.match(parseNewCommandArgument("--branch").error, /用法/);
});

test("parses optional branch filtering for threads", () => {
  assert.deepEqual(parseThreadsCommandArgument(""), {});
  assert.deepEqual(parseThreadsCommandArgument("branch feature/login"), { branch: "feature/login" });
  assert.match(parseThreadsCommandArgument("feature/login").error, /用法/);
});

test("branch output marks protected and worktree-backed branches", () => {
  const markdown = buildBranchesMarkdown({
    project: { name: "Bridge", defaultBranch: "main", protectDefaultBranch: true, allowedRemotes: ["origin"] },
  }, {
    worktrees: [{ branch: "main", path: "C:/repo" }],
    branches: [
      { kind: "local", name: "main", head: "abc" },
      { kind: "remote", name: "origin/main", head: "abcdef1234567890" },
      { kind: "remote", name: "upstream/main", head: "def" },
    ],
  });
  assert.match(markdown, /默认分支只读/);
  assert.match(markdown, /origin\/main/);
  assert.doesNotMatch(markdown, /upstream\/main/);
});

test("thread output keeps branch and worktree identity visible", () => {
  const markdown = buildProjectThreadsMarkdown([{
    id: "thread-1",
    title: "Login",
    worktree: { branch: "task/login", path: "C:/worktrees/login" },
  }], { branch: "task/login" });
  assert.match(markdown, /thread-1/);
  assert.match(markdown, /task\/login/);
  assert.match(markdown, /login/);
});
