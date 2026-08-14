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
  const capabilities = Object.freeze({
    persistentThreads: adapter.capabilities?.persistentThreads === true,
    projectCwd: adapter.capabilities?.projectCwd === true,
    progressUpdates: adapter.capabilities?.progressUpdates === true,
    cancellation: adapter.capabilities?.cancellation === true,
  });
  const missing = ["persistentThreads", "projectCwd", "progressUpdates"].filter((name) => !capabilities[name]);
  if (missing.length) {
    throw new TypeError(`Agent executor '${type}' is missing required capabilities: ${missing.join(", ")}`);
  }
  if (capabilities.cancellation && typeof adapter.cancelTurn !== "function") {
    throw new TypeError(`Agent executor '${type}' declares cancellation but does not implement cancelTurn`);
  }
  return Object.freeze({
    type,
    capabilities,
    createThread: adapter.createThread.bind(adapter),
    runTurn: adapter.runTurn.bind(adapter),
    cancelTurn: capabilities.cancellation ? adapter.cancelTurn.bind(adapter) : undefined,
  });
}
