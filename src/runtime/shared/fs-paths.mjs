import { realpathSync } from "node:fs";
import path from "node:path";

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

export function stripWindowsExtendedPathPrefix(value) {
  const candidate = String(value || "");
  if (candidate.startsWith("\\\\?\\UNC\\")) return `\\\\${candidate.slice(8)}`;
  if (candidate.startsWith("\\\\?\\")) return candidate.slice(4);
  return candidate;
}

export function isWindowsAbsolutePath(value) {
  return WINDOWS_ABSOLUTE.test(stripWindowsExtendedPathPrefix(value));
}

function pathApiFor(value) {
  return isWindowsAbsolutePath(value) ? path.win32 : path;
}

export function isAbsoluteFsPath(value) {
  const candidate = stripWindowsExtendedPathPrefix(value);
  return pathApiFor(candidate).isAbsolute(candidate);
}

export function normalizeFsPath(value, { resolveRealPath = true } = {}) {
  const candidate = stripWindowsExtendedPathPrefix(value);
  const api = pathApiFor(candidate);
  const resolved = api.resolve(candidate);
  if (!resolveRealPath || api === path.win32 && process.platform !== "win32") return resolved;
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function fsPathComparisonKey(value) {
  const normalized = normalizeFsPath(value);
  return isWindowsAbsolutePath(normalized) || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

export function sameFsPath(left, right) {
  if (!left || !right) return false;
  return fsPathComparisonKey(left) === fsPathComparisonKey(right);
}

export function isPathInside(basePath, candidatePath, { allowEqual = true } = {}) {
  const base = normalizeFsPath(basePath);
  const candidate = normalizeFsPath(candidatePath);
  const api = isWindowsAbsolutePath(base) || isWindowsAbsolutePath(candidate) ? path.win32 : path;
  const relative = api.relative(base, candidate);
  if (!relative) return allowEqual;
  return !relative.startsWith("..") && !api.isAbsolute(relative);
}

export function basenameFsPath(value) {
  const candidate = stripWindowsExtendedPathPrefix(value);
  return pathApiFor(candidate).basename(candidate);
}

export function extnameFsPath(value) {
  const candidate = stripWindowsExtendedPathPrefix(value);
  return pathApiFor(candidate).extname(candidate);
}
