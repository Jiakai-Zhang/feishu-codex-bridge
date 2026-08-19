import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeishuMemberOnboardingPost,
  sendFeishuMemberOnboarding,
} from "../../../src/feishu/feishu-member-onboarding.mjs";

test("builds onboarding copy that sends a new member back to the Bot private chat", () => {
  const text = JSON.stringify(buildFeishuMemberOnboardingPost());
  assert.match(text, /\/add/);
  assert.match(text, /个人目录/);
  assert.doesNotMatch(text, /ou_|oc_|cli_|[A-Za-z]:\\|\/Users\//);
});

test("sends member onboarding directly by open_id without putting the identifier in content", async () => {
  const calls = [];
  const rawClient = {
    im: { message: { create: async (request) => {
      calls.push(request);
      return { code: 0, data: { message_id: "om_onboarding" } };
    } } },
  };
  const result = await sendFeishuMemberOnboarding(rawClient, {
    memberOpenId: "ou_member",
    uuid: "welcome-uuid",
  });
  assert.deepEqual(result, { messageId: "om_onboarding" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.receive_id_type, "open_id");
  assert.equal(calls[0].data.receive_id, "ou_member");
  assert.equal(calls[0].data.msg_type, "post");
  assert.equal(calls[0].data.uuid, "welcome-uuid");
  assert.match(calls[0].data.content, /\/add/);
  assert.doesNotMatch(calls[0].data.content, /ou_member/);
});

test("sanitizes SDK failures before returning them to the Relay", async () => {
  const rawClient = {
    im: { message: { create: async () => {
      throw new Error("request contained ou_private_member and a token");
    } } },
  };
  await assert.rejects(
    sendFeishuMemberOnboarding(rawClient, { memberOpenId: "ou_member" }),
    (error) => error?.code === "member_onboarding_send_failed"
      && !error.message.includes("ou_private_member")
      && !error.message.includes("token"),
  );
});

test("rejects a successful response that has no message identifier", async () => {
  const rawClient = {
    im: { message: { create: async () => ({ code: 0, data: {} }) } },
  };
  await assert.rejects(
    sendFeishuMemberOnboarding(rawClient, { memberOpenId: "ou_member" }),
    (error) => error?.code === "member_onboarding_invalid_response",
  );
});
