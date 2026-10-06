import { runLarkCliJson } from "./feishu-feed-group.mjs";
import { createFeishuGroupAvatar } from "./feishu-group-avatar.mjs";

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
  constructor({
    nodeExecutable,
    larkCliEntry,
    ownerOpenId,
    cwd = process.cwd(),
    runCommand = runLarkCliJson,
    uploadAvatar,
    onWarning = () => {},
  }) {
    if (!nodeExecutable) throw new TypeError("nodeExecutable is required");
    if (!larkCliEntry) throw new TypeError("larkCliEntry is required");
    if (ownerOpenId != null && !OPEN_ID.test(String(ownerOpenId || ""))) throw new TypeError("A valid ownerOpenId is required");
    this.nodeExecutable = nodeExecutable;
    this.larkCliEntry = larkCliEntry;
    this.ownerOpenId = ownerOpenId;
    this.cwd = cwd;
    this.runCommand = runCommand;
    this.uploadAvatar = uploadAvatar;
    this.onWarning = onWarning;
  }

  async createSessionGroup({ name, ownerOpenId = this.ownerOpenId }) {
    const groupName = String(name || "").trim();
    if (!groupName || groupName.length > 60) throw new TypeError("Feishu group name must contain 1-60 characters");
    if (!OPEN_ID.test(String(ownerOpenId || ""))) throw new TypeError("A valid Session ownerOpenId is required");
    let avatar;
    if (typeof this.uploadAvatar === "function") {
      try {
        avatar = await this.uploadAvatar({
          name: groupName,
          image: createFeishuGroupAvatar(groupName),
        });
        if (typeof avatar !== "string" || !avatar.trim()) throw new Error("Avatar upload returned no Image Key");
      } catch (error) {
        avatar = undefined;
        this.onWarning(new FeishuSessionChatError(
          "chat_avatar_failed",
          "The Bridge Bot could not set a generated Feishu group avatar",
          { cause: error },
        ));
      }
    }
    let response;
    try {
      response = await this.runCommand(this.nodeExecutable, this.larkCliEntry, [
        "im", "chats", "create",
        "--params", JSON.stringify({
          user_id_type: "open_id",
          set_bot_manager: true,
        }),
        "--data", JSON.stringify({
          name: groupName,
          description: "一个飞书群固定绑定一个本机 Codex 任务",
          user_id_list: [ownerOpenId],
          owner_id: ownerOpenId,
          chat_type: "private",
          chat_mode: "group",
          ...(avatar ? { avatar } : {}),
        }),
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

  createSoloGroup({ name }) {
    return this.createSessionGroup({ name, ownerOpenId: this.ownerOpenId });
  }
}
