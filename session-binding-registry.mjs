import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeSessionRelayConfig } from "./session-relay-config.mjs";

export class SessionBindingRegistryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "SessionBindingRegistryError";
    this.code = code;
    if (options.binding) this.binding = Object.freeze({ ...options.binding });
  }
}

export class SessionBindingRegistry {
  constructor({ configPath, readFile = fs.readFile, writeFile = fs.writeFile, rename = fs.rename, rm = fs.rm } = {}) {
    if (!configPath) throw new TypeError("configPath is required");
    this.configPath = path.resolve(configPath);
    this.readFile = readFile;
    this.writeFile = writeFile;
    this.rename = rename;
    this.rm = rm;
    this.tail = Promise.resolve();
  }

  async read() {
    const raw = JSON.parse(await this.readFile(this.configPath, "utf8"));
    const normalized = normalizeSessionRelayConfig(raw, { configDir: path.dirname(this.configPath) });
    return { raw, normalized };
  }

  async list() {
    const { normalized } = await this.read();
    return [...normalized.sessionRelay.bindings];
  }

  add(binding) {
    const work = async () => {
      const { raw, normalized } = await this.read();
      const existingThread = normalized.sessionRelay.bindings.find((item) => item.threadId === binding.threadId);
      if (existingThread) {
        throw new SessionBindingRegistryError(
          "session_already_bound",
          "The Codex task already has a Feishu group binding",
          { binding: existingThread },
        );
      }
      const existingGroup = normalized.sessionRelay.bindings.find((item) => item.groupChatId === binding.groupChatId);
      if (existingGroup) {
        throw new SessionBindingRegistryError(
          "group_already_bound",
          "The Feishu group already has a Codex task binding",
          { binding: existingGroup },
        );
      }
      const nextBinding = {
        groupChatId: binding.groupChatId,
        threadId: binding.threadId,
        ownerOpenId: binding.ownerOpenId || normalized.agent.ownerOpenId,
      };
      raw.sessionRelay = raw.sessionRelay && typeof raw.sessionRelay === "object"
        ? raw.sessionRelay
        : {};
      raw.sessionRelay.bindings = [
        ...normalized.sessionRelay.bindings.map((item) => ({
          groupChatId: item.groupChatId,
          threadId: item.threadId,
          ownerOpenId: item.ownerOpenId,
        })),
        nextBinding,
      ];
      normalizeSessionRelayConfig(raw, { configDir: path.dirname(this.configPath) });

      const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
      try {
        await this.writeFile(temporaryPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await this.rename(temporaryPath, this.configPath);
      } finally {
        await this.rm(temporaryPath, { force: true }).catch(() => {});
      }
      return Object.freeze(nextBinding);
    };
    const running = this.tail.catch(() => {}).then(work);
    this.tail = running.catch(() => {});
    return running;
  }

  remove(binding) {
    const work = async () => {
      const { raw, normalized } = await this.read();
      const existing = normalized.sessionRelay.bindings.find(
        (item) => item.groupChatId === binding.groupChatId,
      );
      if (!existing) {
        throw new SessionBindingRegistryError(
          "binding_not_found",
          "The Feishu group no longer has a Session binding",
        );
      }
      if (existing.threadId !== binding.threadId) {
        throw new SessionBindingRegistryError(
          "binding_changed",
          "The Feishu group binding changed before it could be removed",
          { binding: existing },
        );
      }
      raw.sessionRelay = raw.sessionRelay && typeof raw.sessionRelay === "object"
        ? raw.sessionRelay
        : {};
      raw.sessionRelay.bindings = normalized.sessionRelay.bindings
        .filter((item) => item.groupChatId !== binding.groupChatId)
        .map((item) => ({
          groupChatId: item.groupChatId,
          threadId: item.threadId,
          ownerOpenId: item.ownerOpenId,
        }));
      normalizeSessionRelayConfig(raw, { configDir: path.dirname(this.configPath) });

      const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
      try {
        await this.writeFile(temporaryPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await this.rename(temporaryPath, this.configPath);
      } finally {
        await this.rm(temporaryPath, { force: true }).catch(() => {});
      }
      return Object.freeze({ ...existing });
    };
    const running = this.tail.catch(() => {}).then(work);
    this.tail = running.catch(() => {});
    return running;
  }
}
