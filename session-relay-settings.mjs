import { promises as fs } from "node:fs";

export const DEFAULT_SESSION_RELAY_SETTINGS = Object.freeze({
  inputMode: "queue",
  publicProgress: true,
});

export const LEGACY_SESSION_RELAY_SETTINGS = Object.freeze({
  inputMode: "steer",
  publicProgress: false,
});

function normalizeInputMode(value) {
  return value === "queue" ? "queue" : "steer";
}

export function normalizeSessionRelaySettings(value = {}) {
  return Object.freeze({
    inputMode: normalizeInputMode(value?.inputMode),
    publicProgress: value?.publicProgress === true,
  });
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") throw new TypeError("Session settings record must be an object");
  const threadId = String(record.threadId || "");
  if (!threadId) throw new TypeError("Session settings record requires threadId");
  return {
    threadId,
    ...normalizeSessionRelaySettings(record),
  };
}

function validatePatch(patch) {
  if (Object.hasOwn(patch, "inputMode") && !["steer", "queue"].includes(patch.inputMode)) {
    throw new TypeError("Session input mode must be steer or queue");
  }
  if (Object.hasOwn(patch, "publicProgress") && typeof patch.publicProgress !== "boolean") {
    throw new TypeError("Session public progress setting must be boolean");
  }
}

export class SessionRelaySettingsStore {
  constructor(filePath, records = [], {
    defaults = DEFAULT_SESSION_RELAY_SETTINGS,
    sessionFallback = defaults,
  } = {}) {
    this.filePath = filePath;
    this.defaults = { ...normalizeSessionRelaySettings(defaults) };
    this.sessionFallback = { ...normalizeSessionRelaySettings(sessionFallback) };
    this.records = new Map(records.map((record) => {
      const value = normalizeRecord(record);
      return [value.threadId, value];
    }));
    this.writeTail = Promise.resolve();
  }

  static async open(filePath, { legacyInstall = false } = {}) {
    let records = [];
    let defaults = legacyInstall ? LEGACY_SESSION_RELAY_SETTINGS : DEFAULT_SESSION_RELAY_SETTINGS;
    let sessionFallback = defaults;
    try {
      const value = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (Array.isArray(value)) {
        // v0.1.0-beta.1 stored only per-Session overrides as a top-level array.
        defaults = LEGACY_SESSION_RELAY_SETTINGS;
        sessionFallback = LEGACY_SESSION_RELAY_SETTINGS;
        records = value;
      } else if (value && typeof value === "object" && Array.isArray(value.sessions)) {
        defaults = normalizeSessionRelaySettings(value.defaults);
        sessionFallback = value.sessionFallback
          ? normalizeSessionRelaySettings(value.sessionFallback)
          : LEGACY_SESSION_RELAY_SETTINGS;
        records = value.sessions;
      } else {
        throw new TypeError("Session settings store has an unsupported schema");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return new SessionRelaySettingsStore(filePath, records, { defaults, sessionFallback });
  }

  getDefaults() {
    return normalizeSessionRelaySettings(this.defaults);
  }

  get(threadId) {
    const record = this.records.get(String(threadId));
    return normalizeSessionRelaySettings(record || this.sessionFallback);
  }

  list() {
    return [...this.records.values()]
      .sort((left, right) => left.threadId.localeCompare(right.threadId))
      .map((record) => ({ ...record }));
  }

  async initialize(threadId) {
    const key = String(threadId || "");
    if (!key) throw new TypeError("Session settings initialization requires threadId");
    if (this.records.has(key)) {
      return Object.freeze({ created: false, settings: this.get(key) });
    }
    this.records.set(key, { threadId: key, ...this.getDefaults() });
    await this.persist();
    return Object.freeze({ created: true, settings: this.get(key) });
  }

  async update(threadId, patch = {}) {
    const key = String(threadId || "");
    if (!key) throw new TypeError("Session settings update requires threadId");
    validatePatch(patch);
    const next = {
      threadId: key,
      ...this.get(key),
      ...patch,
    };
    this.records.set(key, next);
    await this.persist();
    return normalizeSessionRelaySettings(next);
  }

  async updateDefaults(patch = {}) {
    validatePatch(patch);
    this.defaults = { ...this.getDefaults(), ...patch };
    await this.persist();
    return this.getDefaults();
  }

  async reset(threadId) {
    const key = String(threadId || "");
    if (!key) throw new TypeError("Session settings reset requires threadId");
    this.records.set(key, { threadId: key, ...this.getDefaults() });
    await this.persist();
    return this.get(key);
  }

  async resetDefaults() {
    this.defaults = { ...DEFAULT_SESSION_RELAY_SETTINGS };
    await this.persist();
    return this.getDefaults();
  }

  async remove(threadId) {
    if (!this.records.delete(String(threadId))) return false;
    await this.persist();
    return true;
  }

  async persist() {
    const snapshot = JSON.stringify({
      version: 2,
      defaults: this.getDefaults(),
      sessionFallback: normalizeSessionRelaySettings(this.sessionFallback),
      sessions: this.list(),
    }, null, 2);
    this.writeTail = this.writeTail.then(
      () => fs.writeFile(this.filePath, snapshot, "utf8"),
      () => fs.writeFile(this.filePath, snapshot, "utf8"),
    );
    await this.writeTail;
  }
}
