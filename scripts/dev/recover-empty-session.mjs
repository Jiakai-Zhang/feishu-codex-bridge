// Explicit maintenance only. Uses public title for selection; never accepts or
// prints real conversation/account identities, prompts or configuration.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CodexSessionStore } from "../../src/codex/codex-session-store.mjs";
import { CodexSessionController } from "../../src/codex/codex-session-controller.mjs";
import { SessionRelaySettingsStore } from "../../src/persistence/session-relay-settings.mjs";
import { createSerializedFileWriter } from "../../src/persistence/serialized-json-file.mjs";
import { materializeSessionDraft } from "../../src/relay/session-draft-bootstrap.mjs";
import { planEmptyDraftRecovery, commitEmptyDraftRecovery } from "../../src/relay/session-empty-draft-recovery.mjs";

const repo = process.cwd();
const title = process.argv[2];
let controller;
let code = 1;
let stage = "preflight";
try {
  if (!title) throw new Error("A public task title is required");
  const configPath = path.join(repo, "bridge.config.json");
  const originalConfig = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(originalConfig);
  const runtime = path.join(config.workspace, "work", "feishu-codex-bridge");
  for (const pidFile of ["bridge.pid", "bridge-supervisor.pid"]) {
    try {
      const pid = Number((await fs.readFile(path.join(runtime, pidFile), "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid service metadata");
      process.kill(pid, 0);
      throw new Error("Stop Bridge and supervisor before recovery");
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error?.code)) throw error;
    }
  }
  const store = new CodexSessionStore({
    stateDbPath: path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE, ".codex"), "state_5.sqlite"),
    sessionIndexPath: path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE, ".codex"), "session_index.jsonl"),
  });
  const candidates = [];
  for (const binding of config.sessionRelay.bindings) {
    const session = await store.get(binding.threadId);
    if (session?.title === title) candidates.push(session);
  }
  if (candidates.length !== 1) throw new Error("Task title is missing or ambiguous");
  const session = candidates[0];
  if (!await store.getUnmaterializedDraft(session.id)) throw new Error("Task is not a positively verified unused draft");
  const files = {
    queue: "session-relay-prompt-queue.json",
    settings: "session-relay-settings.json",
    cards: "session-relay-stream-cards.json",
    ledger: "session-relay-input-ledger.json",
  };
  const originals = { config: originalConfig };
  const state = { config };
  for (const [key, file] of Object.entries(files)) {
    originals[key] = await fs.readFile(path.join(runtime, file), "utf8");
    state[key] = JSON.parse(originals[key]);
  }
  // Validate every durable surface before creating anything in the native app.
  planEmptyDraftRecovery({ ...state, fromThreadId: session.id, toThreadId: "unused-recovery-validation-target" });
  const settingsStore = await SessionRelaySettingsStore.open(path.join(runtime, files.settings));
  const override = settingsStore.get(session.id).sandboxMode;
  const sandboxMode = override === "inherit" ? config.sandboxMode : override;
  stage = "native-creation";
  controller = new CodexSessionController({
    appServerUrl: config.sessionRelay.appServerUrl,
    targets: [],
    sandboxMode,
    // Creation loads the same Desktop dynamic-tool declarations as production.
    // No turn or tool call is started by this maintenance client.
    dynamicToolRequestHandler: async () => ({ success: false, contentItems: [] }),
  });
  await controller.start();
  const replacement = await materializeSessionDraft({
    session, sessionStore: store, sandboxMode,
    createTarget: (params) => controller.createTarget(params),
  });
  if (replacement.id === session.id) throw new Error("Draft changed before materialization");
  await controller.stop();
  stage = "native-resume-verification";
  // A successful native resume/full read proves the new task survives a client
  // disconnect and the upcoming Bridge reload. No model prompt is submitted.
  controller = new CodexSessionController({
    appServerUrl: config.sessionRelay.appServerUrl,
    targets: [{ threadId: replacement.id, cwd: replacement.cwd }],
    sandboxMode,
  });
  await controller.start();
  const verified = await controller.readPersistedThread(replacement.id);
  if (verified.historyMode === "paginated" || verified.turns?.length || verified.preview) throw new Error("Replacement history verification failed");
  if (!await store.getUnmaterializedDraft(session.id)) throw new Error("Original draft is no longer unused");
  stage = "state-revalidation";
  for (const [key, file] of Object.entries(files)) {
    if (await fs.readFile(path.join(runtime, file), "utf8") !== originals[key]) throw new Error("Relay state changed during maintenance");
  }
  if (await fs.readFile(configPath, "utf8") !== originalConfig) throw new Error("Binding configuration changed during maintenance");
  const next = planEmptyDraftRecovery({ ...state, fromThreadId: session.id, toThreadId: replacement.id });
  const entries = Object.keys(files).map((key) => ({
    filePath: path.join(runtime, files[key]), before: originals[key], after: `${JSON.stringify(next[key], null, 2)}\n`,
  })).filter((entry) => JSON.stringify(JSON.parse(entry.before)) !== JSON.stringify(JSON.parse(entry.after)));
  // Commit binding last, after all queue/card/settings identities are durable.
  entries.push({ filePath: configPath, before: originalConfig, after: `${JSON.stringify(next.config, null, 2)}\n` });
  const writers = new Map();
  const writeSnapshot = (file, text) => {
    if (!writers.has(file)) writers.set(file, createSerializedFileWriter(file));
    return writers.get(file)(text);
  };
  const backupPath = path.join(runtime, `empty-draft-recovery-${randomUUID()}.json`);
  stage = "state-commit";
  await commitEmptyDraftRecovery({ entries, backupPath, writeSnapshot });
  console.log(JSON.stringify({ ok: true, originalDraftRetained: true, groupAndOwnerPreserved: true, queuedMessagesPreserved: true, existingCardsReused: true, nativeResumeVerified: true, modelPromptsSubmitted: 0 }));
  code = 0;
} catch (error) {
  console.log(JSON.stringify({ ok: false, stage, category: ["draft_recovery_rolled_back", "draft_recovery_rollback_incomplete"].includes(error?.code) ? error.code : "empty-draft-recovery-stopped" }));
} finally {
  try { await controller?.stop(); } catch { /* never emit private native errors */ }
  setTimeout(() => process.exit(code), 200);
}
