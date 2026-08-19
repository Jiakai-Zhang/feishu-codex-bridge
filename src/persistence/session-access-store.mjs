import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isAbsoluteFsPath, isPathInside, normalizeFsPath, sameFsPath } from "../runtime/shared/fs-paths.mjs";
import { writeJsonAtomic } from "../runtime/shared/private-state.mjs";

const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class SessionAccessStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "SessionAccessStoreError";
    this.code = code;
  }
}

function requiredOpenId(value, field) {
  const openId = String(value || "").trim();
  if (!OPEN_ID.test(openId)) throw new TypeError(`${field} must be a valid Feishu open_id`);
  return openId;
}

export function normalizeDirectoryName(value, field = "directoryName") {
  const name = String(value || "").trim();
  if (!name || name.length > 64) throw new TypeError(`${field} must contain 1-64 characters`);
  if (name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw new TypeError(`${field} must be one safe directory name`);
  }
  if (/[. ]$/.test(name) || WINDOWS_RESERVED.test(name)) {
    throw new TypeError(`${field} is not a safe Windows directory name`);
  }
  return name;
}

function normalizeDisplayName(value) {
  const name = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return name ? name.slice(0, 100) : undefined;
}

function normalizeProject(record, usersById) {
  if (!record || typeof record !== "object") throw new TypeError("Bridge Project record must be an object");
  const id = String(record.id || "").trim();
  const name = normalizeDisplayName(record.name);
  const rootPath = String(record.rootPath || "").trim();
  const ownerOpenId = requiredOpenId(record.ownerOpenId, "project.ownerOpenId");
  if (!id || !name || !rootPath || !isAbsoluteFsPath(rootPath)) {
    throw new TypeError("Bridge Project requires id, name, and an absolute rootPath");
  }
  if (!usersById.has(ownerOpenId)) throw new TypeError("Bridge Project owner is not registered");
  return {
    id,
    name,
    rootPath: normalizeFsPath(rootPath),
    ownerOpenId,
    createdAt: Number(record.createdAt) || Date.now(),
  };
}

function normalizeState(raw, ownerOpenId) {
  const ownerId = requiredOpenId(ownerOpenId, "ownerOpenId");
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawProjectRoot = input.projectRoot == null ? "" : String(input.projectRoot).trim();
  if (rawProjectRoot && !isAbsoluteFsPath(rawProjectRoot)) throw new TypeError("projectRoot must be absolute");
  const projectRoot = rawProjectRoot ? normalizeFsPath(rawProjectRoot) : undefined;

  const users = [];
  const usersById = new Map();
  for (const item of Array.isArray(input.users) ? input.users : []) {
    const openId = requiredOpenId(item?.openId, "user.openId");
    if (usersById.has(openId)) throw new TypeError("Session access users must have unique open_ids");
    const role = openId === ownerId ? "owner" : "member";
    const directoryName = item?.directoryName == null || String(item.directoryName).trim() === ""
      ? undefined
      : normalizeDirectoryName(item.directoryName, "user.directoryName");
    const user = {
      openId,
      role,
      status: item?.status === "inactive" ? "inactive" : "active",
      directoryName,
      displayName: normalizeDisplayName(item?.displayName),
      createdAt: Number(item?.createdAt) || Date.now(),
    };
    users.push(user);
    usersById.set(openId, user);
  }
  if (!usersById.has(ownerId)) {
    const owner = {
      openId: ownerId,
      role: "owner",
      status: "active",
      directoryName: undefined,
      displayName: undefined,
      createdAt: Date.now(),
    };
    users.unshift(owner);
    usersById.set(ownerId, owner);
  }
  const owner = usersById.get(ownerId);
  owner.role = "owner";
  owner.status = "active";

  const directoryOwners = new Map();
  for (const user of users) {
    if (!user.directoryName) continue;
    const key = user.directoryName.toLocaleLowerCase("en-US");
    if (directoryOwners.has(key)) throw new TypeError("Session access directories must be unique");
    directoryOwners.set(key, user.openId);
  }

  const projects = (Array.isArray(input.projects) ? input.projects : [])
    .map((project) => normalizeProject(project, usersById));
  if (new Set(projects.map(({ id }) => id)).size !== projects.length) {
    throw new TypeError("Bridge Project ids must be unique");
  }
  if (projectRoot) {
    for (const project of projects) {
      const projectOwner = usersById.get(project.ownerOpenId);
      if (!projectOwner?.directoryName) {
        throw new TypeError("Bridge Project owner requires a personal directory");
      }
      const ownerRoot = normalizeFsPath(path.join(projectRoot, projectOwner.directoryName));
      if (!isPathInside(ownerRoot, project.rootPath, { allowEqual: false })) {
        throw new TypeError("Bridge Project must remain inside its owner's personal directory");
      }
    }
  }

  return {
    schemaVersion: 1,
    projectRoot,
    users,
    projects,
  };
}

