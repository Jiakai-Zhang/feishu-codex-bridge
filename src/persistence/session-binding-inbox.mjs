import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_FILE = /^([0-9a-f-]{36})\.request\.json$/i;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function safeFailure(error) {
  return {
    ok: false,
    error: {
      code: String(error?.code || "session_binding_failed").slice(0, 80),
      message: String(error?.message || "Session binding failed").slice(0, 300),
      missingScopes: Array.isArray(error?.missingScopes)
        ? error.missingScopes.filter((value) => typeof value === "string").slice(0, 10)
        : undefined,
    },
  };
}

export class SessionBindingInbox {
  constructor({ directory, handleRequest, now = () => Date.now(), maxAgeMs = 10 * 60_000 }) {
    if (!directory) throw new TypeError("Session binding inbox directory is required");
    this.directory = path.resolve(directory);
    this.handleRequest = handleRequest;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.running = false;
  }

  async open() {
    await fs.mkdir(this.directory, { recursive: true });
    return this;
  }

  async poll() {
    if (this.running) return [];
    this.running = true;
    const completed = [];
    try {
      let names;
      try { names = await fs.readdir(this.directory); }
      catch (error) {
        if (error?.code === "ENOENT") return completed;
        throw error;
      }
      for (const name of names.sort()) {
        const match = REQUEST_FILE.exec(name);
        if (!match) continue;
        const requestId = match[1];
        const requestPath = path.join(this.directory, name);
        const processingPath = path.join(this.directory, `${requestId}.processing.json`);
        const responsePath = path.join(this.directory, `${requestId}.response.json`);
        try { await fs.rename(requestPath, processingPath); }
        catch (error) {
          if (["ENOENT", "EEXIST"].includes(error?.code)) continue;
          throw error;
        }

        let response;
        try {
          const request = JSON.parse(await fs.readFile(processingPath, "utf8"));
          if (request?.requestId !== requestId || !THREAD_ID.test(String(request?.threadId || ""))) {
            throw Object.assign(new Error("Invalid session binding request"), { code: "invalid_binding_request" });
          }
          if (!Number.isFinite(Number(request.createdAt)) || this.now() - Number(request.createdAt) > this.maxAgeMs) {
            throw Object.assign(new Error("Session binding request expired"), { code: "binding_request_expired" });
          }
          const result = await this.handleRequest({
            requestId,
            threadId: request.threadId,
          });
          response = {
            ok: true,
            result: {
              alreadyBound: Boolean(result?.alreadyBound),
              groupName: result?.groupName,
              feedGroupName: result?.feedGroupName,
              restart: Boolean(result?.restart),
            },
          };
        } catch (error) {
          response = safeFailure(error);
        }
        await writeJsonAtomic(responsePath, {
          schemaVersion: 1,
          requestId,
          completedAt: this.now(),
          ...response,
        });
        await fs.rm(processingPath, { force: true });
        completed.push({ requestId, response });
      }
      return completed;
    } finally {
      this.running = false;
    }
  }
}

export async function requestSessionBinding({
  directory,
  threadId,
  timeoutMs = 120_000,
  pollMs = 250,
  now = () => Date.now(),
  sleep = delay,
}) {
  if (!THREAD_ID.test(String(threadId || ""))) throw new TypeError("A valid CODEX_THREAD_ID is required");
  const inbox = path.resolve(directory);
  await fs.mkdir(inbox, { recursive: true });
  const requestId = randomUUID();
  const requestPath = path.join(inbox, `${requestId}.request.json`);
  const responsePath = path.join(inbox, `${requestId}.response.json`);
  await writeJsonAtomic(requestPath, {
    schemaVersion: 1,
    requestId,
    threadId,
    createdAt: now(),
  });
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const response = JSON.parse(await fs.readFile(responsePath, "utf8"));
      if (response?.requestId !== requestId) throw new Error("Session binding response id mismatch");
      await fs.rm(responsePath, { force: true });
      return response;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(pollMs);
  }
  throw Object.assign(new Error("Bridge did not answer the session binding request in time"), {
    code: "binding_request_timeout",
  });
}
