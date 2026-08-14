import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { normalizeCodexCwd } from "./codex-session-store.mjs";

const execFile = promisify(nodeExecFile);

function cleanLabel(value, fallback = "未命名任务") {
  const label = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label || fallback;
}

function componentLabel(value, fallback) {
  return cleanLabel(value, fallback).replace(/[\\/]+/g, "／");
}

export function buildSessionGroupName(projectName, sessionTitle, { maxChars = 60 } = {}) {
  let prefix = componentLabel(projectName, "独立");
  let title = componentLabel(sessionTitle, "未命名任务");
  if (title.startsWith(`${prefix}／`)) title = title.slice(prefix.length + 1) || "未命名任务";
  if (prefix.length > 24) prefix = `${prefix.slice(0, 23)}…`;
  const room = Math.max(1, maxChars - prefix.length - 1);
  if (title.length > room) title = room === 1 ? "…" : `${title.slice(0, room - 1)}…`;
  return `${prefix}/${title}`;
}

export function displaySessionTitle(value, { maxChars = 80 } = {}) {
  const title = cleanLabel(value);
  return title.length <= maxChars ? title : `${title.slice(0, maxChars - 1)}…`;
}

export async function readIndexedThreadNames(indexPath, { readFile = fs.readFile } = {}) {
  let text;
  try { text = await readFile(indexPath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const names = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record?.id === "string" && typeof record?.thread_name === "string" && record.thread_name.trim()) {
        names.set(record.id, cleanLabel(record.thread_name));
      }
    } catch {}
  }
  return names;
}

function localProjects(state) {
  const raw = state?.["local-projects"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const byId = new Map();
  for (const project of Object.values(raw)) {
    if (!project || typeof project !== "object" || typeof project.id !== "string") continue;
    const rootPaths = Array.isArray(project.rootPaths)
      ? project.rootPaths.filter((root) => typeof root === "string" && root.trim()).map(normalizeCodexCwd)
      : [];
    byId.set(project.id, Object.freeze({
      id: project.id,
      name: cleanLabel(project.name, "未命名 Project"),
      rootPaths: Object.freeze(rootPaths),
    }));
  }
  const order = Array.isArray(state?.["project-order"]) ? state["project-order"] : [];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...byId.values()].sort((left, right) => {
    const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.name.localeCompare(right.name, "zh-CN");
  });
}

function canonicalFsPath(value) {
  const normalized = normalizeCodexCwd(value).trim();
  if (!normalized) return "";
  const resolved = path.resolve(normalized);
  const root = path.parse(resolved).root;
  return (resolved.length > root.length ? resolved.replace(/[\\/]+$/g, "") : resolved).toLowerCase();
}

function pathScopeScore(candidate, root) {
  if (!candidate || !root) return -1;
  if (candidate === root) return root.length;
  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
    ? root.length
    : -1;
}

async function readGitWorktrees(root) {
  try {
    const { stdout } = await execFile("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      timeout: 2_000,
    });
    return String(stdout || "")
      .split(/\0|\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  } catch {
    return [];
  }
}

async function buildProjectScopes(projects, listProjectWorktrees) {
  return Promise.all(projects.map(async (project) => {
    const discovered = await Promise.all(project.rootPaths.map(async (root) => {
      try {
        const worktrees = await listProjectWorktrees(root);
        return Array.isArray(worktrees) ? worktrees : [];
      } catch {
        return [];
      }
    }));
    const roots = new Set([...project.rootPaths, ...discovered.flat()]
      .map(canonicalFsPath)
      .filter(Boolean));
    return Object.freeze({ project, roots: Object.freeze([...roots]) });
  }));
}

function inferProjectFromCwd(cwd, scopes) {
  const candidate = canonicalFsPath(cwd);
  let bestScore = -1;
  let bestProject;
  let ambiguous = false;
  for (const scope of scopes) {
    const score = Math.max(-1, ...scope.roots.map((root) => pathScopeScore(candidate, root)));
    if (score < 0) continue;
    if (score > bestScore) {
      bestScore = score;
      bestProject = scope.project;
      ambiguous = false;
    } else if (score === bestScore && bestProject?.id !== scope.project.id) {
      ambiguous = true;
    }
  }
  return ambiguous ? undefined : bestProject;
}

