import { spawn as nodeSpawn } from "node:child_process";

export function startCodexProjectThread({
  codexExecutable,
  cwd,
  name,
  sandboxMode,
  appServerUrl,
  timeoutMs = 30_000,
  spawnProcess = nodeSpawn,
  WebSocketImpl = globalThis.WebSocket,
}) {
  if (appServerUrl) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocketImpl !== "function") {
        reject(new Error("This Node.js runtime does not provide a WebSocket client"));
        return;
      }
      const socket = new WebSocketImpl(appServerUrl);
      let settled = false;
      let thread;
      const timer = setTimeout(() => finish(new Error("Codex App Server timed out while creating a task")), timeoutMs);
      timer.unref?.();
      const send = (message) => socket.send(JSON.stringify(message));
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        if (error) reject(error);
        else resolve(value);
      }
      const rpcError = (method, error) => new Error(
        `Codex App Server ${method} failed: ${String(error?.message || "unknown error")}`,
      );
      socket.addEventListener("open", () => send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "feishu_codex_session_relay",
            title: "Feishu Codex Session Relay",
            version: "1.0.0",
          },
        },
      }), { once: true });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.id === 1) {
            if (message.error) return finish(rpcError("initialize", message.error));
            send({ method: "initialized", params: {} });
            send({
              method: "thread/start",
              id: 2,
              params: {
                cwd,
                approvalPolicy: "never",
                sandbox: sandboxMode,
                serviceName: "feishu-codex-session-relay",
              },
            });
          } else if (message.id === 2) {
            if (message.error) return finish(rpcError("thread/start", message.error));
            thread = message.result?.thread;
            if (!thread?.id) return finish(new Error("Codex App Server did not return a thread id"));
            send({ method: "thread/name/set", id: 3, params: { threadId: thread.id, name } });
          } else if (message.id === 3) {
            if (message.error) return finish(rpcError("thread/name/set", message.error));
            finish(undefined, { ...thread, name });
          }
        } catch (error) {
          finish(error);
        }
      });
      socket.addEventListener("error", () => finish(new Error("Could not connect to the shared Codex App Server")), { once: true });
      socket.addEventListener("close", () => {
        if (!settled) finish(new Error("Shared Codex App Server closed before task creation"));
      });
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(codexExecutable, ["app-server"], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let thread;
    let settled = false;

    const timer = setTimeout(() => finish(new Error("Codex App Server timed out while creating a Project task")), timeoutMs);
    timer.unref?.();

    const send = (message) => {
      child.stdin.write(Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
    };
    const stop = () => {
      try { child.stdin.end(); } catch {}
      const killTimer = setTimeout(() => {
        try { child.kill(); } catch {}
      }, 1000);
      killTimer.unref?.();
    };
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error);
      else resolve(value);
    }
    const rpcError = (message) => {
      const detail = message?.error?.message || JSON.stringify(message?.error || {});
      return new Error(`Codex App Server request failed: ${detail}`);
    };
    const handleMessage = (message) => {
      if (message.id === 1) {
        if (message.error) return finish(rpcError(message));
        send({ method: "initialized", params: {} });
        send({
          method: "thread/start",
          id: 2,
          params: {
            cwd,
            approvalPolicy: "never",
            sandbox: sandboxMode,
            serviceName: "feishu-codex-project-bridge",
          },
        });
        return;
      }
      if (message.id === 2) {
        if (message.error) return finish(rpcError(message));
        thread = message.result?.thread;
        if (!thread?.id) return finish(new Error("Codex App Server did not return a thread id"));
        send({
          method: "thread/name/set",
          id: 3,
          params: { threadId: thread.id, name },
        });
        return;
      }
      if (message.id === 3) {
        if (message.error) return finish(rpcError(message));
        finish(undefined, { ...thread, name });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try { handleMessage(JSON.parse(line)); }
        catch (error) { finish(error); }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Codex App Server exited before task creation (code ${code}): ${stderr.slice(-1000)}`));
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "feishu_codex_project_bridge",
          title: "Feishu Codex Project Bridge",
          version: "1.0.0",
        },
      },
    });
  });
}

export function setCodexThreadName({
  codexExecutable,
  cwd,
  threadId,
  name,
  appServerUrl,
  timeoutMs = 30_000,
  spawnProcess = nodeSpawn,
  WebSocketImpl = globalThis.WebSocket,
}) {
  if (appServerUrl) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocketImpl !== "function") {
        reject(new Error("This Node.js runtime does not provide a WebSocket client"));
        return;
      }
      const socket = new WebSocketImpl(appServerUrl);
      let settled = false;
      const timer = setTimeout(() => finish(new Error("Codex App Server timed out while naming a task")), timeoutMs);
      timer.unref?.();
      const send = (message) => socket.send(JSON.stringify(message));
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        if (error) reject(error);
        else resolve({ threadId, name });
      }
      const handleMessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.id === 1) {
            if (message.error) return finish(new Error(`Codex App Server initialize failed: ${message.error.message || "unknown"}`));
            send({ method: "initialized", params: {} });
            send({ method: "thread/name/set", id: 2, params: { threadId, name } });
          } else if (message.id === 2) {
            if (message.error) return finish(new Error(`Codex App Server name update failed: ${message.error.message || "unknown"}`));
            finish();
          }
        } catch (error) {
          finish(error);
        }
      };
      socket.addEventListener("open", () => send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "feishu_codex_session_relay",
            title: "Feishu Codex Session Relay",
            version: "1.0.0",
          },
        },
      }), { once: true });
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("error", () => finish(new Error("Could not connect to the shared Codex App Server")), { once: true });
      socket.addEventListener("close", () => {
        if (!settled) finish(new Error("Shared Codex App Server closed before naming the task"));
      });
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(codexExecutable, ["app-server"], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => finish(new Error("Codex App Server timed out while naming a task")), timeoutMs);
    timer.unref?.();
    const send = (message) => child.stdin.write(Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
    const stop = () => {
      try { child.stdin.end(); } catch {}
      const killTimer = setTimeout(() => {
        try { child.kill(); } catch {}
      }, 1000);
      killTimer.unref?.();
    };
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error);
      else resolve({ threadId, name });
    }
    const handleMessage = (message) => {
      if (message.id === 1) {
        if (message.error) return finish(new Error(`Codex App Server initialize failed: ${message.error.message || "unknown"}`));
        send({ method: "initialized", params: {} });
        send({ method: "thread/name/set", id: 2, params: { threadId, name } });
        return;
      }
      if (message.id === 2) {
        if (message.error) return finish(new Error(`Codex App Server name update failed: ${message.error.message || "unknown"}`));
        finish();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try { handleMessage(JSON.parse(line)); }
        catch (error) { finish(error); }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Codex App Server exited before naming the task (code ${code}): ${stderr.slice(-1000)}`));
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "feishu_codex_session_relay",
          title: "Feishu Codex Session Relay",
          version: "1.0.0",
        },
      },
    });
  });
}
