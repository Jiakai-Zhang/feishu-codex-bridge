#!/usr/bin/env node
import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const RECEIVE_MODES = new Set(["manual", "recommend", "auto"]);
const GIT_SYNC_MODES = new Set(["push", "reference"]);
const RESULT_MODES = new Set(["notify", "resume"]);

function fail(message, code = 1) {
  process.stdout.write(`${JSON.stringify({ ok: false, status: "error", error: message })}\n`);
  process.exitCode = code;
}

function parseArgs(argv) {
  const parsed = { cwd: process.cwd(), waitMs: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--cwd") parsed.cwd = argv[++index];
    else if (argv[index] === "--wait-ms") parsed.waitMs = Number(argv[++index]);
    else throw new TypeError(`Unknown argument: ${argv[index]}`);
  }
  parsed.cwd = path.resolve(String(parsed.cwd || process.cwd()));
  if (!Number.isFinite(parsed.waitMs) || parsed.waitMs < 0 || parsed.waitMs > 60_000) {
    throw new TypeError("--wait-ms must be between 0 and 60000");
  }
  return parsed;
}

async function readStdin(maxBytes = 64_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new TypeError("Request input is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new TypeError("A JSON request is required on stdin");
  return JSON.parse(text);
}

function requiredId(value, field) {
  const normalized = String(value || "").trim();
  if (!AGENT_ID.test(normalized)) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function canonicalGitHubRepository(value) {
  let candidate = String(value || "").trim();
  const scpMatch = candidate.match(/^git@github\.com:(.+)$/i);
  if (scpMatch) candidate = scpMatch[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    let parsed;
    try { parsed = new URL(candidate); }
    catch { throw new TypeError("Git remote URL is invalid"); }
    if (parsed.hostname.toLowerCase() !== "github.com") throw new TypeError("Only github.com repositories are supported");
    candidate = parsed.pathname;
  }
  candidate = candidate.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) {
    throw new TypeError("GitHub repository must be owner/name");
  }
  if (candidate.split("/").some((component) => component === "." || component === "..")) {
    throw new TypeError("GitHub repository must not contain dot path components");
  }
  return candidate.toLowerCase();
}

function validateInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Request must be a JSON object");
  const peerAgentId = requiredId(raw.peerAgentId, "peerAgentId");
  const title = String(raw.title || "").trim();
  const prompt = String(raw.prompt || "").trim();
  const receiveMode = String(raw.receiveMode || "recommend").trim();
  const gitSyncMode = String(raw.gitSyncMode || "push").trim();
  const resultMode = String(raw.resultMode || "notify").trim();
  if (!title || title.length > 160) throw new TypeError("title must contain 1-160 characters");
  if (!prompt || prompt.length > 12_000) throw new TypeError("prompt must contain 1-12000 characters");
  if (!RECEIVE_MODES.has(receiveMode)) throw new TypeError("receiveMode must be manual, recommend, or auto");
  if (!GIT_SYNC_MODES.has(gitSyncMode)) throw new TypeError("gitSyncMode must be push or reference");
  if (!RESULT_MODES.has(resultMode)) throw new TypeError("resultMode must be notify or resume");
  return { peerAgentId, title, prompt, receiveMode, gitSyncMode, resultMode };
}

async function git(args, cwd) {
  const result = await execFile("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  return String(result.stdout ?? result).trim();
}

async function inspectRepository(cwd) {
  const [topLevel, commonDirText, branch, head, status] = await Promise.all([
    git(["rev-parse", "--show-toplevel"], cwd),
    git(["rev-parse", "--git-common-dir"], cwd),
    git(["branch", "--show-current"], cwd),
    git(["rev-parse", "HEAD"], cwd),
    git(["status", "--porcelain=v1", "--untracked-files=normal"], cwd),
  ]);
  if (!branch) throw new Error("Detached HEAD cannot be delegated");
  if (status) throw new Error("The worktree is dirty; commit only the intended handoff changes before delegating");
  const commonDir = path.resolve(cwd, commonDirText);
  return {
    topLevel: path.resolve(topLevel),
    commonDir,
    branch,
    head: head.toLowerCase(),
  };
}

async function loadRegistration(repository) {
  const candidates = [
    path.join(repository.commonDir, "feishu-codex-bridge", "collaboration.json"),
    path.join(repository.topLevel, ".agent", "collaboration.json"),
  ];
  let raw;
  let registrationPath;
  for (const candidate of candidates) {
    try {
      raw = JSON.parse(await fs.readFile(candidate, "utf8"));
      registrationPath = candidate;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Cannot read ${candidate}: ${error.message}`);
    }
  }
  if (!raw) throw new Error("This Project is not registered with a Feishu collaboration group");
  if (raw.schemaVersion !== 1) throw new TypeError("Unsupported Project collaboration registration");
  if (raw.enabled !== true) throw new Error("Collaboration is disabled for this Project");
  const groupChatId = String(raw.groupChatId || "").trim();
  if (!CHAT_ID.test(groupChatId)) throw new TypeError("groupChatId is invalid");
  const inboxValue = String(raw.inboxPath || "").trim();
  if (!inboxValue || !path.isAbsolute(inboxValue)) throw new TypeError("inboxPath must be absolute");
  const remote = String(raw.remote || "origin").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new TypeError("remote is invalid");
  return {
    registrationPath,
    agentId: requiredId(raw.agentId, "agentId"),
    projectId: requiredId(raw.projectId, "projectId"),
    groupChatId,
    githubRepository: canonicalGitHubRepository(raw.githubRepository),
    remote,
    inboxPath: path.resolve(inboxValue),
  };
}

async function verifyRemote(repository, registration) {
  const url = await git(["remote", "get-url", registration.remote], repository.topLevel);
  const actual = canonicalGitHubRepository(url);
  if (actual !== registration.githubRepository) {
    throw new Error(`Configured GitHub repository does not match remote ${registration.remote}`);
  }
}

async function writeAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
  await fs.rename(tempPath, filePath);
}

async function waitForResult(resultPath, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    try { return JSON.parse(await fs.readFile(resultPath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const [input, repository] = await Promise.all([readStdin(), inspectRepository(options.cwd)]);
  const [action, registration] = await Promise.all([
    Promise.resolve(validateInput(input)),
    loadRegistration(repository),
  ]);
  if (action.peerAgentId === registration.agentId) throw new Error("Cannot delegate to the local Agent");
  await verifyRemote(repository, registration);
  const uuid = randomUUID();
  const requestId = `req:${uuid}`;
  const now = Date.now();
  const request = {
    schemaVersion: 1,
    requestId,
    createdAt: now,
    expiresAt: now + 15 * 60_000,
    source: {
      agentId: registration.agentId,
      projectId: registration.projectId,
      groupChatId: registration.groupChatId,
      githubRepository: registration.githubRepository,
      cwd: options.cwd,
      threadId: process.env.CODEX_THREAD_ID || undefined,
      remote: registration.remote,
      branch: repository.branch,
      head: repository.head,
    },
    action: { type: "delegate", ...action },
  };
  const incomingPath = path.join(registration.inboxPath, "incoming", `req_${uuid}.json`);
  const resultPath = path.join(registration.inboxPath, "results", `req_${uuid}.json`);
  await writeAtomic(incomingPath, request);
  const result = options.waitMs ? await waitForResult(resultPath, options.waitMs) : undefined;
  process.stdout.write(`${JSON.stringify(result || { ok: true, status: "queued", requestId })}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
