import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", ".agents", "skills", "feishu-agent-collaboration", "scripts", "delegate.mjs",
);

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
  return String(result.stdout || "").trim();
}

function runDelegate(cwd, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "--cwd", cwd], {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("Project skill queues a repository-bound request through git-common-dir registration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-collab-skill-"));
  const repo = path.join(root, "repo");
  const inbox = path.join(root, "inbox");
  try {
    await fs.mkdir(repo);
    await git(repo, ["init", "-b", "task/handoff"]);
    await git(repo, ["config", "user.email", "skill@example.invalid"]);
    await git(repo, ["config", "user.name", "Skill Test"]);
    await fs.writeFile(path.join(repo, "README.md"), "clean\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await git(repo, ["remote", "add", "origin", "https://github.com/Example/Shared.git"]);
    const commonDir = path.resolve(repo, await git(repo, ["rev-parse", "--git-common-dir"]));
    const registrationPath = path.join(commonDir, "feishu-codex-bridge", "collaboration.json");
    await fs.mkdir(path.dirname(registrationPath), { recursive: true });
    await fs.writeFile(registrationPath, JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      agentId: "local-codex",
      projectId: "local-project",
      groupChatId: "oc_team",
      githubRepository: "example/shared",
      remote: "origin",
      inboxPath: inbox,
    }), "utf8");

    const result = await runDelegate(repo, {
      peerAgentId: "alice-codex",
      title: "Review routing",
      prompt: "Review routing and run tests.",
      receiveMode: "recommend",
      gitSyncMode: "push",
      resultMode: "resume",
    }, { CODEX_THREAD_ID: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294" });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "queued");
    const files = await fs.readdir(path.join(inbox, "incoming"));
    assert.equal(files.length, 1);
    const request = JSON.parse(await fs.readFile(path.join(inbox, "incoming", files[0]), "utf8"));
    assert.equal(request.source.projectId, "local-project");
    assert.equal(request.source.githubRepository, "example/shared");
    assert.equal(request.source.branch, "task/handoff");
    assert.equal(request.source.threadId, "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294");
    assert.equal(request.action.peerAgentId, "alice-codex");
    assert.equal("appSecret" in request, false);

    await fs.writeFile(path.join(repo, "dirty.txt"), "dirty\n");
    const blocked = await runDelegate(repo, {
      peerAgentId: "alice-codex",
      title: "Dirty",
      prompt: "Must not be queued.",
    });
    assert.notEqual(blocked.code, 0);
    assert.match(JSON.parse(blocked.stdout).error, /dirty/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
