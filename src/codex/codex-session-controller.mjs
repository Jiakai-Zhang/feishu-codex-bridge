import { CodexTurnCollector } from "./codex-turn-collector.mjs";
import { CodexAppServerConnection } from "./codex-app-server-connection.mjs";
import { buildCodexPromptInput } from "../feishu/feishu-inbound-attachment.mjs";

const ACTIVE_WRITER_PATTERN = /already has an active writer/i;
const SESSION_WRITER_CONFLICT_PUBLIC_MESSAGE =
  "当前 Session 的写入权限正被 Codex Desktop 或 CLI 占用。请在对应客户端关闭该对话，或结束正在使用它的连接后重试；Bridge 与其他群仍会继续运行。";
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const CODEX_APP_AUTOMATION_TOOL_CONFIG = Object.freeze({
  "mcp_servers.codex_app.enabled_tools": Object.freeze(["automation_update"]),
});

function turnSandboxPolicy(mode, cwd) {
  switch (mode) {
    case "read-only":
      return Object.freeze({ type: "readOnly", networkAccess: false });
    case "workspace-write":
      return Object.freeze({
        type: "workspaceWrite",
        writableRoots: Object.freeze([cwd]),
        networkAccess: false,
      });
    case "danger-full-access":
      return Object.freeze({ type: "dangerFullAccess" });
    default:
      throw new TypeError("Unsupported Codex Session sandbox mode");
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function controllerError(code, message, options) {
  const error = new Error(message, options);
  error.name = "CodexSessionControllerError";
  error.code = code;
  return error;
}

function statusType(value) {
  return String(value?.type || "notLoaded");
}

function findActiveTurn(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.status === "inProgress" && turns[index]?.id) return turns[index];
  }
  return undefined;
}

function findClientInput(thread, clientUserMessageId) {
  const clientId = String(clientUserMessageId || "");
  if (!clientId) return undefined;
  for (const turn of thread?.turns || []) {
    const messages = (turn?.items || []).filter((item) => item?.type === "userMessage");
    const index = messages.findIndex((item) => item?.clientId === clientId);
    if (index >= 0) return { turn, index };
  }
  return undefined;
}

function queuedPromptAcceptance(accepted, { recoveredAfterReconnect = false } = {}) {
  return Object.freeze({
    kind: "accepted",
    turnId: accepted.turn.id,
    turnStatus: accepted.turn.status,
    inputIndex: accepted.index,
    ...(recoveredAfterReconnect ? { recoveredAfterReconnect: true } : {}),
  });
}

function isRecoverableTransportError(error) {
  return ["codex_app_server_unavailable", "codex_app_server_timeout"].includes(error?.code);
}

function isActiveWriterResumeError(error) {
  return error?.method === "thread/resume" && ACTIVE_WRITER_PATTERN.test(String(error?.message || ""));
}

