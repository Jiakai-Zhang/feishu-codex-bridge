import { execFile as nodeExecFile } from "node:child_process";
import { parseJsonEnvelope, requiredString } from "./lark-cli-json.mjs";

export const SUMMARY_SECTION_MARKER = "Feishu Codex Bridge 自动维护（摘要区标识 v1）";
const EMPTY_SUMMARY = "暂时还没有可总结的内容。";

function documentError(code, message, options = {}) {
  const error = new Error(message, options);
  error.name = "FeishuSummaryDocumentError";
  error.code = code;
  if (options.missingScopes) error.missingScopes = Object.freeze([...options.missingScopes]);
  return error;
}

export function normalizeFeishuDocumentUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { return undefined; }
  const host = url.hostname.toLowerCase();
  const trusted = host === "feishu.cn" || host.endsWith(".feishu.cn")
    || host === "larksuite.com" || host.endsWith(".larksuite.com");
  if (
    url.protocol !== "https:" || !trusted || url.username || url.password
    || !/^\/(?:docx|wiki)\/[^/]+/.test(url.pathname)
  ) return undefined;
  url.hash = "";
  return url.href;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildSummaryDocumentXml(title) {
  return [
    `<title>${escapeXml(requiredString(title, "title"))}</title>`,
    "<h1>持续摘要</h1>",
    `<p>${SUMMARY_SECTION_MARKER}</p>`,
    `<p>${EMPTY_SUMMARY}</p>`,
  ].join("\n");
}

export function buildSummaryBlockXml(summary) {
  const body = escapeXml(requiredString(summary, "summary")).replace(/\r?\n/g, "<br/>");
  return `<p>${body}</p>`;
}

function paragraphBlocks(content) {
  const blocks = [];
  const pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pattern.exec(String(content || "")))) {
    const id = /\bid="([^"]+)"/i.exec(match[1])?.[1];
    blocks.push({ id, inner: match[2], index: match.index });
  }
  return blocks;
}

export function locateSummarySection(content) {
  const blocks = paragraphBlocks(content);
  const markerIndex = blocks.findIndex((block) => block.inner.includes(SUMMARY_SECTION_MARKER));
  if (markerIndex < 0) return undefined;
  const marker = blocks[markerIndex];
  const summary = blocks[markerIndex + 1];
  if (!marker?.id || !summary?.id) {
    throw documentError("summary_section_invalid", "The managed summary section has no usable block IDs");
  }
  return Object.freeze({ markerBlockId: marker.id, summaryBlockId: summary.id });
}

function commandFailure(error, stdout, stderr) {
  const envelope = parseJsonEnvelope(stderr) || parseJsonEnvelope(stdout);
  const missingScopes = Array.isArray(envelope?.error?.missing_scopes)
    ? envelope.error.missing_scopes.filter((scope) => typeof scope === "string")
    : [];
  if (envelope?.error?.subtype === "missing_scope" || missingScopes.length > 0) {
    return documentError(
      "summary_document_auth_required",
      "The Feishu user authorization does not include the required document scopes",
      { cause: error, missingScopes },
    );
  }
  return documentError("summary_document_api_error", "The Feishu summary document request failed", { cause: error });
}

export function runLarkCliDocumentJson(nodeExecutable, larkCliEntry, args, {
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

export class FeishuSummaryDocumentManager {
  constructor({
    nodeExecutable,
    larkCliEntry,
    cwd = process.cwd(),
    runCommand = runLarkCliDocumentJson,
  } = {}) {
    this.nodeExecutable = requiredString(nodeExecutable, "nodeExecutable");
    this.larkCliEntry = requiredString(larkCliEntry, "larkCliEntry");
    this.cwd = cwd;
    this.runCommand = runCommand;
  }

  call(args, input = "") {
    return this.runCommand(this.nodeExecutable, this.larkCliEntry, args, {
      cwd: this.cwd,
      input,
    });
  }

  async locate(url) {
    const response = await this.call([
      "docs", "+fetch",
      "--doc", url,
      "--as", "user",
      "--scope", "keyword",
      "--keyword", SUMMARY_SECTION_MARKER,
      "--context-after", "1",
      "--detail", "with-ids",
      "--format", "json",
    ]);
    return locateSummarySection(response?.data?.document?.content);
  }

  async ensureManagedSection(value) {
    const url = normalizeFeishuDocumentUrl(value);
    if (!url) throw documentError("summary_document_url_invalid", "A valid Feishu Docx or Wiki URL is required");
    let section = await this.locate(url);
    if (!section) {
      await this.call([
        "docs", "+update",
        "--doc", url,
        "--as", "user",
        "--command", "append",
        "--content", "-",
        "--format", "json",
      ], [
        "<h1>持续摘要</h1>",
        `<p>${SUMMARY_SECTION_MARKER}</p>`,
        `<p>${EMPTY_SUMMARY}</p>`,
      ].join("\n"));
      section = await this.locate(url);
    }
    if (!section) {
      throw documentError("summary_section_missing", "The managed summary section could not be located");
    }
    return Object.freeze({ url, ...section });
  }

  async create({ title }) {
    const response = await this.call([
      "docs", "+create",
      "--as", "user",
      "--content", "-",
      "--format", "json",
    ], buildSummaryDocumentXml(title));
    const url = normalizeFeishuDocumentUrl(response?.data?.document?.url);
    if (!url) throw documentError("summary_document_invalid_response", "Feishu did not return a safe document URL");
    return this.ensureManagedSection(url);
  }

  bind({ url }) {
    return this.ensureManagedSection(url);
  }

  async update({ url, summary }) {
    const normalizedUrl = normalizeFeishuDocumentUrl(url);
    if (!normalizedUrl) throw documentError("summary_document_url_invalid", "A valid Feishu document URL is required");
    const section = await this.locate(normalizedUrl);
    if (!section) throw documentError("summary_section_missing", "The managed summary section is missing");
    await this.call([
      "docs", "+update",
      "--doc", normalizedUrl,
      "--as", "user",
      "--command", "block_replace",
      "--block-id", section.summaryBlockId,
      "--content", "-",
      "--format", "json",
    ], buildSummaryBlockXml(summary));
    return Object.freeze({ url: normalizedUrl, markerBlockId: section.markerBlockId });
  }
}
