import { gzipSync } from "node:zlib";

const APP_ID = /^cli_[A-Za-z0-9_-]+$/;

export const FEISHU_BRIDGE_TENANT_SCOPES = Object.freeze([
  "im:message",
  "im:message.p2p_msg:readonly",
  "im:message.group_msg",
  "im:chat:readonly",
  "im:chat.members:read",
  "im:chat:create",
  "im:resource",
]);

export const FEISHU_BRIDGE_USER_SCOPES = Object.freeze([
  "im:feed_group_v1:read",
  "im:feed_group_v1:write",
  "docx:document:create",
  "docx:document:write_only",
]);

export const FEISHU_BRIDGE_EVENTS = Object.freeze([
  "im.message.receive_v1",
]);

export function feishuBridgeAppAddons() {
  return {
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
  };
}

export function buildFeishuBridgeAppTemplateUrl(appId) {
  const normalizedAppId = String(appId || "").trim();
  if (!APP_ID.test(normalizedAppId)) throw new TypeError("A valid Feishu App ID is required");
  const encodedAddons = gzipSync(
    Buffer.from(JSON.stringify(feishuBridgeAppAddons()), "utf8"),
  ).toString("base64url");
  const url = new URL("https://open.feishu.cn/page/launcher");
  url.searchParams.set("clientID", normalizedAppId);
  url.searchParams.set("addons", encodedAddons);
  return url.href;
}

function checkStatus(value) {
  return value === true ? "ok" : "missing";
}

export function summarizeFeishuBridgeAppVerification(authStatus, eventDryRun) {
  const userScopes = new Set(String(authStatus?.identities?.user?.scope || "").split(/[\s,]+/).filter(Boolean));
  const missingUserScopes = FEISHU_BRIDGE_USER_SCOPES.filter((scope) => !userScopes.has(scope));
  const preconditions = new Map(
    (eventDryRun?.data?.decision?.preconditions || []).map((item) => [item?.name, item?.status]),
  );
  const checks = {
    appConfigured: checkStatus(APP_ID.test(String(authStatus?.appId || ""))),
    botIdentity: checkStatus(
      authStatus?.identities?.bot?.available === true && authStatus?.identities?.bot?.verified === true,
    ),
    userIdentity: checkStatus(
      authStatus?.identities?.user?.available === true && authStatus?.identities?.user?.verified === true,
    ),
    userOAuthScopes: checkStatus(missingUserScopes.length === 0),
    messageEventPublished: preconditions.get("console_event_published") === "ok" ? "ok" : "missing",
    messageEventScopes: preconditions.get("scopes_granted") === "ok" ? "ok" : "missing",
  };
  return Object.freeze({
    ok: Object.values(checks).every((value) => value === "ok"),
    checks: Object.freeze(checks),
    missingUserScopes: Object.freeze(missingUserScopes),
  });
}
