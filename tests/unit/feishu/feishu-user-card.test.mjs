import assert from "node:assert/strict";
import test from "node:test";
import {
  publicFeishuUserCardFailure,
  resolveFeishuUserCardOpenId,
} from "../../../src/feishu/feishu-user-card.mjs";

test("reads an app open_id directly from a normalized Feishu user card", async () => {
  let fetched = false;
  const result = await resolveFeishuUserCardOpenId({
    messageId: "om_card",
    rawContentType: "share_user",
    content: '<contact_card id="ou_member"/>',
  }, {
    client: { im: { v1: { message: { get: async () => { fetched = true; } } } } },
  });

  assert.equal(result, "ou_member");
  assert.equal(fetched, false);
});

test("refetches an opaque card identity as an app open_id using the existing message API", async () => {
  const calls = [];
  const result = await resolveFeishuUserCardOpenId({
    messageId: "om_card",
    rawContentType: "share_user",
    content: '<contact_card id="tenant-user"/>',
  }, {
    client: {
      im: { v1: { message: { get: async (request) => {
        calls.push(request);
        return {
          code: 0,
          data: { items: [{
            message_id: "om_card",
            msg_type: "share_user",
            body: { content: JSON.stringify({ user_id: "ou_resolved" }) },
          }] },
        };
      } } } },
    },
  });

  assert.equal(result, "ou_resolved");
  assert.deepEqual(calls, [{
    path: { message_id: "om_card" },
    params: { user_id_type: "open_id" },
  }]);
});

test("fails closed when a user card cannot be resolved without exposing its identity", async () => {
  const privateIdentity = "private-tenant-user";
  await assert.rejects(
    resolveFeishuUserCardOpenId({
      messageId: "om_card",
      rawContentType: "share_user",
      content: `<contact_card id="${privateIdentity}"/>`,
    }, {
      client: {
        im: { v1: { message: { get: async () => ({
          code: 0,
          data: { items: [{
            message_id: "om_card",
            msg_type: "share_user",
            body: { content: JSON.stringify({ user_id: privateIdentity }) },
          }] },
        }) } } },
      },
    }),
    (error) => {
      assert.equal(error?.code, "user_card_identity_unavailable");
      assert.doesNotMatch(error.message, new RegExp(privateIdentity));
      assert.doesNotMatch(publicFeishuUserCardFailure(error), new RegExp(privateIdentity));
      return true;
    },
  );
});
