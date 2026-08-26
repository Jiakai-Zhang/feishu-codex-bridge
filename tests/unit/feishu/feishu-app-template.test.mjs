import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import {
  buildFeishuBridgeAppTemplateUrl,
  FEISHU_BRIDGE_EVENTS,
  FEISHU_BRIDGE_TENANT_SCOPES,
  FEISHU_BRIDGE_USER_SCOPES,
  summarizeFeishuBridgeAppVerification,
} from "../../../src/feishu/feishu-app-template.mjs";

test("Feishu app template carries the exact Bridge scopes and message event", () => {
  const url = new URL(buildFeishuBridgeAppTemplateUrl("cli_template_test"));
  assert.equal(url.origin, "https://open.feishu.cn");
  assert.equal(url.pathname, "/page/launcher");
  assert.equal(url.searchParams.get("clientID"), "cli_template_test");
  const addons = JSON.parse(gunzipSync(
    Buffer.from(url.searchParams.get("addons"), "base64url"),
  ).toString("utf8"));
  assert.deepEqual(addons, {
    scopes: {
      tenant: [...FEISHU_BRIDGE_TENANT_SCOPES],
      user: [...FEISHU_BRIDGE_USER_SCOPES],
    },
    events: {
      items: {
        tenant: [...FEISHU_BRIDGE_EVENTS],
        user: [],
      },
    },
  });
  assert.equal(new Set(addons.scopes.tenant).size, 7);
  assert.equal(new Set(addons.scopes.user).size, 7);
  assert.deepEqual(addons.events.items.tenant, ["im.message.receive_v1"]);
});

test("Feishu app template rejects missing and malformed app identities", () => {
  for (const appId of [undefined, "", "app_invalid", "cli has spaces", "cli_/path"]) {
    assert.throws(() => buildFeishuBridgeAppTemplateUrl(appId), /valid Feishu App ID/);
  }
});

test("Feishu app verification exposes only safe statuses and missing scope names", () => {
  const summary = summarizeFeishuBridgeAppVerification({
    appId: "cli_private_value",
    identities: {
      bot: { available: true, verified: true, openId: "ou_private_bot" },
      user: {
        available: true,
        verified: true,
        openId: "ou_private_user",
        scope: FEISHU_BRIDGE_USER_SCOPES.join(" "),
      },
    },
  }, {
    data: {
      decision: {
        preconditions: [
          { name: "console_event_published", status: "ok", hint: "private-url" },
          { name: "scopes_granted", status: "ok" },
        ],
      },
    },
  });
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.missingUserScopes, []);
  const output = JSON.stringify(summary);
  assert.equal(output.includes("cli_private_value"), false);
  assert.equal(output.includes("ou_private"), false);
  assert.equal(output.includes("private-url"), false);

  const missing = summarizeFeishuBridgeAppVerification({
    appId: "cli_private_value",
    identities: {
      bot: { available: true, verified: true },
      user: { available: true, verified: true, scope: FEISHU_BRIDGE_USER_SCOPES[0] },
    },
  }, { data: { decision: { preconditions: [] } } });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingUserScopes, FEISHU_BRIDGE_USER_SCOPES.slice(1));
  assert.equal(missing.checks.messageEventPublished, "missing");
});