function readLiveThreads(stateDbPath) {
  const db = new DatabaseSync(stateDbPath, { readOnly: true });
  try {
    return db.prepare(
      `select id, name, title, preview, cwd, updated_at, updated_at_ms, recency_at, recency_at_ms
       from threads
       where archived = 0 and coalesce(thread_source, 'user') = 'user'
       order by coalesce(recency_at_ms, updated_at_ms, recency_at * 1000, updated_at * 1000, 0) desc`,
    ).all();
  } finally {
    db.close();
  }
}

function threadRecencyMs(thread) {
  for (const value of [thread.recency_at_ms, thread.updated_at_ms]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  for (const value of [thread.recency_at, thread.updated_at]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number * 1000;
  }
  return 0;
}

export class CodexDesktopCatalog {
  constructor({
    codexHome = path.join(os.homedir(), ".codex"),
    globalStatePath = path.join(codexHome, ".codex-global-state.json"),
    stateDbPath = path.join(codexHome, "state_5.sqlite"),
    sessionIndexPath = path.join(codexHome, "session_index.jsonl"),
    readFile = fs.readFile,
    readThreads = readLiveThreads,
    listProjectWorktrees = readGitWorktrees,
  } = {}) {
    this.globalStatePath = globalStatePath;
    this.stateDbPath = stateDbPath;
    this.sessionIndexPath = sessionIndexPath;
    this.readFile = readFile;
    this.readThreads = readThreads;
    this.listProjectWorktrees = listProjectWorktrees;
  }

  async load({ bindings = [] } = {}) {
    const [stateText, indexedNames] = await Promise.all([
      this.readFile(this.globalStatePath, "utf8"),
      readIndexedThreadNames(this.sessionIndexPath, { readFile: this.readFile }),
    ]);
    const state = JSON.parse(stateText);
    const projects = localProjects(state);
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const projectScopes = await buildProjectScopes(projects, this.listProjectWorktrees);
    const assignments = state?.["thread-project-assignments"] || {};
    const projectless = new Set(Array.isArray(state?.["projectless-thread-ids"])
      ? state["projectless-thread-ids"]
      : []);
    const bindingsByThread = new Map(bindings.map((binding) => [binding.threadId, binding]));
    const sessionsByProject = new Map(projects.map((project) => [project.id, []]));
    const independent = [];
    const sessionsById = new Map();

    for (const thread of this.readThreads(this.stateDbPath)) {
      const title = cleanLabel(
        indexedNames.get(thread.id) || thread.name || thread.preview || thread.title,
      );
      const assignment = assignments?.[thread.id];
      let project = assignment?.projectKind === "local"
        ? projectsById.get(assignment.projectId)
        : undefined;
      let kind;
      if (project) kind = "project";
      else if (projectless.has(thread.id)) kind = "independent";
      else if (!assignment) {
        project = inferProjectFromCwd(thread.cwd, projectScopes);
        if (project) kind = "project";
        else continue;
      }
      else continue;
      const session = Object.freeze({
        id: thread.id,
        title,
        displayTitle: displaySessionTitle(title),
        cwd: normalizeCodexCwd(thread.cwd),
        updatedAtMs: threadRecencyMs(thread),
        kind,
        projectId: project?.id,
        projectName: project?.name,
        binding: bindingsByThread.get(thread.id),
      });
      sessionsById.set(session.id, session);
      if (project) sessionsByProject.get(project.id).push(session);
      else independent.push(session);
    }

    const projectEntries = projects.map((project) => Object.freeze({
      ...project,
      sessions: Object.freeze(sessionsByProject.get(project.id)),
    }));
    return Object.freeze({
      projects: Object.freeze(projectEntries),
      independent: Object.freeze(independent),
      sessionsById,
    });
  }
}
