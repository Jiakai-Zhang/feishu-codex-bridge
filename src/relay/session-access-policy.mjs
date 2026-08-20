import path from "node:path";
import { isPathInside, normalizeFsPath } from "../runtime/shared/fs-paths.mjs";

function userRoots(access) {
  if (!access?.projectRoot) return new Map();
  return new Map((access.users || [])
    .filter((user) => user.status === "active" && user.directoryName)
    .map((user) => [user.openId, normalizeFsPath(path.join(access.projectRoot, user.directoryName))]));
}

function inferredOwner(paths, roots) {
  const matches = new Set();
  let unmatched = false;
  for (const candidate of paths || []) {
    let candidateMatched = false;
    for (const [openId, root] of roots) {
      if (isPathInside(root, candidate)) {
        matches.add(openId);
        candidateMatched = true;
      }
    }
    if (!candidateMatched) unmatched = true;
  }
  if (matches.size === 0) return { kind: "unassigned" };
  if (matches.size > 1 || unmatched) return { kind: "ambiguous" };
  return { kind: "owned", ownerOpenId: [...matches][0] };
}

function projectOwnership(project, roots) {
  if (project?.ownerOpenId) return { kind: "owned", ownerOpenId: project.ownerOpenId };
  return inferredOwner(project?.rootPaths, roots);
}

function sessionOwnership(session, fallback, roots) {
  if (session?.binding?.ownerOpenId) return { kind: "owned", ownerOpenId: session.binding.ownerOpenId };
  if (fallback?.kind === "owned") return fallback;
  if (session?.cwd) return inferredOwner([session.cwd], roots);
  return fallback || { kind: "ambiguous" };
}

function visibleToActor(ownership, actorOpenId, ownerOpenId) {
  if (ownership?.kind === "ambiguous") return false;
  if (ownership?.kind === "unassigned") return actorOpenId === ownerOpenId;
  return ownership?.ownerOpenId === actorOpenId;
}

function decorateAccess(record, ownership) {
  return Object.freeze({
    ...record,
    accessKind: ownership.kind,
    ownerOpenId: ownership.ownerOpenId,
  });
}

export function scopeSessionCatalog(catalog, access, { actorOpenId, ownerOpenId }) {
  const actor = String(actorOpenId || "");
  const owner = String(ownerOpenId || "");
  const roots = userRoots(access);
  const configured = Boolean(access?.projectRoot && roots.get(owner));

  if (!configured) {
    if (actor !== owner) {
      return Object.freeze({
        projects: Object.freeze([]),
        independent: Object.freeze([]),
        sessionsById: new Map(),
        canCreateProject: false,
        independentCreateMode: "disabled",
        actorRoot: undefined,
      });
    }
    return Object.freeze({
      ...catalog,
      canCreateProject: false,
      independentCreateMode: "prompt-cwd",
      actorRoot: undefined,
    });
  }

  const projects = [];
  const sessionsById = new Map();
  for (const project of catalog.projects || []) {
    const ownership = projectOwnership(project, roots);
    if (!visibleToActor(ownership, actor, owner)) continue;
    const sessions = [];
    for (const session of project.sessions || []) {
      const ownedSession = sessionOwnership(session, ownership, roots);
      if (!visibleToActor(ownedSession, actor, owner)) continue;
      const decorated = decorateAccess(session, ownedSession);
      sessions.push(decorated);
      sessionsById.set(decorated.id, decorated);
    }
    projects.push(Object.freeze({
      ...project,
      accessKind: ownership.kind,
      ownerOpenId: ownership.ownerOpenId,
      sessions: Object.freeze(sessions),
    }));
  }

  const independent = [];
  for (const session of catalog.independent || []) {
    const ownership = sessionOwnership(session, undefined, roots);
    if (!visibleToActor(ownership, actor, owner)) continue;
    const decorated = decorateAccess(session, ownership);
    independent.push(decorated);
    sessionsById.set(decorated.id, decorated);
  }

  return Object.freeze({
    projects: Object.freeze(projects),
    independent: Object.freeze(independent),
    sessionsById,
    canCreateProject: roots.has(actor),
    independentCreateMode: roots.has(actor) ? "member-root" : "disabled",
    actorRoot: roots.get(actor),
  });
}

export function activeSessionParticipants({ members, access }) {
  const active = new Set((access?.users || [])
    .filter(({ status }) => status === "active")
    .map(({ openId }) => openId));
  return (members || []).filter(({ id }) => active.has(id)).map(({ id }) => id);
}
