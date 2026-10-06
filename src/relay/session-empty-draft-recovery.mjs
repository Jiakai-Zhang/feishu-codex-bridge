function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} has an unsupported schema`);
}

export function planEmptyDraftRecovery({ config, queue, settings, cards, ledger, fromThreadId, toThreadId }) {
  if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) throw new TypeError("Distinct task identities are required");
  requireArray(config?.sessionRelay?.bindings, "bindings");
  for (const [name, value] of Object.entries({ queue, cards, ledger })) requireArray(value, name);
  const sessions = Array.isArray(settings) ? settings : settings?.sessions;
  requireArray(sessions, "settings");
  const bindings = config.sessionRelay.bindings;
  const sources = bindings.filter((value) => value.threadId === fromThreadId);
  if (sources.length !== 1 || bindings.some((value) => value.threadId === toThreadId)) throw new Error("Binding changed before draft recovery");
  const pending = queue.filter((value) => value.sessionThreadId === fromThreadId);
  if (!pending.length || pending.some((value) => value.chatId !== sources[0].groupChatId)) throw new Error("Draft queue does not match the existing group");
  if (queue.some((value) => value.sessionThreadId === toThreadId) ||
      sessions.some((value) => value.threadId === toThreadId) || cards.some((value) => value.threadId === toThreadId)) {
    throw new Error("Replacement task already has relay state");
  }
  if (ledger.some((value) => value.sessionThreadId === fromThreadId &&
      (value.turnId || !["queued", "queued:recovered"].includes(value.kind)))) {
    throw new Error("Draft has previously accepted user input; refusing recovery");
  }
  const pendingIds = new Set(pending.map((value) => value.messageId));
  if (cards.some((value) => value.threadId === fromThreadId &&
      (!value.turnId?.startsWith("queued:") || !pendingIds.has(value.sourceMessageId)))) {
    throw new Error("Draft has execution cards; refusing recovery");
  }
  const next = structuredClone({ config, queue, settings, cards, ledger });
  next.config.sessionRelay.bindings.find((value) => value.threadId === fromThreadId).threadId = toThreadId;
  for (const value of next.queue) if (value.sessionThreadId === fromThreadId) value.sessionThreadId = toThreadId;
  const nextSessions = Array.isArray(next.settings) ? next.settings : next.settings.sessions;
  for (const value of nextSessions) if (value.threadId === fromThreadId) value.threadId = toThreadId;
  for (const value of next.cards) if (value.threadId === fromThreadId) value.threadId = toThreadId;
  for (const value of next.ledger) if (value.sessionThreadId === fromThreadId) value.sessionThreadId = toThreadId;
  return next;
}

// Caller must stop the Bridge/supervisor before taking these snapshots and
// keep it stopped through commit/rollback. No model requests are replayed here.
export async function commitEmptyDraftRecovery({ entries, backupPath, writeSnapshot }) {
  if (!entries.length || !backupPath || entries.some((entry) => !entry.filePath || entry.filePath === backupPath) ||
      new Set(entries.map((entry) => entry.filePath)).size !== entries.length) {
    throw new TypeError("Unique recovery files are required");
  }
  await writeSnapshot(backupPath, JSON.stringify({ version: 1, state: "prepared", entries }, null, 2));
  try {
    for (const entry of entries) await writeSnapshot(entry.filePath, entry.after);
    await writeSnapshot(backupPath, JSON.stringify({ version: 1, state: "committed", entries }, null, 2));
  } catch {
    let restored = true;
    for (const entry of [...entries].reverse()) {
      try { await writeSnapshot(entry.filePath, entry.before); } catch { restored = false; }
    }
    const error = new Error(restored ? "Draft recovery rolled back" : "Draft recovery rollback incomplete; keep Bridge stopped");
    error.code = restored ? "draft_recovery_rolled_back" : "draft_recovery_rollback_incomplete";
    throw error;
  }
}
