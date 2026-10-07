import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createLarkChannel } from "@larksuite/channel";
import {
  createFeishuDohBackup, isFeishuDnsHostname, parseDohRecords, resolveFeishuDoh,
} from "../../../src/feishu/feishu-doh-backup.mjs";

const answer = { addresses: [{ address: "203.0.113.10", family: 4 }], ttlMs: 2000 };
const failedLookup = (_host, _options, callback) => callback(Object.assign(new Error("private detail"), { code: "ENOTFOUND" }));
const lookup = (backup, host = "open.feishu.cn", options = { all: true }) => new Promise((resolve, reject) => {
  backup.lookup(host, options, (error, address, family) => error ? reject(error) : resolve(options.all ? address : { address, family }));
});

test("backup scope excludes local, IP, unrelated and suffix-spoofed hosts", () => {
  for (const host of ["localhost", "127.0.0.1", "::1", "google.com", "evilfeishu.cn", "open.feishu.cn.evil.test"]) {
    assert.equal(isFeishuDnsHostname(host), false);
  }
  assert.equal(isFeishuDnsHostname("OPEN.FEISHU.CN."), true);
  assert.equal(isFeishuDnsHostname("open.larksuite.com"), true);
});

test("working system DNS remains primary", async () => {
  let fallbackCalls = 0;
  const backup = createFeishuDohBackup({
    lookupImpl: (_host, options, callback) => { assert.equal(options.all, true); callback(null, answer.addresses); },
    dohResolve: async () => { fallbackCalls += 1; return answer; },
  });
  try { assert.deepEqual(await lookup(backup), answer.addresses); assert.equal(fallbackCalls, 0); }
  finally { backup.close(); }
});

test("unrelated host lookup is unchanged", async () => {
  const backup = createFeishuDohBackup({ lookupImpl: (_host, options, callback) => {
    assert.equal(options.all, false); callback(null, "127.0.0.1", 4);
  }, dohResolve: () => { throw new Error("DoH must not run"); } });
  try { assert.deepEqual(await lookup(backup, "localhost", { all: false }), { address: "127.0.0.1", family: 4 }); }
  finally { backup.close(); }
});

test("DNS errors use DoH and retain the single-address callback contract", async () => {
  const events = [];
  const backup = createFeishuDohBackup({ lookupImpl: failedLookup, dohResolve: async () => answer, onEvent: e => events.push(e) });
  try {
    assert.deepEqual(await lookup(backup, undefined, { all: false }), answer.addresses[0]);
    assert.deepEqual(events, ["doh_resolved"]);
  } finally { backup.close(); }
});

test("hung or late system lookup is bounded and callback only runs once", async () => {
  let callbackCalls = 0;
  const backup = createFeishuDohBackup({ systemTimeoutMs: 5,
    lookupImpl: (_host, _options, callback) => { setTimeout(() => callback(null, [{ address: "203.0.113.20", family: 4 }]), 25); },
    dohResolve: async () => answer,
  });
  try {
    await new Promise((resolve, reject) => backup.lookup("open.feishu.cn", { all: true }, (error, addresses) => {
      callbackCalls += 1; if (error) reject(error); else { assert.deepEqual(addresses, answer.addresses); resolve(); }
    }));
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(callbackCalls, 1);
  } finally { backup.close(); }
});

test("concurrent lookups are coalesced; TTL cache expires", async () => {
  let clock = 0, calls = 0;
  const backup = createFeishuDohBackup({ lookupImpl: failedLookup, now: () => clock,
    dohResolve: async () => { calls += 1; return answer; } });
  try {
    await Promise.all([lookup(backup), lookup(backup), lookup(backup)]);
    assert.equal(calls, 1);
    await lookup(backup); assert.equal(calls, 1);
    clock = 2001; await lookup(backup); assert.equal(calls, 2);
  } finally { backup.close(); }
});

test("failed fallback is retryable and errors contain no underlying details", async () => {
  let calls = 0;
  const backup = createFeishuDohBackup({ lookupImpl: failedLookup, dohResolve: async () => {
    if (++calls === 1) throw new Error("private account detail"); return answer;
  } });
  try {
    await assert.rejects(lookup(backup), e => e.code === "ENOTFOUND" && !e.message.includes("private"));
    assert.deepEqual(await lookup(backup), answer.addresses);
  } finally { backup.close(); }
});

