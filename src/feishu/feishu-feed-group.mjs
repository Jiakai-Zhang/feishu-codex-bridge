import { execFile as nodeExecFile } from "node:child_process";
import os from "node:os";
import { parseJsonEnvelope, requiredString } from "./lark-cli-json.mjs";

const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;

export class FeishuFeedGroupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "FeishuFeedGroupError";
    this.code = code;
    if (options.missingScopes) this.missingScopes = Object.freeze([...options.missingScopes]);
    if (options.failedItems) this.failedItems = Object.freeze([...options.failedItems]);
  }
}

export function buildAgentFeedGroupName({
  hostname = os.hostname(),
  agentName = "Codex",
} = {}) {
  return `${requiredString(hostname, "hostname")}-${requiredString(agentName, "agentName")}`;
}

function commandFailure(error, stdout, stderr) {
  const envelope = parseJsonEnvelope(stderr) || parseJsonEnvelope(stdout);
  const missingScopes = Array.isArray(envelope?.error?.missing_scopes)
    ? envelope.error.missing_scopes.filter((scope) => typeof scope === "string")
    : [];
  if (envelope?.error?.subtype === "missing_scope" || missingScopes.length > 0) {
    return new FeishuFeedGroupError(
      "feed_group_auth_required",
      "The Feishu user authorization does not include the Feed group scopes",
      { cause: error, missingScopes },
    );
  }
  if (error?.code === "ENOENT") {
    return new FeishuFeedGroupError(
      "feed_group_cli_unavailable",
      "The configured Feishu CLI runtime is unavailable",
      { cause: error },
    );
  }
  return new FeishuFeedGroupError(
    "feed_group_api_error",
    "The Feishu Feed group request failed",
    { cause: error },
  );
}

export function runLarkCliJson(nodeExecutable, larkCliEntry, args, {
  cwd = process.cwd(),
  execFile = nodeExecFile,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      requiredString(nodeExecutable, "nodeExecutable"),
      [requiredString(larkCliEntry, "larkCliEntry"), ...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 2_000_000,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(commandFailure(error, stdout, stderr));
          return;
        }
        const envelope = parseJsonEnvelope(stdout);
        if (!envelope || envelope.ok !== true) {
          reject(commandFailure(new Error("Invalid Feishu CLI response"), stdout, stderr));
          return;
        }
        resolve(envelope);
      },
    );
  });
}

function normalizeChatIds(chatIds) {
  if (!Array.isArray(chatIds)) throw new TypeError("chatIds must be an array");
  const unique = [];
  const seen = new Set();
  for (const value of chatIds) {
    const chatId = requiredString(value, "chatId");
    if (!CHAT_ID.test(chatId)) throw new TypeError("Invalid chatId");
    if (!seen.has(chatId)) {
      seen.add(chatId);
      unique.push(chatId);
    }
  }
  return unique;
}

export class FeishuFeedGroupManager {
  constructor({
    nodeExecutable,
    larkCliEntry,
    agentName = "Codex",
    hostname,
    cwd = process.cwd(),
    runCommand = runLarkCliJson,
  }) {
    this.nodeExecutable = requiredString(nodeExecutable, "nodeExecutable");
    this.larkCliEntry = requiredString(larkCliEntry, "larkCliEntry");
    this.cwd = cwd;
    this.groupName = buildAgentFeedGroupName({ hostname, agentName });
    this.runCommand = runCommand;
    this.groupId = undefined;
    this.ensuredChatIds = new Set();
    this.suppressedChatIds = new Set();
    this.tail = Promise.resolve();
  }

  async call(args) {
    return this.runCommand(this.nodeExecutable, this.larkCliEntry, args, { cwd: this.cwd });
  }

  async findExistingGroup() {
    if (this.groupId) return this.groupId;
    const listed = await this.call([
      "im", "+feed-group-list", "--as", "user", "--page-all", "--format", "json",
    ]);
    const groups = Array.isArray(listed?.data?.groups) ? listed.data.groups : [];
    const matching = groups.filter((group) => group?.name === this.groupName);
    const normal = matching.filter((group) => group?.type === "normal" && typeof group?.group_id === "string");
    if (matching.length > 0 && normal.length === 0) {
      throw new FeishuFeedGroupError(
        "feed_group_name_conflict",
        "An existing rule-based Feed group already uses the requested agent label name",
      );
    }
    if (normal.length > 1) {
      throw new FeishuFeedGroupError(
        "feed_group_name_ambiguous",
        "More than one Feed group uses the requested agent label name",
      );
    }
    if (normal.length === 1) {
      this.groupId = normal[0].group_id;
      return this.groupId;
    }
    return undefined;
  }

