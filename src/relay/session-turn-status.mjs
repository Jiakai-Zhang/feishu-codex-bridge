// Ports keep Codex status policy independent of card rendering and transport.
export async function flushSessionTurnStatus({ current, streamCards, updateCard, persistTerminal }) {
  if (!current?.executionStatus) return false;
  if (current.executionStatus.uneditable) return false;
  try {
    await updateCard(current);
  } catch (error) {
    const code = error?.response?.data?.code ?? error?.code ?? error?.cause?.response?.data?.code;
    if (Number(code) !== 230031) throw error;
    // Feishu permanently rejects expired message updates. Retain undelivered
    // state, but do not retry forever or create duplicate fallback messages.
    await streamCards.markExecutionStatusUneditable(current.threadId, current.turnId);
    return false;
  }
  if (["failed", "interrupted", "completed"].includes(current.executionStatus.type)) {
    await persistTerminal(current);
    await streamCards.remove(current.threadId, current.turnId);
  }
  return true;
}

export async function processSessionTurnStatus({ record, streamCards, ensureCard, updateCard, persistTerminal }) {
  let current = streamCards.get(record.threadId, record.turnId);
  if (record.executionStatus.type === "running" && !current?.executionStatus) return;
  if (!current) current = await ensureCard(record);
  if (!current) return;
  current = await streamCards.updateExecutionStatus(record.threadId, record.turnId, record.executionStatus);
  if (current.executionStatus) {
    await flushSessionTurnStatus({ current, streamCards, updateCard, persistTerminal });
  } else {
    await updateCard(current);
  }
}
