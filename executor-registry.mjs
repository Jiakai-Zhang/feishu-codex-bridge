export function createExecutor(executorConfig, adapters) {
  const type = String(executorConfig?.type || "").trim().toLowerCase();
  const adapter = adapters?.[type];
  if (!adapter) {
    const available = Object.keys(adapters || {}).sort().join(", ") || "none";
    throw new Error(`Unsupported agent executor '${type || "unset"}'. Available executors: ${available}`);
  }
  if (typeof adapter.createThread !== "function" || typeof adapter.runTurn !== "function") {
    throw new TypeError(`Agent executor '${type}' must implement createThread and runTurn`);
  }
  return Object.freeze({ type, createThread: adapter.createThread, runTurn: adapter.runTurn });
}