function cloneState(state) {
  return structuredClone(state);
}

async function ensurePlainDirectory(directoryPath, { allowNonEmpty }) {
  let created = false;
  try {
    await fs.mkdir(directoryPath, { recursive: false });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SessionAccessStoreError("member_directory_unsafe", "The assigned member path is not a plain directory");
  }
  if (!created && !allowNonEmpty) {
    const entries = await fs.readdir(directoryPath);
    if (entries.length > 0) {
      throw new SessionAccessStoreError("member_directory_not_empty", "The assigned member directory must be empty");
    }
  }
  return normalizeFsPath(await fs.realpath(directoryPath));
}

export class SessionAccessStore {
  constructor(filePath, ownerOpenId, state) {
    this.filePath = filePath;
    this.ownerOpenId = requiredOpenId(ownerOpenId, "ownerOpenId");
    this.state = normalizeState(state, this.ownerOpenId);
    this.tail = Promise.resolve();
  }

  static async open(filePath, { ownerOpenId }) {
    let raw;
    try { raw = JSON.parse(await fs.readFile(filePath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      raw = undefined;
    }
    return new SessionAccessStore(filePath, ownerOpenId, raw);
  }

  snapshot() {
    return Object.freeze(cloneState(this.state));
  }

  isConfigured() {
    return Boolean(this.state.projectRoot && this.state.users.find(({ openId }) => openId === this.ownerOpenId)?.directoryName);
  }

  listActiveUsers() {
    return this.state.users.filter(({ status }) => status === "active").map((user) => ({ ...user }));
  }

  getUser(openId) {
    const user = this.state.users.find((item) => item.openId === String(openId));
    return user ? Object.freeze({ ...user }) : undefined;
  }

  isActive(openId) {
    return this.getUser(openId)?.status === "active";
  }

  getUserRoot(openId) {
    const user = this.getUser(openId);
    if (!this.state.projectRoot || !user?.directoryName || user.status !== "active") return undefined;
    const root = normalizeFsPath(path.join(this.state.projectRoot, user.directoryName));
    return isPathInside(this.state.projectRoot, root) ? root : undefined;
  }

  listProjects() {
    return this.state.projects.map((project) => ({ ...project, rootPaths: [project.rootPath], source: "bridge" }));
  }

  #serialize(work) {
    const running = this.tail.catch(() => {}).then(work);
    this.tail = running.catch(() => {});
    return running;
  }

  async #persist(next) {
    const normalized = normalizeState(next, this.ownerOpenId);
    await writeJsonAtomic(this.filePath, normalized);
    this.state = normalized;
    return this.snapshot();
  }