  async findOrCreateGroup() {
    const existing = await this.findExistingGroup();
    if (existing) return existing;

    const created = await this.call([
      "im", "feed.groups", "create", "--as", "user",
      "--data", JSON.stringify({
        feed_group_creator: { type: "normal", name: this.groupName },
      }),
    ]);
    const groupId = created?.data?.group_id;
    if (typeof groupId !== "string" || !groupId.startsWith("ofg_")) {
      throw new FeishuFeedGroupError(
        "feed_group_invalid_response",
        "Feishu did not return the created Feed group ID",
      );
    }
    this.groupId = groupId;
    return groupId;
  }

  ensureChats(chatIds) {
    const requested = normalizeChatIds(chatIds);
    const work = async () => {
      const pending = requested.filter((chatId) => (
        !this.ensuredChatIds.has(chatId) && !this.suppressedChatIds.has(chatId)
      ));
      if (pending.length === 0) {
        return Object.freeze({ groupId: this.groupId, groupName: this.groupName, added: 0 });
      }
      const groupId = await this.findOrCreateGroup();
      const response = await this.call([
        "im", "feed.groups", "batch_add_item", "--as", "user",
        "--params", JSON.stringify({ feed_group_id: groupId }),
        "--data", JSON.stringify({
          items: pending.map((feedId) => ({ feed_id: feedId, feed_type: "chat" })),
        }),
      ]);
      const failed = Array.isArray(response?.data?.failed_items) ? response.data.failed_items : [];
      if (failed.length > 0) {
        throw new FeishuFeedGroupError(
          "feed_group_partial_failure",
          "Feishu could not add every bound chat to the agent Feed group",
          {
            failedItems: failed.map((item) => Object.freeze({
              feedId: item?.item?.feed_id,
              errorCode: item?.error_code,
            })),
          },
        );
      }
      for (const chatId of pending) this.ensuredChatIds.add(chatId);
      return Object.freeze({ groupId, groupName: this.groupName, added: pending.length });
    };
    const running = this.tail.catch(() => {}).then(work);
    this.tail = running.catch(() => {});
    return running;
  }

  ensureChat(chatId) {
    return this.ensureChats([chatId]);
  }

  removeChat(chatId) {
    const [requested] = normalizeChatIds([chatId]);
    const wasEnsured = this.ensuredChatIds.has(requested);
    this.suppressedChatIds.add(requested);
    const work = async () => {
      const groupId = await this.findExistingGroup();
      if (!groupId) {
        this.ensuredChatIds.delete(requested);
        return Object.freeze({ groupId: undefined, groupName: this.groupName, removed: 0 });
      }
      const response = await this.call([
        "im", "feed.groups", "batch_remove_item", "--as", "user",
        "--params", JSON.stringify({ feed_group_id: groupId }),
        "--data", JSON.stringify({
          items: [{ feed_id: requested, feed_type: "chat" }],
        }),
      ]);
      const failed = Array.isArray(response?.data?.failed_items) ? response.data.failed_items : [];
      if (failed.length > 0) {
        throw new FeishuFeedGroupError(
          "feed_group_partial_failure",
          "Feishu could not remove the bound chat from the agent Feed group",
          {
            failedItems: failed.map((item) => Object.freeze({
              feedId: item?.item?.feed_id,
              errorCode: item?.error_code,
            })),
          },
        );
      }
      this.ensuredChatIds.delete(requested);
      return Object.freeze({ groupId, groupName: this.groupName, removed: 1 });
    };
    const running = this.tail.catch(() => {}).then(work);
    this.tail = running.catch(() => {});
    return running.catch((error) => {
      this.suppressedChatIds.delete(requested);
      if (wasEnsured) this.ensuredChatIds.add(requested);
      throw error;
    });
  }

  restoreChat(chatId) {
    const [requested] = normalizeChatIds([chatId]);
    this.suppressedChatIds.delete(requested);
    return this.ensureChat(requested);
  }
}
