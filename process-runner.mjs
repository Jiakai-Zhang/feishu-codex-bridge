import { spawn as nodeSpawn } from "node:child_process";

async function stopProcessTree(child, {
  spawnProcess = nodeSpawn,
  platform = process.platform,
  killWaitMs = 5_000,
} = {}) {
  if (child.exitCode !== null) return;
  if (platform !== "win32") {
    child.kill();
    return;
  }

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      try { child.kill(); }
      catch {}
      finish();
    }, killWaitMs);
    timer.unref?.();
    killer.once("close", finish);
    killer.once("error", () => {
      try { child.kill(); }
      catch {}
      finish();
    });
  });
}

export function runProcess(executable, args, {
  input,
  cwd,
  maxOutputBytes = 5_000_000,
  onStdoutLine,
  logicalCompletionGraceMs = 15_000,
  completionProbe,
  completionPollMs = 30_000,
  onCompletionProbeError,
  spawnProcess = nodeSpawn,
  stopProcessTreeImpl = stopProcessTree,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutLineBuffer = "";
    let logicalCompletionSeen = false;
    let forcedAfterLogicalCompletion = false;
    let recoveredAnswer;
    let completionStopTimer;
    let completionProbeTimer;
    let completionProbeInFlight = false;
    let settled = false;

    const clearLifecycleTimers = () => {
      if (completionStopTimer) clearTimeout(completionStopTimer);
      if (completionProbeTimer) clearInterval(completionProbeTimer);
    };

    const handleStdoutLine = (line) => {
      let completed = false;
      try { completed = onStdoutLine?.(line) === true; }
      catch {}
      if (completed && !logicalCompletionSeen) {
        logicalCompletionSeen = true;
        scheduleCompletionStop();
      }
    };

    const flushLastStdoutLine = () => {
      const lastLine = stdoutLineBuffer.trim();
      stdoutLineBuffer = "";
      if (onStdoutLine && lastLine) handleStdoutLine(lastLine);
    };

    const result = (code) => ({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      outputTruncated: stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes,
      logicalCompletionSeen,
      forcedAfterLogicalCompletion,
      recoveredAnswer,
    });

    const settle = (code) => {
      if (settled) return;
      settled = true;
      flushLastStdoutLine();
      clearLifecycleTimers();
      resolve(result(code));
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearLifecycleTimers();
      reject(error);
    };

    const settleAfterLogicalCompletion = async () => {
      if (settled) return;
      forcedAfterLogicalCompletion = true;
      try { await stopProcessTreeImpl(child); }
      catch {}
      if (settled) return;
      flushLastStdoutLine();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref?.();
      settle(child.exitCode ?? 0);
    };

    function scheduleCompletionStop() {
      if (completionStopTimer || settled) return;
      completionStopTimer = setTimeout(
        () => void settleAfterLogicalCompletion(),
        logicalCompletionGraceMs,
      );
      completionStopTimer.unref?.();
    }

    const pollCompletion = async () => {
      if (!completionProbe || completionProbeInFlight || logicalCompletionSeen || settled) return;
      completionProbeInFlight = true;
      try {
        const completion = await completionProbe();
        if (!completion || logicalCompletionSeen || settled) return;
        logicalCompletionSeen = true;
        recoveredAnswer = completion.answer;
        await settleAfterLogicalCompletion();
      } catch (error) {
        onCompletionProbeError?.(error);
      } finally {
        completionProbeInFlight = false;
      }
    };

    if (completionProbe) {
      completionProbeTimer = setInterval(() => void pollCompletion(), completionPollMs);
      completionProbeTimer.unref?.();
    }
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutputBytes) stdout.push(chunk);
      if (onStdoutLine) {
        stdoutLineBuffer += chunk.toString("utf8");
        for (;;) {
          const newline = stdoutLineBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutLineBuffer.slice(0, newline).trim();
          stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
          if (line) handleStdoutLine(line);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxOutputBytes) stderr.push(chunk);
    });
    child.on("error", (error) => {
      if (logicalCompletionSeen) void settleAfterLogicalCompletion();
      else rejectOnce(error);
    });
    child.on("close", (code) => settle(code));
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) child.stdin.end(input);
    else child.stdin.end(input ?? "", "utf8");
  });
}
