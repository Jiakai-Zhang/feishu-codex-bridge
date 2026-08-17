import { CodexAppServerConnection } from "./codex-app-server-connection.mjs";
import { CodexTurnCollector } from "./codex-turn-collector.mjs";
export * from "./codex-turn-collector.mjs";

export class CodexSessionObserver {
  constructor({
    appServerUrl,
    targets,
    sandboxMode,
    onExternalTurn,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = 30_000,
    reconnectDelayMs = 2_000,
    log = () => {},
  }) {
    if (!appServerUrl) throw new TypeError("appServerUrl is required");
    if (typeof WebSocketImpl !== "function") throw new TypeError("A WebSocket implementation is required");
    this.appServerUrl = appServerUrl;
    this.targets = (targets || []).map((target) => Object.freeze({ ...target }));
    this.sandboxMode = sandboxMode;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.log = log;
    this.collector = new CodexTurnCollector({
      targets: this.targets,
      onExternalTurn,
      onError: (error) => this.log(`external turn callback failed: ${error instanceof Error ? error.name : "unknown"}`),
    });
    this.connection = undefined;
    this.reconnectTimer = undefined;
    this.stopped = true;
    this.hasConnected = false;
    this.disconnectedAtMs = undefined;
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
    if (connection) connection.close(new Error("Codex session observer stopped"));
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.#connect();
        this.log("Codex session observer reconnected");
      } catch (error) {
        this.log(`Codex session observer reconnect failed: ${error instanceof Error ? error.name : "unknown"}`);
        this.#scheduleReconnect();
      }
    }, this.reconnectDelayMs);
  }

  async #connect() {
    let connection;
    connection = new CodexAppServerConnection({
      url: this.appServerUrl,
      WebSocketImpl: this.WebSocketImpl,
      requestTimeoutMs: this.requestTimeoutMs,
      clientLabel: "observer",
      log: this.log,
      onNotification: (method, params) => this.collector.handleNotification(method, params),
      onClose: ({ intentional }) => {
        if (this.connection === connection) this.connection = undefined;
        if (!intentional && !this.stopped && this.hasConnected) {
          this.disconnectedAtMs = Date.now();
          this.log("Codex session observer disconnected; reconnect scheduled");
          this.#scheduleReconnect();
        }
      },
    });
    this.connection = connection;

    try {
      await connection.open();
      await connection.request("initialize", {
        clientInfo: {
          name: "feishu_codex_session_observer",
          title: "Feishu Codex Session Observer",
          version: "1.0.0",
        },
      });
      connection.notify("initialized");
      const catchUpAfterMs = this.hasConnected ? this.disconnectedAtMs : undefined;
      for (const target of this.targets) {
        const result = await connection.request("thread/resume", {
          threadId: target.threadId,
          cwd: target.cwd,
          approvalPolicy: "never",
          sandbox: this.sandboxMode,
        });
        if (result?.thread?.id !== target.threadId) {
          throw new Error("Codex session observer resumed a different task than its binding");
        }
        const snapshot = await connection.request("thread/read", {
          threadId: target.threadId,
          includeTurns: true,
        });
        this.collector.seedThread(snapshot?.thread, { catchUpAfterMs });
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

}
