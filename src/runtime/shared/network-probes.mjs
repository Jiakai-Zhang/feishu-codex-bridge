import http from "node:http";
import net from "node:net";

export function parseLoopbackAppServerUrl(value) {
  const url = new URL(String(value || ""));
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "::1"].includes(host)
    || !url.port || url.pathname !== "/rpc" || url.username || url.password || url.search || url.hash) {
    throw new Error("sessionRelay.appServerUrl must be a ws:// loopback URL ending in /rpc.");
  }
  return Object.freeze({
    href: url.href,
    host,
    port: Number(url.port),
    listenUrl: `ws://${host === "::1" ? "[::1]" : host}:${url.port}`,
  });
}

export function loopbackPortOpen({ host, port }, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function appServerReadyProbe({ host, port }, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request({
      host,
      port,
      path: "/readyz",
      method: "GET",
      agent: false,
    }, (response) => {
      response.resume();
      finish(response.statusCode === 200);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}
