import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFeishuRosterError,
  FeishuRosterFetchError,
  fetchFeishuChatRoster,
  summarizeFeishuRosterFailure,
} from "../../../src/feishu/feishu-roster-fetch.mjs";

function createChannel(overrides = {}) {
  return {
    getChatInfo: async () => ({ name: "Session" }),
    getChatMembers: async () => [{ id: "user" }],
    getChatBots: async () => [{ id: "bot" }],
    ...overrides,
  };
}

test("fetchFeishuChatRoster returns all three roster components", async () => {
  const result = await fetchFeishuChatRoster(createChannel(), "chat", { attempts: 1 });

  assert.equal(result.chatInfo.name, "Session");
  assert.equal(result.members.length, 1);
  assert.equal(result.bots.length, 1);
});

test("fetchFeishuChatRoster retries only the failed network probe", async () => {
  const calls = { chatInfo: 0, members: 0, bots: 0 };
  const retries = [];
  const channel = createChannel({
    getChatInfo: async () => {
      calls.chatInfo += 1;
      return { name: "Session" };
    },
    getChatMembers: async () => {
      calls.members += 1;
      if (calls.members === 1) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      return [{ id: "user" }];
    },
    getChatBots: async () => {
      calls.bots += 1;
      return [{ id: "bot" }];
    },
  });

  const result = await fetchFeishuChatRoster(channel, "chat", {
    sleep: async () => {},
    onRetry: ({ failures }) => retries.push(failures),
  });

  assert.equal(result.members.length, 1);
  assert.deepEqual(calls, { chatInfo: 1, members: 2, bots: 1 });
  assert.equal(retries.length, 1);
  assert.equal(retries[0][0].operation, "users");
  assert.equal(retries[0][0].category, "network");
});

test("fetchFeishuChatRoster does not retry permission failures", async () => {
  let calls = 0;
  const channel = createChannel({
    getChatBots: async () => {
      calls += 1;
      throw Object.assign(new Error("forbidden"), { code: "permission_denied" });
    },
  });

  await assert.rejects(
    fetchFeishuChatRoster(channel, "chat", { sleep: async () => {} }),
    (error) => {
      assert.ok(error instanceof FeishuRosterFetchError);
      assert.equal(error.attempts, 1);
      assert.equal(error.category, "permission");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("fetchFeishuChatRoster reports exhausted timeout retries without identifiers", async () => {
  const channel = createChannel({
    getChatInfo: async () => {
      throw Object.assign(new Error("timeout of 20000ms exceeded"), { code: "ECONNABORTED" });
    },
  });

  await assert.rejects(
    fetchFeishuChatRoster(channel, "sensitive-chat-id", { sleep: async () => {} }),
    (error) => {
      assert.equal(error.category, "network");
      assert.equal(error.attempts, 2);
      assert.equal(summarizeFeishuRosterFailure(error), "chat_info:network:code=ECONNABORTED");
      assert.equal(summarizeFeishuRosterFailure(error).includes("sensitive-chat-id"), false);
      return true;
    },
  );
});

test("classifyFeishuRosterError recognizes nested API permission errors", () => {
  const result = classifyFeishuRosterError({
    cause: { response: { status: 403, data: { code: 99991679 } } },
  });

  assert.equal(result.category, "permission");
  assert.equal(result.retryable, false);
});