  configureProjectRoot({ projectRoot, ownerDirectoryName }) {
    return this.#serialize(async () => {
      const requestedRoot = String(projectRoot || "").trim();
      if (!isAbsoluteFsPath(requestedRoot)) {
        throw new SessionAccessStoreError("project_root_invalid", "The Project root must be an absolute path");
      }
      await fs.mkdir(requestedRoot, { recursive: true });
      const rootStat = await fs.lstat(requestedRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new SessionAccessStoreError("project_root_unsafe", "The Project root must be a plain directory");
      }
      const canonicalRoot = normalizeFsPath(await fs.realpath(requestedRoot));
      const directoryName = normalizeDirectoryName(ownerDirectoryName, "ownerDirectoryName");
      if (this.isConfigured()) {
        const currentOwner = this.getUser(this.ownerOpenId);
        if (!sameFsPath(this.state.projectRoot, canonicalRoot) ||
            currentOwner.directoryName.toLocaleLowerCase("en-US") !== directoryName.toLocaleLowerCase("en-US")) {
          throw new SessionAccessStoreError(
            "project_root_immutable",
            "An active multi-user Project root cannot be reassigned automatically",
          );
        }
      }
      const ownerPath = path.join(canonicalRoot, directoryName);
      const canonicalOwnerPath = await ensurePlainDirectory(ownerPath, { allowNonEmpty: true });
      if (!isPathInside(canonicalRoot, canonicalOwnerPath)) {
        throw new SessionAccessStoreError("project_root_escape", "The owner directory escapes the configured Project root");
      }
      const next = cloneState(this.state);
      next.projectRoot = canonicalRoot;
      next.users = next.users.map((user) => user.openId === this.ownerOpenId
        ? { ...user, directoryName }
        : user);
      return this.#persist(next);
    });
  }

  addMember({ openId, directoryName, displayName }) {
    return this.#serialize(async () => {
      const memberOpenId = requiredOpenId(openId, "member.openId");
      if (memberOpenId === this.ownerOpenId) {
        throw new SessionAccessStoreError("member_is_owner", "The Bridge owner is already registered");
      }
      if (!this.isConfigured()) {
        throw new SessionAccessStoreError("project_root_missing", "Configure the Bridge Project root before adding members");
      }
      const safeDirectory = normalizeDirectoryName(directoryName, "member.directoryName");
      const conflicting = this.state.users.find((user) => (
        user.openId !== memberOpenId && user.directoryName?.toLocaleLowerCase("en-US") === safeDirectory.toLocaleLowerCase("en-US")
      ));
      if (conflicting) {
        throw new SessionAccessStoreError("member_directory_conflict", "The member directory name is already assigned");
      }
      const existing = this.state.users.find(({ openId: id }) => id === memberOpenId);
      if (existing?.directoryName && existing.directoryName.toLocaleLowerCase("en-US") !== safeDirectory.toLocaleLowerCase("en-US")) {
        throw new SessionAccessStoreError("member_directory_immutable", "An existing member directory cannot be reassigned automatically");
      }
      const memberPath = path.join(this.state.projectRoot, safeDirectory);
      const canonicalMemberPath = await ensurePlainDirectory(memberPath, { allowNonEmpty: Boolean(existing) });
      if (!isPathInside(this.state.projectRoot, canonicalMemberPath)) {
        throw new SessionAccessStoreError("member_directory_escape", "The member directory escapes the configured Project root");
      }
      const next = cloneState(this.state);
      const replacement = {
        openId: memberOpenId,
        role: "member",
        status: "active",
        directoryName: safeDirectory,
        displayName: normalizeDisplayName(displayName) || existing?.displayName,
        createdAt: existing?.createdAt || Date.now(),
      };
      const index = next.users.findIndex(({ openId: id }) => id === memberOpenId);
      if (index >= 0) next.users[index] = replacement;
      else next.users.push(replacement);
      await this.#persist(next);
      return Object.freeze({ ...replacement });
    });
  }

  deactivateMember(openId) {
    return this.#serialize(async () => {
      const memberOpenId = requiredOpenId(openId, "member.openId");
      if (memberOpenId === this.ownerOpenId) {
        throw new SessionAccessStoreError("member_is_owner", "The Bridge owner cannot be deactivated");
      }
      const next = cloneState(this.state);
      const index = next.users.findIndex(({ openId: id }) => id === memberOpenId);
      if (index < 0) throw new SessionAccessStoreError("member_not_found", "The member is not registered");
      next.users[index] = { ...next.users[index], status: "inactive" };
      await this.#persist(next);
      return Object.freeze({ ...next.users[index] });
    });
  }

  createProject({ ownerOpenId, name }) {
    return this.#serialize(async () => {
      const ownerId = requiredOpenId(ownerOpenId, "project.ownerOpenId");
      const userRoot = this.getUserRoot(ownerId);
      if (!userRoot) throw new SessionAccessStoreError("member_root_unavailable", "The user has no active Project directory");
      const projectName = normalizeDirectoryName(name, "project.name");
      const projectPath = path.join(userRoot, projectName);
      let canonicalProjectPath;
      try {
        await fs.mkdir(projectPath, { recursive: false });
        const projectStat = await fs.lstat(projectPath);
        if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
          throw new SessionAccessStoreError("project_directory_unsafe", "The Project path is not a plain directory");
        }
        canonicalProjectPath = normalizeFsPath(await fs.realpath(projectPath));
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new SessionAccessStoreError("project_directory_exists", "The Project directory already exists", { cause: error });
        }
        throw error;
      }
      if (!isPathInside(userRoot, canonicalProjectPath, { allowEqual: false })) {
        throw new SessionAccessStoreError("project_directory_escape", "The Project directory escapes the user's root");
      }
      if (this.state.projects.some((project) => normalizeFsPath(project.rootPath).toLocaleLowerCase("en-US") === canonicalProjectPath.toLocaleLowerCase("en-US"))) {
        throw new SessionAccessStoreError("project_directory_conflict", "The Project directory is already registered");
      }
      const project = {
        id: `bridge-${randomUUID()}`,
        name: projectName,
        rootPath: canonicalProjectPath,
        ownerOpenId: ownerId,
        createdAt: Date.now(),
      };
      const next = cloneState(this.state);
      next.projects.push(project);
      try {
        await this.#persist(next);
      } catch (error) {
        await fs.rmdir(canonicalProjectPath).catch(() => {});
        throw error;
      }
      return Object.freeze({ ...project, rootPaths: [project.rootPath], source: "bridge" });
    });
  }
}
