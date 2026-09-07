function activeSession(status) {
  return status?.status?.type === "active" || status?.goal?.status === "active";
}

export async function retireTemporaryChat({
  record,
  pendingPromptCount,
  hasPendingDelivery,
  readStatus,
  archiveStore,
  readThread,
  deleteThread,
  removeRecord,
}) {
  if (!record || record.status !== "ended") return false;
  if (pendingPromptCount > 0 || hasPendingDelivery) return false;

  const status = await readStatus().catch(() => undefined);
  if (activeSession(status)) return false;

  if (!await archiveStore.has(record)) {
    const thread = await readThread(record.threadId);
    if (thread?.status?.type === "active") return false;
    await archiveStore.archive(record, thread);
  }

  await deleteThread(record.threadId);
  await removeRecord(record.threadId);
  return true;
}
