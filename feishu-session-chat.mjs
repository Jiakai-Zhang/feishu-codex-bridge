import { runLarkCliJson } from "./feishu-feed-group.mjs";

const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;

export class FeishuSessionChatError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "FeishuSessionChatError";
    this.code = code;
    if (options.missingScopes) this.missingScopes = Object.freeze([...options.missingScopes]);
  }
}

export class FeishuSessionChatManager {
  constructor({ nodeExecutable, larkCliEntry, ownerOpenId, cwd = process.cwd(), runCommand = runLarkCliJson }) {
    if (!nodeExecutable) throw new TypeError("nodeExecutable is required");
    if (!larkCliEntry) throw new TypeError("larkCliEntry is required");
    if (!OPEN_ID.test(String(ownerOpenId || ""))) throw new TypeError("A valid ownerOpenId is required");
    this.nodeExecutable = nodeExecutable;
    this.larkCliEntry = larkCliEntry;
    this.ownerOpenId = ownerOpenId;
    this.cwd = cwd;
    this.runCommand = runCommand;
  }

  async createSoloGroup({ name }) {
    const groupName = String(name || "").trim();
    if (!groupName || groupName.length > 60) throw new TypeError("Feishu group name must contain 1-60 characters");
    let response;
    try {
      response = await this.runCommand(this.nodeExecutable, this.larkCliEntry, [
        "im", "+chat-create",
        "--name", groupName,
        "--description", "一个飞书群固定绑定一个本机 Codex 任务",
        "--users", this.ownerOpenId,
        "--owner", this.ownerOpenId,
        "--type", "private",
        "--chat-mode", "group",
        "--as", "bot",
        "--format", "json",
      ], { cwd: this.cwd });
    } catch (error) {
      if (error?.missingScopes?.length) {
        throw new FeishuSessionChatError(
          "chat_create_auth_required",
          "The Bridge Bot app does not have permission to create a group",
          { cause: error, missingScopes: error.missingScopes },
        );
      }
      throw new FeishuSessionChatError(
        "chat_create_failed",
        "The Bridge Bot could not create the Feishu group",
        { cause: error },
      );
    }
    const chatId = response?.data?.chat_id;
    if (!CHAT_ID.test(String(chatId || ""))) {
      throw new FeishuSessionChatError(
        "chat_create_invalid_response",
        "Feishu did not return the created group ID",
      );
    }
    return Object.freeze({
      chatId,
      name: String(response?.data?.name || groupName),
    });
  }
}
