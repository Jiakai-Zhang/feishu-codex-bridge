import { spawn as nodeSpawn } from "node:child_process";

export function startCodexProjectThread({
  codexExecutable,
  cwd,
  name,
  sandboxMode,
  timeoutMs = 30_000,
  spawnProcess = nodeSpawn,
}) {
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
