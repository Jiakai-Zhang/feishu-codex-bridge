import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SESSION_RELAY_SETTINGS,
  LEGACY_SESSION_RELAY_SETTINGS,
  SessionRelaySettingsStore,
} from "../../../src/persistence/session-relay-settings.mjs";

test("uses queue, public progress, and final mention for a new installation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-settings-"));
  try {
    const store = await SessionRelaySettingsStore.open(path.join(directory, "settings.json"));
    assert.deepEqual(store.getDefaults(), DEFAULT_SESSION_RELAY_SETTINGS);
    assert.deepEqual(store.get("thread-a"), DEFAULT_SESSION_RELAY_SETTINGS);
    assert.deepEqual(store.list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists independent settings per Session and resets to defaults", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-settings-"));
  const filePath = path.join(directory, "settings.json");
  try {
    const store = await SessionRelaySettingsStore.open(filePath);
    await store.update("thread-a", { inputMode: "steer" });
    await store.update("thread-a", { publicProgress: false });
    await store.update("thread-b", { publicProgress: false });

    const reopened = await SessionRelaySettingsStore.open(filePath);
    assert.deepEqual(reopened.get("thread-a"), { inputMode: "steer", publicProgress: false, finalMention: true });
    assert.deepEqual(reopened.get("thread-b"), { inputMode: "queue", publicProgress: false, finalMention: true });
    const document = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(document.defaults, DEFAULT_SESSION_RELAY_SETTINGS);
    assert.deepEqual(document.sessionFallback, DEFAULT_SESSION_RELAY_SETTINGS);
    assert.equal(document.sessions.length, 2);

    assert.deepEqual(await reopened.reset("thread-a"), DEFAULT_SESSION_RELAY_SETTINGS);
    assert.deepEqual(reopened.get("thread-b"), { inputMode: "queue", publicProgress: false, finalMention: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("copies global defaults only when a new Session binding is initialized", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-settings-"));
  const filePath = path.join(directory, "settings.json");
  try {
    const store = await SessionRelaySettingsStore.open(filePath);
    const initialized = await store.initialize("thread-new");
    assert.deepEqual(initialized, {
      created: true,
      settings: { inputMode: "queue", publicProgress: true, finalMention: true },
    });

    await store.updateDefaults({ inputMode: "steer", publicProgress: false });
    assert.deepEqual(store.get("thread-new"), { inputMode: "queue", publicProgress: true, finalMention: true });
    assert.deepEqual(store.get("thread-existing-without-record"), DEFAULT_SESSION_RELAY_SETTINGS);
    assert.deepEqual(await store.reset("thread-new"), LEGACY_SESSION_RELAY_SETTINGS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates the legacy top-level Session array without changing its overrides", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-settings-"));
  const filePath = path.join(directory, "settings.json");
  try {
    await writeFile(filePath, JSON.stringify([{
      threadId: "thread-old",
      inputMode: "queue",
      publicProgress: true,
    }]), "utf8");
    const store = await SessionRelaySettingsStore.open(filePath);
    assert.deepEqual(store.getDefaults(), LEGACY_SESSION_RELAY_SETTINGS);
    assert.deepEqual(store.get("thread-old"), { inputMode: "queue", publicProgress: true, finalMention: true });
    assert.deepEqual(store.get("thread-unconfigured"), LEGACY_SESSION_RELAY_SETTINGS);
    await store.updateDefaults({ publicProgress: true });
    const document = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(document.version, 3);
    assert.deepEqual(document.sessionFallback, LEGACY_SESSION_RELAY_SETTINGS);
    assert.equal(document.sessions.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps version-one global defaults while retaining the legacy fallback for unrecorded Sessions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-settings-"));
  const filePath = path.join(directory, "settings.json");
  try {
    await writeFile(filePath, JSON.stringify({
      version: 1,
      defaults: { inputMode: "queue", publicProgress: false },
      sessions: [],
    }), "utf8");
    const store = await SessionRelaySettingsStore.open(filePath);
    assert.deepEqual(store.getDefaults(), { inputMode: "queue", publicProgress: false, finalMention: true });
    assert.deepEqual(store.get("existing-unrecorded-thread"), LEGACY_SESSION_RELAY_SETTINGS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves legacy defaults when upgrading an installation with bindings but no settings file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-settings-"));
  try {
    const store = await SessionRelaySettingsStore.open(path.join(directory, "settings.json"), {
      legacyInstall: true,
    });
    assert.deepEqual(store.getDefaults(), LEGACY_SESSION_RELAY_SETTINGS);
    assert.deepEqual(store.get("existing-thread"), LEGACY_SESSION_RELAY_SETTINGS);
    assert.deepEqual(await store.resetDefaults(), DEFAULT_SESSION_RELAY_SETTINGS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid setting values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-settings-"));
  try {
    const store = await SessionRelaySettingsStore.open(path.join(directory, "settings.json"));
    await assert.rejects(() => store.update("thread-a", { inputMode: "later" }), /steer or queue/);
    await assert.rejects(() => store.update("thread-a", { publicProgress: "yes" }), /must be boolean/);
    await assert.rejects(() => store.update("thread-a", { finalMention: "yes" }), /must be boolean/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
