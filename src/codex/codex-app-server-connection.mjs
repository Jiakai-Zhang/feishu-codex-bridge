export class CodexAppServerRpcError extends Error {
  constructor(method, error) {
    super(`Codex App Server ${method} failed: ${String(error?.message || "unknown error")}`);
    this.name = "CodexAppServerRpcError";
    this.code = "codex_app_server_error";
    this.method = method;
    this.rpcCode = error?.code;
    this.rpcData = error?.data;
  }
}

function transportError(code, message, name) {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}

export class CodexAppServerConnection {
  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = 30_000,
    clientLabel = "client",
    onNotification = () => {},
    onClose = () => {},
    log = () => {},
  }) {
    if (!url) throw new TypeError("Codex App Server URL is required");
    if (typeof WebSocketImpl !== "function") throw new TypeError("A WebSocket implementation is required");
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientLabel = clientLabel;
    this.onNotification = onNotification;
    this.onClose = onClose;
    this.log = log;
    this.socket = undefined;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.opened = false;
    this.ready = false;
    this.closed = false;
    this.intentionalClose = false;
  }

  async open() {
    if (this.socket) throw new Error("Codex App Server connection has already been opened");
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.#handleMessage(event));
    socket.addEventListener("close", (event) => this.#handleClose(event));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(transportError(
          "codex_app_server_unavailable",
          `Timed out connecting the Codex session ${this.clientLabel}`,
          "CodexAppServerConnectError",
        ));
        try { socket.close(); } catch {}
      }, this.requestTimeoutMs);
      timer.unref?.();
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.opened = true;
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(transportError(
          "codex_app_server_unavailable",
          `Could not connect the Codex session ${this.clientLabel}`,
          "CodexAppServerConnectError",
        ));
      }, { once: true });
    });
  }

  activate() {
    if (!this.opened || this.closed) throw new Error("Cannot activate a closed Codex App Server connection");
    this.ready = true;
  }

  request(method, params) {
    if (!this.opened || this.closed || !this.socket) {
      throw transportError(
        "codex_app_server_unavailable",
        `Codex session ${this.clientLabel} connection is closed`,
        "CodexAppServerConnectionError",
      );
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(transportError(
          "codex_app_server_timeout",
          `Codex App Server ${method} timed out`,
          "CodexAppServerTimeoutError",
        ));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.#send({ method, id, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (!method) throw new TypeError("Codex App Server notification method is required");
    this.#send({ method, params });
  }

  rejectPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  close(error = transportError(
    "codex_app_server_unavailable",
    `Codex session ${this.clientLabel} stopped`,
    "CodexAppServerConnectionError",
  )) {
    this.intentionalClose = true;
    this.ready = false;
    this.rejectPending(error);
    try { this.socket?.close(); } catch {}
  }

  #send(message) {
    if (this.closed || !this.socket) {
      throw transportError(
        "codex_app_server_unavailable",
        `Codex session ${this.clientLabel} connection is closed`,
        "CodexAppServerConnectionError",
      );
    }
    this.socket.send(JSON.stringify(message));
  }

  #handleMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch (error) {
      this.log(`Codex session ${this.clientLabel} ignored invalid JSON: ${error instanceof Error ? error.name : "unknown"}`);
      return;
    }
    if (message?.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CodexAppServerRpcError(entry.method, message.error));
      else entry.resolve(message.result);
      return;
    }
    if (message?.method && message?.id !== undefined) {
      try {
        this.#send({ id: message.id, error: { code: -32601, message: `Unsupported ${this.clientLabel} request: ${message.method}` } });
      } catch {}
      return;
    }
    if (message?.method) this.onNotification(message.method, message.params || {});
  }

  #handleClose(event) {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    this.ready = false;
    const error = transportError(
      "codex_app_server_unavailable",
      `Codex session ${this.clientLabel} connection closed (code ${event.code})`,
      "CodexAppServerConnectionError",
    );
    this.rejectPending(error);
    this.onClose({ code: event.code, intentional: this.intentionalClose, error });
  }
}
