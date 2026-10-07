// Rebuild only lost local archive links from existing Bridge-managed chat tabs.
// Remote operations are read-only; no identifiers or content are printed.
import { promises as fs } from "node:fs";
import path from "node:path";
import { FeishuChatTabManager } from "../../src/feishu/feishu-chat-tab.mjs";
import {
  FeishuSummaryDocumentManager,
  normalizeFeishuDocumentUrl,
  SUMMARY_SECTION_MARKER,
} from "../../src/feishu/feishu-summary-document.mjs";
import { createSerializedFileWriter } from "../../src/persistence/serialized-json-file.mjs";
import { SessionSummaryDocumentStore } from "../../src/persistence/session-summary-document-store.mjs";

function plainSummary(content) {
  const paragraphs = [...String(content || "").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  const markerIndex = paragraphs.findIndex((match) => match[1].includes(SUMMARY_SECTION_MARKER));
  const inner = paragraphs[markerIndex + 1]?.[1];
  if (markerIndex < 0 || !inner) throw new Error("managed_summary_missing");
  return inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const config = JSON.parse(await fs.readFile("bridge.config.json", "utf8"));
  const filePath = path.join(config.workspace, "work", "feishu-codex-bridge", "session-relay-summary-documents.json");
  const damaged = await fs.readFile(filePath, "utf8");
  try {
    JSON.parse(damaged);
    throw new Error("summary_state_is_valid_recovery_refused");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const tabs = new FeishuChatTabManager({ ...config, cwd: process.cwd() });
  const documents = new FeishuSummaryDocumentManager({ ...config, cwd: process.cwd() });
  const recovered = [];
  let failed = 0;
  for (const binding of config.sessionRelay.bindings) {
    try {
      let chatTabs;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { chatTabs = await tabs.list(binding.groupChatId); break; }
        catch (error) { if (attempt === 2) throw error; }
      }
      const candidates = chatTabs.filter((tab) => tab.tab_type === "doc"
        && /项目档案|持续摘要/.test(String(tab.tab_name || "")));
      if (candidates.length > 1) throw new Error("ambiguous_archive_tabs");
      if (candidates.length === 0) continue;
      const tab = candidates[0];
      const documentUrl = normalizeFeishuDocumentUrl(tab.tab_content?.doc);
      if (!documentUrl) throw new Error("invalid_archive_url");
      const response = await documents.call([
        "docs", "+fetch", "--doc", documentUrl, "--as", "user",
        "--scope", "keyword", "--keyword", SUMMARY_SECTION_MARKER,
        "--context-after", "1", "--detail", "simple", "--format", "json",
      ]);
      recovered.push({
        groupChatId: binding.groupChatId,
        threadId: binding.threadId,
        documentUrl,
        tabId: tab.tab_id,
        summary: plainSummary(response?.data?.document?.content),
        pending: [],
        processedTurnKeys: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastSyncedAt: Date.now(),
      });
    } catch (error) {
      failed++;
      // Only a safe internal category; never CLI payloads or upstream messages.
      console.log(JSON.stringify({ recoveryError: String(error.code || "archive_read_failed") }));
    }
  }
  if (apply) {
    if (recovered.length === 0) throw new Error("no_archive_links_recovered");
    if (await fs.readFile(filePath, "utf8") !== damaged) throw new Error("summary_state_changed_during_recovery");
    new SessionSummaryDocumentStore(filePath, recovered); // Validate before replacing state.
    await fs.copyFile(filePath, `${filePath}.corrupt.${Date.now()}`);
    await createSerializedFileWriter(filePath)(JSON.stringify(recovered, null, 2));
  }
  console.log(JSON.stringify({ applied: apply, recovered: recovered.length, unreadableGroups: failed }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.code || "summary_recovery_failed" }));
  process.exitCode = 1;
});
