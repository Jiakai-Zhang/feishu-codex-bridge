export const PLATFORM_IDS = Object.freeze({
  macOS: "macos",
  Windows: "windows",
});

export function platformId(value = process.platform) {
  if (value === "darwin" || value === PLATFORM_IDS.macOS) return PLATFORM_IDS.macOS;
  if (value === "win32" || value === PLATFORM_IDS.Windows) return PLATFORM_IDS.Windows;
  throw new Error(`Unsupported runtime platform: ${String(value || "unknown")}`);
}

export function assertPlatform(expected, actual = process.platform) {
  const normalizedExpected = platformId(expected);
  const normalizedActual = platformId(actual);
  if (normalizedExpected !== normalizedActual) {
    throw new Error(`This command supports ${normalizedExpected} only.`);
  }
  return normalizedActual;
}
