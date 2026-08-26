import assert from "node:assert/strict";
import test from "node:test";
import { FeishuChatTabManager } from "../../../src/feishu/feishu-chat-tab.mjs";

const CHAT_ID = "oc_group";
const DOCUMENT_URL = "https://example.feishu.cn/docx/doc_summary_test";

function managerWith(responses) {
  const calls = [];
  const manager = new FeishuChatTabManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli-entry",
    runCommand: async (...args) => {
      calls.push(args);
      return responses.shift();
    },
  });
  return { manager, calls };
}

test("reuses an existing document chat tab without creating a duplicate", async () => {
  const { manager, calls } = managerWith([{ data: { chat_tabs: [{
    tab_id: "tab_existing",
    tab_type: "doc",
    tab_content: { doc: `${DOCUMENT_URL}?from=chat_tab` },
  }] } }]);
  const result = await manager.ensure({ chatId: CHAT_ID, documentUrl: DOCUMENT_URL });
  assert.deepEqual(result, { tabId: "tab_existing", created: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2].slice(0, 3), [
    "api", "GET", "/open-apis/im/v1/chats/oc_group/chat_tabs/list_tabs",
  ]);
});

test("creates a user-owned doc tab and returns its durable tab id", async () => {
  const { manager, calls } = managerWith([
    { data: { chat_tabs: [] } },
    { data: { chat_tabs: [{
      tab_id: "tab_created",
      tab_name: "持续摘要",
      tab_type: "doc",
      tab_content: { doc: DOCUMENT_URL },
    }] } },
  ]);
  const result = await manager.ensure({ chatId: CHAT_ID, documentUrl: DOCUMENT_URL });
  assert.deepEqual(result, { tabId: "tab_created", created: true });
  assert.deepEqual(calls[1][2].slice(0, 3), [
    "api", "POST", "/open-apis/im/v1/chats/oc_group/chat_tabs",
  ]);
  assert.equal(calls[1][2].includes("user"), true);
  assert.deepEqual(JSON.parse(calls[1][3].input), {
    chat_tabs: [{
      tab_name: "持续摘要",
      tab_type: "doc",
      tab_content: { doc: DOCUMENT_URL },
    }],
  });
});

test("removes only the stored Bridge document tab", async () => {
  const { manager, calls } = managerWith([{ data: { chat_tabs: [] } }]);
  assert.equal(await manager.remove({
    chatId: CHAT_ID,
    documentUrl: DOCUMENT_URL,
    tabId: "tab_bridge",
  }), true);
  assert.deepEqual(calls[0][2].slice(0, 3), [
    "api", "DELETE", "/open-apis/im/v1/chats/oc_group/chat_tabs/delete_tabs",
  ]);
  assert.deepEqual(JSON.parse(calls[0][3].input), { tab_ids: ["tab_bridge"] });
});