function sessionWriterConflict(error) {
  const conflict = controllerError(
    "session_writer_conflict",
    "The bound Codex Session is currently owned by another writer",
    { cause: error },
  );
  conflict.publicMessage = SESSION_WRITER_CONFLICT_PUBLIC_MESSAGE;
  return conflict;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isGoalRunning(goal) {
  return goal?.status === "active";
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function standardServiceTier(value) {
  return value == null || ["", "default", "standard"].includes(String(value).trim().toLowerCase());
}

function resolveServiceTier(model, value) {
  if (standardServiceTier(value)) return null;
  const requested = String(value).trim().toLowerCase();
  const serviceTiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers : [];
  const named = serviceTiers.find((tier) =>
    [tier?.id, tier?.name].some((candidate) => String(candidate || "").trim().toLowerCase() === requested));
  if (named?.id) return String(named.id);
  const additional = Array.isArray(model?.additionalSpeedTiers) ? model.additionalSpeedTiers : [];
  if (additional.some((candidate) => String(candidate).toLowerCase() === requested)) {
    const sameName = serviceTiers.find((tier) => String(tier?.name || "").trim().toLowerCase() === requested);
    return String(sameName?.id || value);
  }
  return String(value);
}

function controllerState(target) {
  return {
    target,
    status: { type: "notLoaded" },
    activeTurnId: undefined,
    activeTurnStartedAt: undefined,
    settings: {
      model: undefined,
      serviceTier: null,
      effort: null,
      collaborationMode: undefined,
    },
    tokenUsage: undefined,
    goal: undefined,
    lastTurn: undefined,
    collaborationModeKnown: false,
    hydrationError: undefined,
    hydrationPromise: undefined,
  };
}

function normalizeModelEntry(model) {
  return {
    ...model,
    supportedReasoningEfforts: Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts
      : [],
    serviceTiers: Array.isArray(model?.serviceTiers) ? model.serviceTiers : [],
    additionalSpeedTiers: Array.isArray(model?.additionalSpeedTiers) ? model.additionalSpeedTiers : [],
  };
}

export function isFeishuMessageClientId(clientId) {
  return typeof clientId === "string" && /^om_[A-Za-z0-9_-]+$/.test(clientId);
}

export class CodexSessionController {
  constructor({
    appServerUrl,
    targets,
    sandboxMode,
    sandboxModeForThread,
    onTurnCompleted,
    onTurnProgress,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = 30_000,
    reconnectDelayMs = 2_000,
    sleepImpl = delay,
    dynamicToolRequestHandler,
    log = () => {},
  }) {
    if (!appServerUrl) throw new TypeError("appServerUrl is required for the persistent session controller");
    if (typeof WebSocketImpl !== "function") throw new TypeError("A WebSocket implementation is required");
    this.appServerUrl = appServerUrl;
    this.targets = new Map((targets || []).map((target) => [target.threadId, Object.freeze({ ...target })]));
    this.sandboxMode = sandboxMode;
    this.sandboxModeForThread = sandboxModeForThread;
    this.onTurnCompleted = onTurnCompleted;
    this.onTurnProgress = onTurnProgress;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.sleepImpl = sleepImpl;
    this.log = log;
    this.dynamicToolRequestHandler = dynamicToolRequestHandler;
    this.states = new Map([...this.targets].map(([threadId, target]) => [threadId, controllerState(target)]));
    this.collector = new CodexTurnCollector({
      targets: [...this.targets.values()],
      onTurnCompleted: (record) => this.#emitCompletedTurn(record),
      onTurnProgress: (record) => this.#emitTurnProgress(record),
      onError: (error) => this.log(`turn completion callback failed: ${error instanceof Error ? error.name : "unknown"}`),
    });
    this.connection = undefined;
    this.connectPromise = undefined;
    this.reconnectTimer = undefined;
    this.stopped = true;
    this.hasConnected = false;
    this.disconnectedAtMs = undefined;
    this.modelCache = undefined;
    this.collaborationModeCache = undefined;
    this.tails = new Map();
  }

  get connected() {
    return Boolean(this.connection?.ready && !this.stopped);
  }

  hasTarget(threadId) {
    return this.targets.has(String(threadId || ""));
  }

  async addTarget(target) {
    const threadId = String(target?.threadId || "");
    const cwd = String(target?.cwd || "");
    if (!threadId || !cwd) throw new TypeError("Session controller target requires threadId and cwd");
    if (this.targets.has(threadId)) return this.getStatus(threadId, { refresh: false });
    const normalized = Object.freeze({ ...target, threadId, cwd });
    const state = controllerState(normalized);
    this.targets.set(threadId, normalized);
    this.states.set(threadId, state);
    this.collector.addTarget(normalized);
    try {
      if (this.connectPromise) await this.connectPromise;
      if (this.connected && statusType(state.status) === "notLoaded") {
        await this.#hydrateState(this.connection, state);
      }
      return this.getStatus(threadId, { refresh: false });
    } catch (error) {
      this.targets.delete(threadId);
      this.states.delete(threadId);
      this.collector.removeTarget(threadId);
      throw error;
    }
  }

  removeTarget(threadId) {
    const key = String(threadId || "");
    if (!this.targets.delete(key)) return false;
    this.states.delete(key);
    this.collector.removeTarget(key);
    return true;
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      await this.#connect();
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const connection = this.connection;
    this.connection = undefined;
    if (connection) {
      connection.close(controllerError("codex_app_server_unavailable", "Codex session controller stopped"));
    }
  }

  #state(threadId) {
    const state = this.states.get(threadId);
    if (!state) throw new TypeError("The Codex task is not bound to this controller");
    return state;
  }

  #resolvedSandboxMode(threadId) {
    const resolved = typeof this.sandboxModeForThread === "function"
      ? this.sandboxModeForThread(threadId)
      : this.sandboxMode;
    if (!SANDBOX_MODES.has(resolved)) {
      throw new TypeError("Session sandbox resolver returned an unsupported mode");
    }
    return resolved;
  }

  #sandboxResumeParams(state) {
    return {
      threadId: state.target.threadId,
      cwd: state.target.cwd,
      approvalPolicy: "never",
      sandbox: this.#resolvedSandboxMode(state.target.threadId),
      ...(this.dynamicToolRequestHandler ? { config: CODEX_APP_AUTOMATION_TOOL_CONFIG } : {}),
    };
  }

  async #applyResolvedSandboxMode(state) {
    let result;
    try {
      result = await this.#request("thread/resume", this.#sandboxResumeParams(state));
    } catch (error) {
      if (isActiveWriterResumeError(error)) throw sessionWriterConflict(error);
      throw error;
    }
    if (result?.thread?.id !== state.target.threadId) {
      throw new Error("Codex session controller resumed a different task than its binding");
    }
    this.#applyResume(state, result);
  }

  #enqueue(threadId, work) {
    this.#state(threadId);
    const previous = this.tails.get(threadId) || Promise.resolve();
    const running = previous.catch(() => {}).then(work);
    const tail = running.catch(() => {}).finally(() => {
      if (this.tails.get(threadId) === tail) this.tails.delete(threadId);
    });
    this.tails.set(threadId, tail);
    return running;
  }

  async #request(method, params) {
    const connection = this.connection;
    if (!connection?.ready || this.stopped) {
      throw controllerError("codex_app_server_unavailable", "The shared Codex App Server is not connected");
    }
    const state = this.states.get(String(params?.threadId || ""));
    if (state?.hydrationError) await this.#hydrateState(connection, state);
    return connection.request(method, params);
  }

  async #requestPrompt(method, params, prompt) {
    const input = buildCodexPromptInput(prompt);
    return this.#request(method, { ...params, input });
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.#connect();
        this.log("Codex session controller reconnected");
      } catch (error) {
        this.log(`Codex session controller reconnect failed: ${error instanceof Error ? error.name : "unknown"}`);
        this.#scheduleReconnect();
      }
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  async #connect() {
    if (this.connectPromise) return this.connectPromise;
    const running = this.#openConnection();
    this.connectPromise = running;
    try {
      return await running;
    } finally {
      if (this.connectPromise === running) this.connectPromise = undefined;
    }
  }

  async #openConnection() {
    let connection;
    connection = new CodexAppServerConnection({
      url: this.appServerUrl,
      WebSocketImpl: this.WebSocketImpl,
      requestTimeoutMs: this.requestTimeoutMs,
      clientLabel: "controller",
      onRequest: this.dynamicToolRequestHandler,
      log: this.log,
      onNotification: (method, params) => this.#handleNotification(method, params),
      onClose: ({ intentional }) => {
        if (this.connection === connection) this.connection = undefined;
        if (!intentional && !this.stopped && this.hasConnected) {
          this.disconnectedAtMs = Date.now();
          this.log("Codex session controller disconnected; reconnect scheduled");
          this.#scheduleReconnect();
        }
      },
    });
    this.connection = connection;

    try {
      await connection.open();
      await connection.request("initialize", {
        clientInfo: {
          name: "feishu_codex_session_controller",
          title: "Feishu Codex Session Controller",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      connection.notify("initialized");
      const catchUpAfterMs = this.hasConnected ? this.disconnectedAtMs : undefined;
      for (const state of this.states.values()) {
        try {
          await this.#hydrateState(connection, state, { catchUpAfterMs });
        } catch (error) {
          if (error?.code !== "session_writer_conflict") throw error;
          this.log("Codex Session unavailable: active writer conflict; other bindings remain connected");
        }
      }
      connection.activate();
      this.hasConnected = true;
      this.disconnectedAtMs = undefined;
    } catch (error) {
      connection.close(error);
      if (this.connection === connection) this.connection = undefined;
      throw error;
    }
  }

  async #hydrateState(connection, state, { catchUpAfterMs } = {}) {
    if (state.hydrationPromise) return state.hydrationPromise;
    const running = (async () => {
      try {
        await this.#hydrateStateOnce(connection, state, { catchUpAfterMs });
        state.hydrationError = undefined;
      } catch (error) {
        const normalized = isActiveWriterResumeError(error) ? sessionWriterConflict(error) : error;
        if (normalized?.code === "session_writer_conflict") {
          state.hydrationError = normalized;
          state.status = { type: "notLoaded" };
          state.activeTurnId = undefined;
          state.activeTurnStartedAt = undefined;
        }
        throw normalized;
      }
    })();
    state.hydrationPromise = running;
    try {
      return await running;
    } finally {
      if (state.hydrationPromise === running) state.hydrationPromise = undefined;
    }
  }

  async #hydrateStateOnce(connection, state, { catchUpAfterMs } = {}) {
    const result = await connection.request("thread/resume", this.#sandboxResumeParams(state));
    if (result?.thread?.id !== state.target.threadId) {
      throw new Error("Codex session controller resumed a different task than its binding");
    }
    this.#applyResume(state, result);
    const snapshot = await connection.request("thread/read", {
      threadId: state.target.threadId,
      includeTurns: true,
    });
    this.#applyThreadSnapshot(state, snapshot?.thread);
    try {
      const goalResult = await connection.request("thread/goal/get", { threadId: state.target.threadId });
      state.goal = clone(goalResult?.goal);
    } catch (error) {
      this.log(`could not hydrate goal state for ${state.target.threadId}: ${error instanceof Error ? error.name : "unknown"}`);
    }
    this.collector.seedThread(snapshot?.thread, { catchUpAfterMs });
  }

  #applyResume(state, result) {
    state.settings.model = result?.model || state.settings.model;
    state.settings.serviceTier = result?.serviceTier ?? null;
    state.settings.effort = result?.reasoningEffort ?? null;
    if (!state.settings.collaborationMode && state.settings.model) {
      state.settings.collaborationMode = {
        mode: "default",
        settings: {
          model: state.settings.model,
          reasoning_effort: state.settings.effort,
          developer_instructions: null,
        },
      };
    }
    this.#applyThreadSnapshot(state, result?.thread);
  }

  #applyThreadSnapshot(state, thread) {
    if (!thread) return;
    state.status = clone(thread.status) || { type: "notLoaded" };
    const active = findActiveTurn(thread);
    if (active) {
      state.activeTurnId = active.id;
      state.activeTurnStartedAt = active.startedAt ?? state.activeTurnStartedAt;
    } else if (statusType(thread.status) !== "active") {
      state.activeTurnId = undefined;
      state.activeTurnStartedAt = undefined;
    }
  }

  #handleNotification(method, params) {
    const state = this.states.get(params.threadId);
    if (!state) return;
    this.collector.handleNotification(method, params);
    if (method === "thread/status/changed") {
      state.status = clone(params.status) || state.status;
      if (statusType(params.status) !== "active") {
        state.activeTurnId = undefined;
        state.activeTurnStartedAt = undefined;
      }
    } else if (method === "turn/started") {
      state.activeTurnId = params.turn?.id || state.activeTurnId;
      state.activeTurnStartedAt = params.turn?.startedAt ?? state.activeTurnStartedAt;
      state.status = { type: "active", activeFlags: [] };
    } else if (method === "turn/completed") {
      state.lastTurn = clone(params.turn);
      if (!state.activeTurnId || state.activeTurnId === params.turn?.id) {
        state.activeTurnId = undefined;
        state.activeTurnStartedAt = undefined;
        state.status = { type: "idle" };
      }
    } else if (method === "thread/settings/updated") {
      state.settings = clone(params.threadSettings) || state.settings;
      state.collaborationModeKnown = Boolean(params.threadSettings?.collaborationMode);
    } else if (method === "thread/tokenUsage/updated") {
      state.tokenUsage = clone(params.tokenUsage);
    } else if (method === "thread/goal/updated") {
      state.goal = clone(params.goal);
    } else if (method === "thread/goal/cleared") {
      state.goal = null;
    }
  }

  async #emitCompletedTurn(record) {
    const state = this.#state(record.threadId);
    let goal = state.goal;
    if (record.promptEntries.length === 0) {
      try {
        const result = await this.#request("thread/goal/get", { threadId: record.threadId });
        goal = result?.goal ?? goal;
        state.goal = clone(goal);
      } catch {}
    }
    if (typeof this.onTurnCompleted === "function") {
      await this.onTurnCompleted(Object.freeze({ ...record, goal: clone(goal) }));
    }
  }

  async #emitTurnProgress(record) {
    if (typeof this.onTurnProgress === "function") await this.onTurnProgress(record);
  }

  async #readThread(threadId, includeTurns = true) {
    const state = this.#state(threadId);
    const result = await this.#request("thread/read", { threadId, includeTurns });
    if (result?.thread?.id !== threadId) throw new Error("Codex App Server returned a different task");
    this.#applyThreadSnapshot(state, result.thread);
    return result.thread;
  }

  async #waitForIdle(threadId, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
    const startedAt = Date.now();
    for (;;) {
      const thread = await this.#readThread(threadId, true);
      const type = statusType(thread.status);
      if (type === "idle") return thread;
      if (type === "systemError") {
        throw controllerError("session_system_error", "The bound Codex task entered a system error state");
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw controllerError("session_busy", "The bound Codex task did not become idle after interruption");
      }
      await this.sleepImpl(intervalMs);
    }
  }

  async #waitForReady({ timeoutMs = 15_000, intervalMs = 50 } = {}) {
    const startedAt = Date.now();
    while (!this.connected) {
      if (this.stopped || Date.now() - startedAt >= timeoutMs) {
        throw controllerError("codex_app_server_unavailable", "The shared Codex App Server did not reconnect in time");
      }
      await this.sleepImpl(intervalMs);
    }
  }

  async #recoverSubmittedPrompt({ threadId, clientUserMessageId, retry }) {
    await this.#waitForReady();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await this.#readThread(threadId, true);
      const accepted = findClientInput(snapshot, clientUserMessageId);
      if (accepted) {
        return Object.freeze({
          kind: accepted.index === 0 ? "started" : "steered",
          turnId: accepted.turn.id,
          boundaryChanged: false,
          recoveredAfterReconnect: true,
        });
      }
      if (attempt === 0) await this.sleepImpl(100);
    }
    return retry();
  }

  async submitPrompt({ threadId, text, attachments, clientUserMessageId }) {
    const prompt = { text, attachments };
    return this.#enqueue(threadId, async () => {
      const state = this.#state(threadId);
      const client = clientUserMessageId ? { clientUserMessageId: String(clientUserMessageId) } : {};
      const steer = async (expectedTurnId) => {
        const result = await this.#requestPrompt("turn/steer", {
          threadId,
          expectedTurnId,
          ...client,
        }, prompt);
        return Object.freeze({ kind: "steered", turnId: result?.turnId || expectedTurnId, boundaryChanged: false });
      };
      const submit = async () => {
        const cachedTurnId = statusType(state.status) === "active" ? state.activeTurnId : undefined;
        let cachedSteerError;
        if (cachedTurnId) {
          try {
            return await steer(cachedTurnId);
          } catch (error) {
            if (isRecoverableTransportError(error)) throw error;
            cachedSteerError = error;
          }
        }
        const firstSnapshot = await this.#readThread(threadId, true);
        if (statusType(firstSnapshot.status) === "systemError") {
          throw controllerError("session_system_error", "The bound Codex task is in a system error state");
        }
        const active = findActiveTurn(firstSnapshot);
        const expectedTurnId = active?.id ||
          (statusType(firstSnapshot.status) === "active" ? state.activeTurnId : undefined);
        if (expectedTurnId) {
          if (cachedSteerError && expectedTurnId === cachedTurnId) {
            throw controllerError("session_busy", "The active Codex turn rejected steering", { cause: cachedSteerError });
          }
          try {
            return await steer(expectedTurnId);
          } catch (steerError) {
            const secondSnapshot = await this.#readThread(threadId, true);
            const replacement = findActiveTurn(secondSnapshot);
            const replacementId = replacement?.id ||
              (statusType(secondSnapshot.status) === "active" ? state.activeTurnId : undefined);
            if (replacementId) {
              try {
                return await steer(replacementId);
              } catch (retryError) {
                if (isRecoverableTransportError(retryError)) throw retryError;
                throw controllerError("session_busy", "The active Codex turn changed while steering", { cause: retryError });
              }
            }
            if (statusType(secondSnapshot.status) !== "idle") throw steerError;
            const started = await this.#startTurn(state, prompt, client);
            return Object.freeze({ kind: "started", turnId: started, boundaryChanged: true });
          }
        }
        if (statusType(firstSnapshot.status) !== "idle") {
          throw controllerError("session_busy", `The bound Codex task is not ready (${statusType(firstSnapshot.status)})`);
        }
        const started = await this.#startTurn(state, prompt, client);
        return Object.freeze({ kind: "started", turnId: started, boundaryChanged: Boolean(cachedSteerError) });
      };
      try {
        return await submit();
      } catch (error) {
        if (!clientUserMessageId || !isRecoverableTransportError(error)) throw error;
        this.log(`reconciling uncertain prompt submission ${clientUserMessageId} after App Server reconnect`);
        return this.#recoverSubmittedPrompt({
          threadId,
          clientUserMessageId: String(clientUserMessageId),
          retry: submit,
        });
      }
    });
  }

  async startQueuedPrompt({ threadId, text, attachments, clientUserMessageId }) {
    const clientId = String(clientUserMessageId || "");
    if (!clientId) throw new TypeError("Queued Codex prompt requires a client message id");
    const prompt = { text, attachments };
    return this.#enqueue(threadId, async () => {
      const state = this.#state(threadId);
      const client = { clientUserMessageId: clientId };
      const inspectAcceptedOrWait = async () => {
        const snapshot = await this.#readThread(threadId, true);
        const accepted = findClientInput(snapshot, clientId);
        if (accepted) return queuedPromptAcceptance(accepted);
        if (statusType(snapshot.status) === "systemError") {
          throw controllerError("session_system_error", "The bound Codex task is in a system error state");
        }
        const active = findActiveTurn(snapshot);
        if (active || statusType(snapshot.status) === "active") {
          return Object.freeze({ kind: "waiting", reason: "turn_active", turnId: active?.id || state.activeTurnId });
        }
        const goal = await this.getGoal(threadId, { refresh: true });
        if (isGoalRunning(goal)) return Object.freeze({ kind: "waiting", reason: "goal_active" });
        if (statusType(snapshot.status) !== "idle") {
          return Object.freeze({ kind: "waiting", reason: `session_${statusType(snapshot.status)}` });
        }
        try {
          const turnId = await this.#startTurn(state, prompt, client);
          return Object.freeze({ kind: "started", turnId, turnStatus: "inProgress" });
        } catch (error) {
          if (isRecoverableTransportError(error)) throw error;
          const racedSnapshot = await this.#readThread(threadId, true);
          const racedAccepted = findClientInput(racedSnapshot, clientId);
          if (racedAccepted) return queuedPromptAcceptance(racedAccepted);
          const racedActive = findActiveTurn(racedSnapshot);
          if (racedActive || statusType(racedSnapshot.status) === "active") {
            return Object.freeze({
              kind: "waiting",
              reason: "turn_active",
              turnId: racedActive?.id || state.activeTurnId,
            });
          }
          throw error;
        }
      };

      try {
        return await inspectAcceptedOrWait();
      } catch (error) {
        if (!isRecoverableTransportError(error)) throw error;
        this.log(`reconciling uncertain queued prompt ${clientId} after App Server reconnect`);
        await this.#waitForReady();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const snapshot = await this.#readThread(threadId, true);
          const accepted = findClientInput(snapshot, clientId);
          if (accepted) return queuedPromptAcceptance(accepted, { recoveredAfterReconnect: true });
          const active = findActiveTurn(snapshot);
          if (active || statusType(snapshot.status) === "active") {
            return Object.freeze({
              kind: "waiting",
              reason: "turn_active",
              turnId: active?.id || state.activeTurnId,
            });
          }
          if (attempt === 0) await this.sleepImpl(100);
        }
        return inspectAcceptedOrWait();
      }
    });
  }

  async #startTurn(state, prompt, client) {
    const sandboxMode = this.#resolvedSandboxMode(state.target.threadId);
    const result = await this.#requestPrompt("turn/start", {
      threadId: state.target.threadId,
      cwd: state.target.cwd,
      approvalPolicy: "never",
      sandboxPolicy: turnSandboxPolicy(sandboxMode, state.target.cwd),
      ...client,
    }, prompt);
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex App Server did not return a turn id");
    state.activeTurnId = turnId;
    state.activeTurnStartedAt = result.turn.startedAt;
    state.status = { type: "active", activeFlags: [] };
    return turnId;
  }

  async interrupt(threadId, { pauseGoal = true } = {}) {
    return this.#enqueue(threadId, async () => {
      const state = this.#state(threadId);
      let goalPaused = false;
      const goal = await this.getGoal(threadId, { refresh: true });
      if (pauseGoal && isGoalRunning(goal)) {
        const result = await this.#request("thread/goal/set", { threadId, status: "paused" });
        state.goal = clone(result?.goal || { ...goal, status: "paused" });
        goalPaused = true;
      }
      const snapshot = await this.#readThread(threadId, true);
      const active = findActiveTurn(snapshot);
      const turnId = active?.id || (statusType(snapshot.status) === "active" ? state.activeTurnId : undefined);
      if (!turnId) return Object.freeze({ interrupted: false, goalPaused });
      await this.#request("turn/interrupt", { threadId, turnId });
      return Object.freeze({ interrupted: true, turnId, goalPaused });
    });
  }

  async getStatus(threadId, { refresh = true } = {}) {
    const state = this.#state(threadId);
    if (refresh) {
      await this.#readThread(threadId, true);
      await this.getGoal(threadId, { refresh: true });
    }
    return Object.freeze({
      connected: this.connected,
      threadId,
      status: clone(state.status),
      activeTurnId: state.activeTurnId,
      activeTurnStartedAt: state.activeTurnStartedAt,
      settings: clone(state.settings),
      tokenUsage: clone(state.tokenUsage),
      goal: clone(state.goal),
      lastTurn: clone(state.lastTurn),
      collaborationModeKnown: state.collaborationModeKnown,
      sandboxMode: this.#resolvedSandboxMode(threadId),
    });
  }

  async getGoal(threadId, { refresh = true } = {}) {
    const state = this.#state(threadId);
    if (refresh) {
      const result = await this.#request("thread/goal/get", { threadId });
      state.goal = clone(result?.goal ?? null);
    }
    return clone(state.goal ?? null);
  }

  async startGoal(threadId, objective, { tokenBudget } = {}) {
    const text = String(objective || "").trim();
    if (!text) throw controllerError("goal_objective_required", "Goal objective is required");
    return this.#enqueue(threadId, async () => {
      const snapshot = await this.#readThread(threadId, true);
      if (findActiveTurn(snapshot) || statusType(snapshot.status) === "active") {
        throw controllerError("session_busy", "Pause or stop the current turn before starting a Goal");
      }
      const state = this.#state(threadId);
      await this.#setPlanUnlocked(threadId, false);
      await this.#applyResolvedSandboxMode(state);
      const params = { threadId, objective: text, status: "active" };
      if (tokenBudget !== undefined) params.tokenBudget = tokenBudget;
      const result = await this.#request("thread/goal/set", params);
      state.goal = clone(result?.goal);
      return clone(state.goal);
    });
  }

  async pauseGoal(threadId) {
    return this.#enqueue(threadId, async () => {
      const state = this.#state(threadId);
      const goal = await this.getGoal(threadId, { refresh: true });
      if (!goal) throw controllerError("goal_missing", "This Codex task has no Goal");
      const result = await this.#request("thread/goal/set", { threadId, status: "paused" });
      state.goal = clone(result?.goal || { ...goal, status: "paused" });
      const snapshot = await this.#readThread(threadId, true);
      const active = findActiveTurn(snapshot);
      const turnId = active?.id || (statusType(snapshot.status) === "active" ? state.activeTurnId : undefined);
      if (turnId) await this.#request("turn/interrupt", { threadId, turnId });
      return clone(state.goal);
    });
  }

  async resumeGoal(threadId) {
    return this.#enqueue(threadId, async () => {
      const state = this.#state(threadId);
      const goal = await this.getGoal(threadId, { refresh: true });
      if (!goal) throw controllerError("goal_missing", "This Codex task has no Goal");
      const snapshot = await this.#readThread(threadId, true);
      if (findActiveTurn(snapshot) || statusType(snapshot.status) === "active") {
        throw controllerError("session_busy", "The current turn is still stopping; resume the Goal after it becomes idle");
      }
      await this.#setPlanUnlocked(threadId, false);
      await this.#applyResolvedSandboxMode(state);
      const result = await this.#request("thread/goal/set", { threadId, status: "active" });
      state.goal = clone(result?.goal || { ...goal, status: "active" });
      return clone(state.goal);
    });
  }

  async replaceGoal(threadId, objective) {
    const text = String(objective || "").trim();
    if (!text) throw controllerError("goal_objective_required", "Goal objective is required");
    return this.#enqueue(threadId, async () => {
      const state = this.#state(threadId);
      const oldGoal = await this.getGoal(threadId, { refresh: true });
      if (isGoalRunning(oldGoal)) {
        await this.#request("thread/goal/set", { threadId, status: "paused" });
      }
      const snapshot = await this.#readThread(threadId, true);
      const active = findActiveTurn(snapshot);
      const turnId = active?.id || (statusType(snapshot.status) === "active" ? state.activeTurnId : undefined);
      if (turnId) await this.#request("turn/interrupt", { threadId, turnId });
      if (turnId) await this.#waitForIdle(threadId);
      await this.#setPlanUnlocked(threadId, false);
      await this.#applyResolvedSandboxMode(state);
      const result = await this.#request("thread/goal/set", {
        threadId,
        objective: text,
        status: "active",
        ...(oldGoal?.tokenBudget != null ? { tokenBudget: oldGoal.tokenBudget } : {}),
      });
      state.goal = clone(result?.goal);
      return clone(state.goal);
    });
  }

  async setGoalBudget(threadId, tokenBudget) {
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
      throw controllerError("goal_budget_invalid", "Goal token budget must be a positive integer or null");
    }
    return this.#enqueue(threadId, async () => {
      const state = this.#state(threadId);
      const goal = await this.getGoal(threadId, { refresh: true });
      if (!goal) throw controllerError("goal_missing", "This Codex task has no Goal");
      const result = await this.#request("thread/goal/set", { threadId, tokenBudget });
      state.goal = clone(result?.goal || { ...goal, tokenBudget });
      return clone(state.goal);
    });
  }

  async clearGoal(threadId) {
    return this.#enqueue(threadId, async () => {
      const state = this.#state(threadId);
      const goal = await this.getGoal(threadId, { refresh: true });
      if (!goal) return Object.freeze({ cleared: false });
      if (isGoalRunning(goal)) await this.#request("thread/goal/set", { threadId, status: "paused" });
      const snapshot = await this.#readThread(threadId, true);
      const active = findActiveTurn(snapshot);
      const turnId = active?.id || (statusType(snapshot.status) === "active" ? state.activeTurnId : undefined);
      if (turnId) await this.#request("turn/interrupt", { threadId, turnId });
      if (turnId) await this.#waitForIdle(threadId);
      const result = await this.#request("thread/goal/clear", { threadId });
      state.goal = null;
      return Object.freeze({ cleared: result?.cleared !== false });
    });
  }

  async listModels({ refresh = false } = {}) {
    if (this.modelCache && !refresh) return clone(this.modelCache);
    const models = [];
    let cursor;
    do {
      const result = await this.#request("model/list", { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...(result?.data || []).map(normalizeModelEntry).filter((model) => !model.hidden));
      cursor = result?.nextCursor || undefined;
    } while (cursor);
    this.modelCache = models;
    return clone(models);
  }

  async getModelView(threadId, { refreshCatalog = false } = {}) {
    const state = this.#state(threadId);
    const models = await this.listModels({ refresh: refreshCatalog });
    return Object.freeze({
      settings: clone(state.settings),
      collaborationModeKnown: state.collaborationModeKnown,
      models,
    });
  }

  #resolveModel(models, selection) {
    if (selection == null || String(selection).trim() === "") return undefined;
    const text = String(selection).trim();
    if (/^\d+$/.test(text)) {
      const index = Number(text) - 1;
      return models[index];
    }
    const lower = text.toLowerCase();
    return models.find((entry) => [entry.id, entry.model, entry.displayName]
      .some((value) => String(value || "").toLowerCase() === lower));
  }

  async updateModel(threadId, { model, effort, serviceTier, reset = false } = {}) {
    return this.#enqueue(threadId, async () => {
      const state = this.#state(threadId);
      const models = await this.listModels();
      if (models.length === 0) throw controllerError("model_catalog_empty", "Codex returned no available models");
      const current = this.#resolveModel(models, state.settings.model) || models.find((entry) => entry.isDefault) || models[0];
      const selected = reset
        ? (models.find((entry) => entry.isDefault) || models[0])
        : (model === undefined ? current : this.#resolveModel(models, model));
      if (!selected) throw controllerError("model_unknown", "The requested model is not in the current Codex model catalog");
      const selectedModel = selected.model || selected.id;
      const supportedEfforts = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort);
      const modelChanged = selectedModel !== (current.model || current.id);
      const selectedEffort = reset
        ? selected.defaultReasoningEffort
        : (effort === undefined
          ? (
              !modelChanged || state.settings.effort == null || supportedEfforts.includes(state.settings.effort)
                ? state.settings.effort
                : selected.defaultReasoningEffort
            )
          : String(effort).trim().toLowerCase());
      if (selectedEffort != null && supportedEfforts.length > 0 && !supportedEfforts.includes(selectedEffort)) {
        throw controllerError("reasoning_effort_unsupported", `Model ${selectedModel} does not support reasoning effort ${selectedEffort}`);
      }
      const tiers = unique([
        ...selected.serviceTiers.map((tier) => tier.id),
        ...selected.additionalSpeedTiers,
      ]);
      const defaultTier = resolveServiceTier(selected, selected.defaultServiceTier);
      const currentTier = resolveServiceTier(selected, state.settings.serviceTier);
      const selectedTier = reset ? defaultTier :
        (serviceTier === undefined
          ? (
              !modelChanged || currentTier == null || tiers.includes(currentTier)
                ? currentTier
                : defaultTier
            )
          : resolveServiceTier(selected, serviceTier));
      if (selectedTier != null && !tiers.includes(selectedTier)) {
        throw controllerError("service_tier_unsupported", `Model ${selectedModel} does not support service tier ${selectedTier}`);
      }
      const params = {
        threadId,
        model: selectedModel,
        effort: selectedEffort ?? null,
        serviceTier: selectedTier ?? null,
      };
      const currentMode = state.collaborationModeKnown ? state.settings.collaborationMode?.mode : undefined;
      if (currentMode) {
        params.collaborationMode = {
          mode: currentMode,
          settings: {
            model: selectedModel,
            reasoning_effort: selectedEffort ?? null,
            developer_instructions: null,
          },
        };
      }
      await this.#request("thread/settings/update", params);
      state.settings = {
        ...state.settings,
        model: selectedModel,
        effort: selectedEffort ?? null,
        serviceTier: selectedTier ?? null,
        ...(params.collaborationMode ? { collaborationMode: clone(params.collaborationMode) } : {}),
      };
      return Object.freeze({
        model: selectedModel,
        effort: selectedEffort ?? null,
        serviceTier: selectedTier ?? null,
        supportedEfforts: clone(supportedEfforts),
        supportedServiceTiers: clone(tiers),
      });
    });
  }

  async listCollaborationModes({ refresh = false } = {}) {
    if (this.collaborationModeCache && !refresh) return clone(this.collaborationModeCache);
    const result = await this.#request("collaborationMode/list", {});
    this.collaborationModeCache = Array.isArray(result?.data) ? result.data : [];
    return clone(this.collaborationModeCache);
  }

  async setPlan(threadId, enabled) {
    return this.#enqueue(threadId, () => this.#setPlanUnlocked(threadId, Boolean(enabled)));
  }

  async #setPlanUnlocked(threadId, enabled) {
    const state = this.#state(threadId);
    if (enabled) {
      const goal = await this.getGoal(threadId, { refresh: true });
      if (isGoalRunning(goal)) {
        throw controllerError("goal_active", "Pause the active Goal before entering Plan mode");
      }
    }
    const mode = enabled ? "plan" : "default";
    const masks = await this.listCollaborationModes();
    const mask = masks.find((entry) => entry?.mode === mode);
    if (!mask) throw controllerError("collaboration_mode_unavailable", `Codex did not provide the ${mode} mode preset`);
    const model = mask.model || state.settings.model;
    if (!model) throw controllerError("model_unknown", "The current Codex model is unknown");
    const reasoningEffort = mask.reasoning_effort ?? state.settings.effort ?? null;
    const collaborationMode = {
      mode,
      settings: {
        model,
        reasoning_effort: reasoningEffort,
        developer_instructions: null,
      },
    };
    await this.#request("thread/settings/update", { threadId, collaborationMode });
    state.settings = {
      ...state.settings,
      model,
      effort: reasoningEffort,
      collaborationMode: clone(collaborationMode),
    };
    state.collaborationModeKnown = true;
    return clone(collaborationMode);
  }
}
