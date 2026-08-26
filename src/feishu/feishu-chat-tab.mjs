import { execFile as nodeExecFile } from "node:child_process";
import { parseJsonEnvelope, requiredString } from "./lark-cli-json.mjs";
import { normalizeFeishuDocumentUrl } from "./feishu-summary-document.mjs";

const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const DEFAULT_TAB_NAME = "持续摘要";

function tabError(code, message, options = {}) {
  const error = new Error(message, options);
  error.name = "FeishuChatTabError";
  error.code = code;
  if (options.missingScopes) error.missingScopes = Object.freeze([...options.missingScopes]);
  return error;
}

function commandFailure(error, stdout, stderr) {
  const envelope = parseJsonEnvelope(stderr) || parseJsonEnvelope(stdout);
  const missingScopes = Array.isArray(envelope?.error?.missing_scopes)
    ? envelope.error.missing_scopes.filter((scope) => typeof scope === "string")
    : [];
  if (envelope?.error?.subtype === "missing_scope" || missingScopes.length > 0) {
    return tabError(
      "summary_tab_auth_required",
      "The Feishu user authorization does not include the required chat tab scopes",
      { cause: error, missingScopes },
    );
  }
  const upstreamCode = Number(envelope?.error?.code);
  if (upstreamCode === 232051 || upstreamCode === 232055) {
    return tabError(
      "summary_tab_permission_denied",
      "The Feishu user cannot manage this chat tab or access the document",
      { cause: error },
    );
  }
  if (upstreamCode === 232046) {
    return tabError("summary_tab_limit_reached", "The chat already has 20 custom tabs", { cause: error });
  }
  return tabError("summary_tab_api_error", "The Feishu chat tab request failed", { cause: error });
}

function tabsFromEnvelope(envelope) {
  const candidates = [
    envelope?.data?.chat_tabs,
    envelope?.data?.data?.chat_tabs,
    envelope?.chat_tabs,
  ];
  return candidates.find(Array.isArray) || [];
}

function documentIdentity(value) {
  const normalized = normalizeFeishuDocumentUrl(value);
  if (!normalized) return undefined;
  const url = new URL(normalized);
  return `${url.origin}${url.pathname}`;
}

function matchingDocumentTab(tabs, documentUrl) {
  const identity = documentIdentity(documentUrl);
  return tabs.find((tab) => (
    tab?.tab_type === "doc"
    && documentIdentity(tab?.tab_content?.doc) === identity
    && String(tab?.tab_id || "").trim()
  ));
}

export function runLarkCliChatTabJson(nodeExecutable, larkCliEntry, args, {
  cwd = process.cwd(),
  input = "",
  execFile = nodeExecFile,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      requiredString(nodeExecutable, "nodeExecutable"),
      [requiredString(larkCliEntry, "larkCliEntry"), ...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 10_000_000,
        timeout: 120_000,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      },
      (error, stdout, stderr) => {
        const envelope = parseJsonEnvelope(stdout) || parseJsonEnvelope(stderr);
        if (error || envelope?.ok !== true) {
          reject(commandFailure(error || new Error("Invalid Feishu CLI response"), stdout, stderr));
          return;
        }
        resolve(envelope);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(String(input), "utf8");
  });
}

export class FeishuChatTabManager {
  constructor({
    nodeExecutable,
    larkCliEntry,
    cwd = process.cwd(),
    runCommand = runLarkCliChatTabJson,
  } = {}) {
    this.nodeExecutable = requiredString(nodeExecutable, "nodeExecutable");
    this.larkCliEntry = requiredString(larkCliEntry, "larkCliEntry");
    this.cwd = cwd;
    this.runCommand = runCommand;
  }

  call(method, path, body) {
    const args = ["api", method, path, "--as", "user", "--format", "json"];
    if (body !== undefined) args.push("--data", "-");
    return this.runCommand(this.nodeExecutable, this.larkCliEntry, args, {
      cwd: this.cwd,
      input: body === undefined ? "" : JSON.stringify(body),
    });
  }

  path(chatId, suffix = "") {
    const normalized = requiredString(chatId, "chatId");
    if (!CHAT_ID.test(normalized)) throw tabError("summary_tab_chat_invalid", "A valid Feishu chat ID is required");
    return `/open-apis/im/v1/chats/${encodeURIComponent(normalized)}/chat_tabs${suffix}`;
  }

  async list(chatId) {
    const response = await this.call("GET", this.path(chatId, "/list_tabs"));
    return tabsFromEnvelope(response);
  }

  async ensure({ chatId, documentUrl, tabName = DEFAULT_TAB_NAME }) {
    const url = normalizeFeishuDocumentUrl(documentUrl);
    if (!url) throw tabError("summary_document_url_invalid", "A valid Feishu document URL is required");
    const existing = matchingDocumentTab(await this.list(chatId), url);
    if (existing) return Object.freeze({ tabId: String(existing.tab_id), created: false });
    const response = await this.call("POST", this.path(chatId), {
      chat_tabs: [{
        tab_name: requiredString(tabName, "tabName").slice(0, 60),
        tab_type: "doc",
        tab_content: { doc: url },
      }],
    });
    const created = matchingDocumentTab(tabsFromEnvelope(response), url);
    if (!created) {
      throw tabError("summary_tab_invalid_response", "Feishu did not return the created document tab ID");
    }
    return Object.freeze({ tabId: String(created.tab_id), created: true });
  }

  async remove({ chatId, documentUrl, tabId }) {
    const url = normalizeFeishuDocumentUrl(documentUrl);
    if (!url) throw tabError("summary_document_url_invalid", "A valid Feishu document URL is required");
    let targetId = String(tabId || "").trim();
    if (!targetId) {
      const existing = matchingDocumentTab(await this.list(chatId), url);
      targetId = String(existing?.tab_id || "").trim();
    }
    if (!targetId) return false;
    await this.call("DELETE", this.path(chatId, "/delete_tabs"), { tab_ids: [targetId] });
    return true;
  }
}
