import http from "node:http";
import { randomUUID } from "node:crypto";

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function openPrivateFeishuUrl(targetUrl, {
  open,
  timeoutMs = 20_000,
  onReady,
} = {}) {
  const target = new URL(String(targetUrl || ""));
  if (
    target.origin !== "https://open.feishu.cn"
    || target.username
    || target.password
  ) {
    throw new TypeError("The private browser target must use the Feishu Open Platform");
  }
  if (typeof open !== "function") {
    throw new TypeError("A platform browser opener is required");
  }
  if (onReady !== undefined && typeof onReady !== "function") {
    throw new TypeError("The private browser ready callback must be a function");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new TypeError("The private browser timeout must be between 1000 and 300000 milliseconds");
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
    const localUrl = `http://127.0.0.1:${address.port}${requestPath}`;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(
          "The browser did not accept the private Feishu handoff in time. "
          + "Rerun the command to get a fresh temporary local URL.",
        )),
        timeoutMs,
      );
    });
    await onReady?.(localUrl);
    try {
      await open(localUrl);
    } catch (error) {
      if (!onReady) throw error;
    }
    await Promise.race([redirected, timeout]);
  } finally {
    clearTimeout(timer);
    await closeServer(server);
  }
}
