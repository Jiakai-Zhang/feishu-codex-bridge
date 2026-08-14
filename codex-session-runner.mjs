import { spawn as nodeSpawn } from "node:child_process";

const ACTIVE_WRITER_PATTERN = /already has an active writer/i;

class CodexAppServerRpcError extends Error {
  constructor(method, error) {
    const detail = String(error?.message || "unknown App Server error");
    super(`Codex App Server ${method} failed: ${detail}`);
    this.name = "CodexAppServerRpcError";
    this.code = "codex_app_server_error";
    this.method = method;
    this.rpcCode = error?.code;
    this.rpcData = error?.data;
  }
}

export class CodexSessionBusyError extends Error {
  constructor(message = "The bound Codex task is still owned by another writer", options = {}) {
    super(message, options);
    this.name = "CodexSessionBusyError";
    this.code = "session_busy";
  }
}

export function isActiveWriterError(error) {
  return ACTIVE_WRITER_PATTERN.test(String(error?.message || ""));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function turnError(turn, fallback) {
  const detail = String(turn?.error?.message || fallback);
  const error = new Error(`Codex turn ${turn?.status || "failed"}: ${detail}`);
  error.name = "CodexTurnError";
  error.code = "codex_turn_failed";
  return error;
}

function normalizeAnswer(answer, maxReplyChars) {
  let text = String(answer || "").trim();
  if (!text) text = "Codex 已完成处理，但没有返回文本结果。";
  if (text.length > maxReplyChars) {
    text = `${text.slice(0, maxReplyChars)}\n\n（回复过长，已截断；完整结果保留在绑定的 Codex 任务中。）`;
  }
  return text;
}

export async function runCodexSessionTurn({
  codexExecutable,
  session,
  prompt,
  sandboxMode,
  appServerUrl,
  clientUserMessageId,
  maxReplyChars = 10_000,
  writerRetryMs = 2_000,
  writerWaitMs = 15 * 60_000,
  requestTimeoutMs = 30_000,
  turnTimeoutMs = 0,
  spawnProcess = nodeSpawn,
  WebSocketImpl = globalThis.WebSocket,
  sleepImpl = delay,
  log = () => {},
}) {
  const content = String(prompt || "");
  if (!content.trim()) throw new TypeError("Codex prompt is empty");
  if (!session?.id || !session.cwd) throw new TypeError("A persisted Codex session is required");
  if (!codexExecutable) throw new TypeError("codexExecutable is required");

  let nextRequestId = 1;
  let clientClosed = false;
  let resumed = false;
  let notificationHandler = () => {};
  let sendTransport;
  let closeTransport = () => {};
  let transportReady = Promise.resolve();
  const pending = new Map();

  function send(message) {
    if (clientClosed) throw new Error("Codex App Server client is closed");
    sendTransport(JSON.stringify(message));
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function request(method, params, timeoutMs = requestTimeoutMs) {
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`Codex App Server ${method} timed out`);
        error.name = "CodexAppServerTimeoutError";
        error.code = "codex_app_server_timeout";
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { method, resolve, reject, timer });
      try {
        send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function handleMessage(message) {
    if (message?.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CodexAppServerRpcError(entry.method, message.error));
      else entry.resolve(message.result);
      return;
    }
    if (message?.method && message?.id !== undefined) {
      send({
        id: message.id,
        error: { code: -32601, message: `Unsupported App Server request: ${message.method}` },
      });
      return;
    }
    if (message?.method) notificationHandler(message.method, message.params || {});
  }

  function failTransport(error) {
    if (clientClosed) return;
    rejectPending(error);
    notificationHandler("client/closed", { error });
  }

  function parseMessage(text) {
    try {
      handleMessage(JSON.parse(String(text)));
    } catch (error) {
      failTransport(error);
    }
  }

  if (appServerUrl) {
    if (typeof WebSocketImpl !== "function") throw new Error("This Node.js runtime does not provide a WebSocket client");
    const socket = new WebSocketImpl(appServerUrl);
    transportReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("Timed out connecting to the shared Codex App Server");
        error.name = "CodexAppServerConnectError";
        error.code = "codex_app_server_unavailable";
        reject(error);
        try { socket.close(); } catch {}
      }, requestTimeoutMs);
      timer.unref?.();
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        const error = new Error("Could not connect to the shared Codex App Server");
        error.name = "CodexAppServerConnectError";
        error.code = "codex_app_server_unavailable";
        reject(error);
        failTransport(error);
      }, { once: true });
    });
    socket.addEventListener("message", (event) => parseMessage(event.data));
    socket.addEventListener("close", (event) => {
      const error = new Error(`Shared Codex App Server connection closed (code ${event.code})`);
      error.name = "CodexAppServerExitError";
      error.code = "codex_app_server_exit";
      failTransport(error);
    });
    sendTransport = (text) => socket.send(text);
    closeTransport = () => socket.close();
  } else {
    const child = spawnProcess(codexExecutable, ["app-server"], {
      cwd: session.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) parseMessage(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += chunk;
    });
    child.on("error", (error) => failTransport(error));
    child.on("close", (code) => {
      if (clientClosed) return;
      const detail = stderr.trim().slice(-1_000);
      const error = new Error(`Codex App Server exited unexpectedly (code ${code})${detail ? `: ${detail}` : ""}`);
      error.name = "CodexAppServerExitError";
      error.code = "codex_app_server_exit";
      failTransport(error);
    });
    sendTransport = (text) => child.stdin.write(Buffer.from(`${text}\n`, "utf8"));
    closeTransport = () => {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    };
  }

  function closeClient() {
    if (clientClosed) return;
    clientClosed = true;
    notificationHandler = () => {};
    rejectPending(new Error("Codex App Server client closed"));
    try { closeTransport(); } catch {}
  }

  try {
    await transportReady;
    await request("initialize", {
      clientInfo: {
        name: "feishu_codex_session_relay",
        title: "Feishu Codex Session Relay",
        version: "1.0.0",
      },
    });

    const waitStartedAt = Date.now();
    let waitingWasLogged = false;
    let resumedStatus;
    for (;;) {
      try {
        const result = await request("thread/resume", {
          threadId: session.id,
          cwd: session.cwd,
          approvalPolicy: "never",
          sandbox: sandboxMode,
        });
        if (result?.thread?.id !== session.id) {
          throw new Error("Codex App Server resumed a different task than the bound task");
        }
        resumedStatus = result.thread.status?.type;
        resumed = true;
        break;
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        const elapsed = Date.now() - waitStartedAt;
        if (writerWaitMs > 0 && elapsed >= writerWaitMs) {
          throw new CodexSessionBusyError(undefined, { cause: error });
        }
        if (!waitingWasLogged) {
          waitingWasLogged = true;
          log("bound Codex task is open in another writer; waiting for ownership handoff");
        }
        await sleepImpl(Math.max(0, writerRetryMs));
      }
    }

    if (resumedStatus === "active") {
      log("bound Codex task is running; waiting for the current turn to finish");
      for (;;) {
        const elapsed = Date.now() - waitStartedAt;
        if (writerWaitMs > 0 && elapsed >= writerWaitMs) {
          throw new CodexSessionBusyError("The bound Codex task did not become idle in time");
        }
        await sleepImpl(Math.max(0, writerRetryMs));
        const readResult = await request("thread/read", {
          threadId: session.id,
          includeTurns: false,
        });
        resumedStatus = readResult?.thread?.status?.type;
        if (resumedStatus === "idle") break;
        if (resumedStatus === "systemError") {
          throw new Error("The bound Codex task entered a system error state");
        }
      }
    } else if (resumedStatus && resumedStatus !== "idle") {
      throw new Error(`The bound Codex task is not ready (status ${resumedStatus})`);
    }

    let targetTurnId;
    let finalAnswer = "";
    let unphasedAnswer = "";
    let earlyCompletion;
    let completionSettled = false;
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const collectItem = (item) => {
      if (item?.type !== "agentMessage") return;
      const text = String(item.text || "").trim();
      if (!text) return;
      if (item.phase === "final_answer") finalAnswer = text;
      else if (item.phase == null) unphasedAnswer = text;
    };
    const completeTurn = (params) => {
      if (completionSettled) return;
      const turn = params?.turn;
      if (!turn?.id || (targetTurnId && turn.id !== targetTurnId)) return;
      for (const item of turn.items || []) collectItem(item);
      completionSettled = true;
      if (turn.status === "completed") resolveCompletion(finalAnswer || unphasedAnswer);
      else rejectCompletion(turnError(turn, "The Codex turn did not complete"));
    };

    notificationHandler = (method, params) => {
      if (method === "client/closed") {
        if (!completionSettled) {
          completionSettled = true;
          rejectCompletion(params.error);
        }
        return;
      }
      if (params?.threadId !== session.id) return;
      const notificationTurnId = params.turnId || params.turn?.id;
      if (targetTurnId && notificationTurnId && notificationTurnId !== targetTurnId) return;
      if (method === "item/completed") {
        collectItem(params.item);
      } else if (method === "turn/completed") {
        if (targetTurnId) completeTurn(params);
        else earlyCompletion = params;
      } else if (method === "error" && params.willRetry === false && !completionSettled) {
        const detail = String(params.error?.message || "Codex reported a turn error");
        log(`Codex turn error notification: ${detail.slice(0, 300)}`);
      }
    };

    const startResult = await request("turn/start", {
      threadId: session.id,
      input: [{ type: "text", text: content, text_elements: [] }],
      cwd: session.cwd,
      approvalPolicy: "never",
      ...(clientUserMessageId ? { clientUserMessageId: String(clientUserMessageId) } : {}),
    });
    targetTurnId = startResult?.turn?.id;
    if (!targetTurnId) throw new Error("Codex App Server did not return a turn id");
    if (earlyCompletion) completeTurn(earlyCompletion);

    let answer;
    if (turnTimeoutMs > 0) {
      let timeout;
      try {
        answer = await Promise.race([
          completion,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              const error = new Error("Codex turn timed out");
              error.name = "CodexTurnTimeoutError";
              error.code = "codex_turn_timeout";
              reject(error);
            }, turnTimeoutMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    } else {
      answer = await completion;
    }
    return normalizeAnswer(answer, maxReplyChars);
  } finally {
    notificationHandler = () => {};
    if (resumed && !clientClosed) {
      try {
        await request("thread/unsubscribe", { threadId: session.id });
      } catch (error) {
        log(`could not release the bound Codex task cleanly: ${error instanceof Error ? error.name : "unknown"}`);
      }
    }
    closeClient();
  }
}
