import { execFile as nodeExecFile } from "node:child_process";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

async function openLocalUrl(url) {
  await execFile("/usr/bin/open", [url], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 64_000,
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function openPrivateFeishuUrl(targetUrl, {
  open = openLocalUrl,
  timeoutMs = 20_000,
} = {}) {
  const target = new URL(String(targetUrl || ""));
  if (
    target.origin !== "https://open.feishu.cn"
    || target.username
    || target.password
  ) {
    throw new TypeError("The private browser target must use the Feishu Open Platform");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new TypeError("The private browser timeout must be between 1000 and 60000 milliseconds");
  }

  const requestPath = `/${randomUUID()}`;
  let redirectResolve;
  let redirectReject;
  const redirected = new Promise((resolve, reject) => {
    redirectResolve = resolve;
    redirectReject = reject;
  });
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== requestPath) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(302, {
      "Cache-Control": "no-store",
      Location: target.href,
      "Referrer-Policy": "no-referrer",
    });
    response.once("finish", redirectResolve);
    response.end();
  });
  server.once("error", redirectReject);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("The private browser handoff could not reserve a loopback port");
  }

  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("The browser did not accept the private Feishu handoff in time")),
        timeoutMs,
      );
    });
    await open(`http://127.0.0.1:${address.port}${requestPath}`);
    await Promise.race([redirected, timeout]);
  } finally {
    clearTimeout(timer);
    await closeServer(server);
  }
}
