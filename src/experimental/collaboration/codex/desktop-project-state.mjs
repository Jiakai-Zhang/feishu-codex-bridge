import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sameFsPath } from "../../../runtime/shared/fs-paths.mjs";

function samePath(left, right) {
  return typeof left === "string" && typeof right === "string" && sameFsPath(left, right);
}

function localProjectsFromState(state) {
  const projects = state?.["local-projects"];
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return [];
  return Object.values(projects).filter((project) => project && typeof project === "object");
}

export async function inspectDesktopProject(project, {
  codexHome = path.join(os.homedir(), ".codex"),
  readFile = fs.readFile,
} = {}) {
  const configuredProjectId = typeof project?.desktopProjectId === "string"
    ? project.desktopProjectId.trim()
    : "";
  const statePath = path.join(codexHome, ".codex-global-state.json");
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    return {
      stateReadable: false,
      registered: false,
      configuredProjectId: configuredProjectId || undefined,
      configurationMatches: false,
      errorCode: error?.code || "INVALID_DESKTOP_STATE",
    };
  }

  const projects = localProjectsFromState(state);
  const rootMatch = projects.find((candidate) => (
    Array.isArray(candidate.rootPaths)
    && candidate.rootPaths.some((root) => samePath(root, project?.repoRoot))
  ));
  const configuredMatch = configuredProjectId
    ? projects.find(({ id }) => id === configuredProjectId)
    : undefined;
  const matched = rootMatch || configuredMatch;
  const registered = Boolean(rootMatch);

  return {
    stateReadable: true,
    registered,
    configuredProjectId: configuredProjectId || undefined,
    configurationMatches: registered && (!configuredProjectId || rootMatch?.id === configuredProjectId),
    projectId: matched?.id,
    name: matched?.name,
    rootPaths: Array.isArray(matched?.rootPaths) ? [...matched.rootPaths] : [],
  };
}
