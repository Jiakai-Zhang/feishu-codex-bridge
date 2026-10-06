import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const PROVIDERS = Object.freeze(["223.5.5.5", "223.6.6.6"]);
const MAX_BODY_BYTES = 64 * 1024;

function lookupError(code = "ENOTFOUND") {
  return Object.assign(new Error("Feishu DNS resolution unavailable"), { code });
}

export function isFeishuDnsHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9.-]+$/.test(host)
    && ["feishu.cn", "larksuite.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function safeAddress(address, family) {
  if (isIP(address) !== family) return false;
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 198 && (b === 18 || b === 19));
  }
  const lower = address.toLowerCase();
  return lower !== "::" && lower !== "::1" && !/^(?:f[cd]|fe[89ab]|ff|::ffff:)/.test(lower);
}

export function parseDohRecords(payload, family) {
  if (payload?.Status !== 0 || !Array.isArray(payload.Answer)) throw lookupError();
  const type = family === 6 ? 28 : 1;
  const records = payload.Answer.filter((a) => a.type === type && safeAddress(a.data, family));
  if (!records.length) throw lookupError();
  const ttl = Math.min(300, ...records.map((a) => Number.isFinite(a.TTL) && a.TTL > 0 ? a.TTL : 30));
  const addresses = [...new Set(records.map((a) => a.data))].map((address) => ({ address, family }));
  return { addresses, ttlMs: Math.max(1000, ttl * 1000) };
}

function queryProvider(hostname, family, provider, { requestImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let request, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(lookupError()); else resolve(value);
    };
    try {
      // Literal bootstrap IP avoids recursive dependence on broken system DNS.
      // SNI, Host and normal certificate verification still target the DoH service.
      request = requestImpl({
        hostname: provider,
        port: 443,
        servername: "dns.alidns.com",
        path: `/resolve?name=${encodeURIComponent(hostname)}&type=${family === 6 ? "AAAA" : "A"}`,
        headers: { Host: "dns.alidns.com", Accept: "application/json" },
        agent: false,
        rejectUnauthorized: true,
      }, (response) => {
        if (response.statusCode !== 200) {
          finish(lookupError()); response.destroy(); return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) { finish(lookupError()); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on("error", () => finish(lookupError()));
        response.on("aborted", () => finish(lookupError()));
        response.on("end", () => {
          try { finish(undefined, parseDohRecords(JSON.parse(Buffer.concat(chunks).toString("utf8")), family)); }
          catch { finish(lookupError()); }
        });
      });
      request.on("error", () => finish(lookupError()));
      timer = setTimeout(() => {
        finish(lookupError()); request.destroy();
      }, timeoutMs);
    } catch { finish(lookupError()); request?.destroy(); }
  });
}

export async function resolveFeishuDoh(hostname, family = 4, {
  providers = PROVIDERS,
  requestImpl = https.get,
  timeoutMs = 4000,
} = {}) {
  if (!isFeishuDnsHostname(hostname)) throw lookupError();
  for (const provider of providers) {
    try { return await queryProvider(hostname, family, provider, { requestImpl, timeoutMs }); }
    catch { /* Try the second independently bootstrapped endpoint. */ }
  }
  throw lookupError();
}

export function createFeishuDohBackup({
  lookupImpl = dns.lookup,
  dohResolve = resolveFeishuDoh,
  systemTimeoutMs = 750,
  now = Date.now,
  onEvent = () => {},
} = {}) {
  const cache = new Map();
  const flights = new Map();
  const restorers = [];
  const stats = { systemResolved: 0, dohResolved: 0, cacheHits: 0, failed: 0 };
  const emit = (event) => { try { onEvent(event); } catch {} };
  function systemLookup(hostname, options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, addresses) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error || !addresses?.length) reject(lookupError()); else resolve(addresses);
      };
      const timer = setTimeout(() => finish(lookupError()), systemTimeoutMs);
      try { lookupImpl(hostname, { ...options, all: true }, finish); }
      catch { finish(lookupError()); }
    });
  }
  async function resolve(hostname, options) {
    const key = `${hostname}:${options.family || 0}:${options.hints || 0}`;
    const saved = cache.get(key);
    if (saved && saved.expiresAt > now()) { stats.cacheHits += 1; return saved.addresses; }
    cache.delete(key);
    if (flights.has(key)) return flights.get(key);
    const running = (async () => {
      try {
        const addresses = await systemLookup(hostname, options);
        stats.systemResolved += 1;
        return addresses;
      } catch {
        try {
          // IPv4 first for unspecified family, avoiding an unusable IPv6 default
          // route. Explicit IPv6 callers still receive AAAA records.
          const result = await dohResolve(hostname, options.family === 6 ? 6 : 4);
          if (!result?.addresses?.length) throw lookupError();
          cache.set(key, { addresses: result.addresses, expiresAt: now() + Math.min(300_000, Math.max(1000, result.ttlMs || 30_000)) });
          if (cache.size > 256) cache.delete(cache.keys().next().value);
          stats.dohResolved += 1;
          emit("doh_resolved");
          return result.addresses;
        } catch {
          stats.failed += 1; emit("doh_failed"); throw lookupError();
        }
      }
    })();
    flights.set(key, running);
    try { return await running; } finally { flights.delete(key); }
  }
  function lookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    if (typeof options === "number") options = { family: options };
    options ||= {};
    if (!isFeishuDnsHostname(hostname)) return lookupImpl(hostname, options, callback);
    const normalized = String(hostname).toLowerCase().replace(/\.$/, "");
    void resolve(normalized, options).then((addresses) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }, () => callback(lookupError()));
  }
  const httpAgent = new http.Agent({ keepAlive: true, lookup });
  const httpsAgent = new https.Agent({ keepAlive: true, lookup });
  return {
    lookup, httpAgent, httpsAgent,
    snapshot: () => ({ ...stats }),
    attachHttpClient(client) {
      if (!client?.defaults) throw new TypeError("Channel SDK HTTP defaults are required");
      const original = { httpAgent: client.defaults.httpAgent, httpsAgent: client.defaults.httpsAgent };
      client.defaults.httpAgent = httpAgent;
      client.defaults.httpsAgent = httpsAgent;
      restorers.push(() => {
        for (const key of ["httpAgent", "httpsAgent"]) {
          const ours = key === "httpAgent" ? httpAgent : httpsAgent;
          if (client.defaults[key] === ours) {
            if (original[key] === undefined) delete client.defaults[key];
            else client.defaults[key] = original[key];
          }
        }
      });
    },
    close() {
      for (const restore of restorers.splice(0).reverse()) restore();
      httpAgent.destroy(); httpsAgent.destroy(); cache.clear();
    },
  };
}