test("explicit IPv6 uses AAAA and preserves callback family", async () => {
  const backup = createFeishuDohBackup({ lookupImpl: failedLookup, dohResolve: async (_host, family) => {
    assert.equal(family, 6); return { addresses: [{ address: "2001:db8::5", family: 6 }], ttlMs: 1000 };
  } });
  try { assert.deepEqual(await lookup(backup, undefined, { family: 6 }), { address: "2001:db8::5", family: 6 }); }
  finally { backup.close(); }
});

test("DoH validates answer status, record family, public address and TTL cap", () => {
  for (const data of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.1.1", "198.18.0.1", "100.64.0.1", "bad-ip"]) {
    assert.throws(() => parseDohRecords({ Status: 0, Answer: [{ type: 1, TTL: 30, data }] }, 4));
  }
  assert.throws(() => parseDohRecords({ Status: 3, Answer: [] }, 4));
  const parsed = parseDohRecords({ Status: 0, Answer: [{ type: 1, TTL: 9999, data: "203.0.113.10" }] }, 4);
  assert.equal(parsed.ttlMs, 300_000);
});

function responseRequest(payload, { status = 200, capture = () => {} } = {}) {
  return (options, callback) => {
    capture(options);
    const request = new EventEmitter(); request.destroy = () => {};
    queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = status; response.destroy = () => {};
      callback(response);
      response.emit("data", Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)));
      response.emit("end");
    });
    return request;
  };
}

test("DoH bootstrap is IP-based, TLS verified, credential-free and provider-failover capable", async () => {
  const captures = [];
  const ok = responseRequest({ Status: 0, Answer: [{ type: 1, TTL: 60, data: "203.0.113.10" }] }, { capture: o => captures.push(o) });
  const result = await resolveFeishuDoh("open.feishu.cn", 4, { requestImpl: (options, callback) => {
    if (options.hostname === "223.5.5.5") return responseRequest("bad JSON", { capture: o => captures.push(o) })(options, callback);
    return ok(options, callback);
  } });
  assert.equal(result.addresses.length, 1);
  assert.deepEqual(captures.map(o => o.hostname), ["223.5.5.5", "223.6.6.6"]);
  for (const o of captures) {
    assert.equal(o.servername, "dns.alidns.com"); assert.equal(o.rejectUnauthorized, true); assert.equal(o.agent, false);
    assert.equal(o.headers.Authorization, undefined); assert.equal(o.headers.Cookie, undefined);
    assert.equal(o.path, "/resolve?name=open.feishu.cn&type=A");
  }
});

test("DoH total deadline and body limit bound failed providers", async () => {
  let destroys = 0;
  await assert.rejects(resolveFeishuDoh("open.feishu.cn", 4, { providers: ["223.5.5.5"], timeoutMs: 5,
    requestImpl: () => { const req = new EventEmitter(); req.destroy = () => { destroys += 1; }; return req; } }));
  assert.equal(destroys, 1);
  await assert.rejects(resolveFeishuDoh("open.feishu.cn", 4, { providers: ["223.5.5.5"], requestImpl: responseRequest("x".repeat(70_000)) }));
});

test("Channel SDK HTTP and WebSocket share agents without changing timeout or proxy", () => {
  const backup = createFeishuDohBackup();
  const channel = createLarkChannel({ appId: "test-app", appSecret: "test-secret", transport: "websocket", agent: backup.httpsAgent });
  const defaults = channel.rawClient.httpInstance.defaults;
  const original = { http: defaults.httpAgent, https: defaults.httpsAgent, timeout: defaults.timeout, proxy: defaults.proxy };
  backup.attachHttpClient(channel.rawClient.httpInstance);
  assert.equal(defaults.httpsAgent, backup.httpsAgent); assert.equal(defaults.httpAgent, backup.httpAgent);
  assert.equal(channel.opts.agent, backup.httpsAgent);
  assert.equal(defaults.timeout, original.timeout); assert.equal(defaults.proxy, original.proxy);
  backup.close();
  assert.equal(defaults.httpsAgent, original.https); assert.equal(defaults.httpAgent, original.http);
});
