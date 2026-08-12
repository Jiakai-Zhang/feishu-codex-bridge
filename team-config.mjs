import { promises as fs } from "node:fs";
import path from "node:path";

const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function positiveNumber(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function pathInside(basePath, candidatePath) {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRepository(repository, configDir) {
  const id = requiredString(repository?.id, "repositories[].id");
  if (!AGENT_ID.test(id)) throw new TypeError(`Invalid repository id: ${id}`);
  const configuredPath = requiredString(repository?.path, `repositories[${id}].path`);
  return {
    id,
    path: path.resolve(configDir, configuredPath),
    defaultBranch: String(repository.defaultBranch || "main").trim(),
    writeMode: repository.writeMode === "checkout" ? "checkout" : "worktree",
  };
}

function normalizeProject(rawProject, { workspace, configDir, agentId }) {
  const project = rawProject || {};
  const id = String(project.id || agentId || "default").trim();
  if (!AGENT_ID.test(id)) throw new TypeError(`Invalid project id: ${id}`);
  const repoRoot = path.resolve(configDir, String(project.repoRoot || workspace));
  const allowedWorktreeRoots = uniqueStrings([
    repoRoot,
    ...(project.allowedWorktreeRoots || []),
  ]).map((root) => path.resolve(configDir, root));
  const worktreeRoot = project.worktreeRoot
    ? path.resolve(configDir, String(project.worktreeRoot))
    : allowedWorktreeRoots.find((root) => root.toLowerCase() !== repoRoot.toLowerCase());
  const allowedRemotes = uniqueStrings(project.allowedRemotes || ["origin"]);
  if (allowedRemotes.length === 0) throw new TypeError("project.allowedRemotes must contain at least one remote name");
  if (worktreeRoot && !allowedWorktreeRoots.some((root) => pathInside(root, worktreeRoot))) {
    throw new TypeError("project.worktreeRoot must be inside project.allowedWorktreeRoots");
  }
  const desktopProjectId = project.desktopProjectId === undefined
    ? undefined
    : requiredString(project.desktopProjectId, "project.desktopProjectId");
  if (desktopProjectId && desktopProjectId.length > 160) {
    throw new TypeError("project.desktopProjectId is too long");
  }
  return {
    id,
    name: String(project.name || id).trim(),
    desktopProjectId,
    desktopProjectName: project.desktopProjectName
      ? String(project.desktopProjectName).trim()
      : undefined,
    repoRoot,
    worktreeRoot,
    allowedWorktreeRoots,
    defaultBranch: String(project.defaultBranch || "main").trim(),
    protectDefaultBranch: project.protectDefaultBranch !== false,
    allowedRemotes,
  };
}

function normalizePeer(peer) {
  const agentId = requiredString(peer?.agentId, "collaboration.trustedPeers[].agentId");
  if (!AGENT_ID.test(agentId)) throw new TypeError(`Invalid peer agent id: ${agentId}`);
  const botOpenId = requiredString(peer?.botOpenId, `trusted peer ${agentId} botOpenId`);
  if (!OPEN_ID.test(botOpenId)) throw new TypeError(`Invalid peer bot open_id: ${botOpenId}`);
  const allowedProjectIds = uniqueStrings(peer.allowedProjectIds || peer.allowedRepoIds);
  for (const projectId of allowedProjectIds) {
    if (!AGENT_ID.test(projectId)) throw new TypeError(`Invalid allowed project id for peer ${agentId}: ${projectId}`);
  }
  return {
    agentId,
    botOpenId,
    displayName: String(peer.displayName || agentId).trim(),
    enabled: peer.enabled !== false,
    allowedProjectIds,
  };
}

export function normalizeBridgeConfig(raw, { configDir = process.cwd() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Bridge config must be a JSON object");
  }

  const workspace = path.resolve(configDir, requiredString(raw.workspace, "workspace"));
  const ownerOpenId = requiredString(raw.agent?.ownerOpenId || raw.allowedSenderOpenId, "agent.ownerOpenId");
  if (!OPEN_ID.test(ownerOpenId)) throw new TypeError(`Invalid owner open_id: ${ownerOpenId}`);

  const agentId = String(raw.agent?.id || "local-codex").trim();
  if (!AGENT_ID.test(agentId)) throw new TypeError(`Invalid agent id: ${agentId}`);
  const allowedHumanOpenIds = uniqueStrings([
    ownerOpenId,
    ...(raw.agent?.allowedHumanOpenIds || []),
  ]);
  for (const openId of allowedHumanOpenIds) {
    if (!OPEN_ID.test(openId)) throw new TypeError(`Invalid allowed human open_id: ${openId}`);
  }

  const project = normalizeProject(raw.project, { workspace, configDir, agentId });
  const legacyRepository = raw.repositories === undefined
    ? [{ id: project.id, path: project.repoRoot, defaultBranch: project.defaultBranch, writeMode: "worktree" }]
    : raw.repositories;
  if (!Array.isArray(legacyRepository) || legacyRepository.length === 0) {
    throw new TypeError("repositories must contain at least one repository");
  }
  const repositories = legacyRepository.map((repository) => normalizeRepository(repository, configDir));
  if (new Set(repositories.map(({ id }) => id)).size !== repositories.length) {
    throw new TypeError("Repository ids must be unique");
  }

  const collaborationEnabled = raw.collaboration?.enabled === true;
  const groupChatIds = uniqueStrings(raw.collaboration?.groupChatIds);
  for (const chatId of groupChatIds) {
    if (!CHAT_ID.test(chatId)) throw new TypeError(`Invalid collaboration group chat_id: ${chatId}`);
  }
  const trustedPeers = (raw.collaboration?.trustedPeers || []).map(normalizePeer);
  if (new Set(trustedPeers.map(({ agentId }) => agentId)).size !== trustedPeers.length) {
    throw new TypeError("Trusted peer agent ids must be unique");
  }
  if (new Set(trustedPeers.map(({ botOpenId }) => botOpenId)).size !== trustedPeers.length) {
    throw new TypeError("Trusted peer bot open_ids must be unique");
  }

  const botOpenId = raw.agent?.botOpenId ? String(raw.agent.botOpenId).trim() : undefined;
  if (botOpenId && !OPEN_ID.test(botOpenId)) throw new TypeError(`Invalid agent bot open_id: ${botOpenId}`);
  if (collaborationEnabled && !botOpenId) {
    throw new TypeError("agent.botOpenId is required when collaboration is enabled");
  }
  if (collaborationEnabled && groupChatIds.length === 0) {
    throw new TypeError("At least one collaboration.groupChatIds entry is required when collaboration is enabled");
  }
  if (collaborationEnabled && trustedPeers.some((peer) => peer.enabled && peer.allowedProjectIds.length === 0)) {
    throw new TypeError("Every enabled trusted peer must declare collaboration.trustedPeers[].allowedProjectIds");
  }
  if (trustedPeers.some((peer) => peer.agentId === agentId)) {
    throw new TypeError("A trusted peer cannot reuse the local agent id");
  }
  if (botOpenId && trustedPeers.some((peer) => peer.botOpenId === botOpenId)) {
    throw new TypeError("A trusted peer cannot reuse the local bot open_id");
  }
  const approverOpenIds = uniqueStrings(raw.collaboration?.approverOpenIds || [ownerOpenId]);
  for (const openId of approverOpenIds) {
    if (!allowedHumanOpenIds.includes(openId)) {
      throw new TypeError("collaboration.approverOpenIds must be a subset of agent.allowedHumanOpenIds");
    }
  }
  const defaultGroupChatId = raw.collaboration?.defaultGroupChatId
    ? requiredString(raw.collaboration.defaultGroupChatId, "collaboration.defaultGroupChatId")
    : groupChatIds[0];
  if (defaultGroupChatId && !groupChatIds.includes(defaultGroupChatId)) {
    throw new TypeError("collaboration.defaultGroupChatId must be listed in collaboration.groupChatIds");
  }

  const teamHubEnabled = raw.teamHub?.enabled === true;
  const teamHubPath = raw.teamHub?.path
    ? path.resolve(configDir, String(raw.teamHub.path))
    : undefined;
  if (teamHubEnabled && !teamHubPath) throw new TypeError("teamHub.path is required when teamHub is enabled");
  const teamHubWriterOpenIds = uniqueStrings(raw.teamHub?.writerOpenIds || approverOpenIds);
  for (const openId of teamHubWriterOpenIds) {
    if (!allowedHumanOpenIds.includes(openId)) throw new TypeError("teamHub.writerOpenIds must be a subset of agent.allowedHumanOpenIds");
  }
  const knownRepositoryIds = new Set(repositories.map(({ id }) => id));
  const teamHubRepositoryIds = uniqueStrings(raw.teamHub?.repositoryIds || [...knownRepositoryIds]);
  if (teamHubRepositoryIds.length === 0 || teamHubRepositoryIds.some((id) => !knownRepositoryIds.has(id))) {
    throw new TypeError("teamHub.repositoryIds must contain only configured repository ids");
  }

  return {
    ...raw,
    schemaVersion: 2,
    appId: requiredString(raw.appId, "appId"),
    threadId: raw.threadId ? requiredString(raw.threadId, "threadId") : undefined,
    workspace,
    allowedSenderOpenId: ownerOpenId,
    agent: {
      id: agentId,
      displayName: String(raw.agent?.displayName || `${agentId} Codex`).trim(),
      ownerOpenId,
      botOpenId,
      allowedHumanOpenIds,
      executor: {
        type: String(raw.agent?.executor?.type || "codex").trim().toLowerCase(),
      },
    },
    project,
    collaboration: {
      enabled: collaborationEnabled,
      groupChatIds,
      defaultGroupChatId,
      trustedPeers,
      approverOpenIds,
      autoAcceptPeerTasks: raw.collaboration?.autoAcceptPeerTasks === true,
      maxHops: positiveNumber(raw.collaboration?.maxHops, 2, { min: 1, max: 8 }),
      eventTtlMs: positiveNumber(raw.collaboration?.eventTtlMs, 15 * 60_000, {
        min: 60_000,
        max: 24 * 60 * 60_000,
      }),
      taskLeaseMs: positiveNumber(raw.collaboration?.taskLeaseMs, 12 * 60 * 60_000, {
        min: 5 * 60_000,
        max: 24 * 60 * 60_000,
      }),
    },
    repositories,
    teamHub: {
      enabled: teamHubEnabled,
      path: teamHubPath,
      writerOpenIds: teamHubWriterOpenIds,
      repositoryIds: teamHubRepositoryIds,
      maxContextChars: positiveNumber(raw.teamHub?.maxContextChars, 24_000, {
        min: 1_000,
        max: 100_000,
      }),
    },
  };
}

export async function loadBridgeConfig(filePath) {
  const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  return normalizeBridgeConfig(raw, { configDir: path.dirname(filePath) });
}

export function sdkGroupAllowlist(config) {
  return config.collaboration.enabled
    ? [...config.collaboration.groupChatIds]
    : ["oc_collaboration_disabled"];
}
