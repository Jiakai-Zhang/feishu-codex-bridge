// Only a positively identified, unused Desktop draft may get a runnable peer.
// Never infer emptiness from a missing rollout or an RPC error alone.
export async function materializeSessionDraft({ session, sessionStore, createTarget, sandboxMode }) {
  const draft = await sessionStore.getUnmaterializedDraft(session.id);
  if (!draft) return session;
  if (draft.cwd !== session.cwd) throw new Error("Draft workspace changed before initialization");
  const created = await createTarget({ cwd: session.cwd, name: session.title, sandboxMode });
  if (!created?.id || created.id === session.id || created.historyMode === "paginated") {
    throw new Error("Native draft initialization did not return a compatible new task");
  }
  return Object.freeze({
    ...session,
    id: created.id,
    rolloutPath: created.path,
  });
}
