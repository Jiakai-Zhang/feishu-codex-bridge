import assert from "node:assert/strict";
import test from "node:test";
import { codexTurnFailureReason } from "../../../src/codex/codex-turn-failure.mjs";

test("classifies native structured transport failures without exposing payloads", () => {
  for (const code of ["responseStreamDisconnected", "responseStreamConnectionFailed", "httpConnectionFailed"]) {
    assert.equal(codexTurnFailureReason({ codexErrorInfo: { [code]: { httpStatusCode: null } }, message: "private details" }), "network");
    assert.equal(codexTurnFailureReason({ codexErrorInfo: { [code]: { httpStatusCode: 401 } } }), "authentication");
    assert.equal(codexTurnFailureReason({ codexErrorInfo: { [code]: { httpStatusCode: 403 } } }), "authentication");
    assert.equal(codexTurnFailureReason({ codexErrorInfo: { [code]: { httpStatusCode: 429 } } }), "capacity");
    assert.equal(codexTurnFailureReason({ codexErrorInfo: { [code]: { httpStatusCode: 400 } } }), "unknown");
  }
  assert.equal(codexTurnFailureReason({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } } }), "network");
  assert.equal(codexTurnFailureReason({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: null } } }), "unknown");
});

test("keeps unknown, authentication, capacity and context errors distinct", () => {
  assert.equal(codexTurnFailureReason({ codexErrorInfo: "unauthorized" }), "authentication");
  assert.equal(codexTurnFailureReason({ codexErrorInfo: "usageLimitExceeded" }), "capacity");
  assert.equal(codexTurnFailureReason({ codexErrorInfo: "contextWindowExceeded" }), "context");
  assert.equal(codexTurnFailureReason({ codexErrorInfo: "other", message: "stream disconnected before completion: error sending request" }), "network");
  assert.equal(codexTurnFailureReason({ codexErrorInfo: "other", message: "something else" }), "unknown");
  assert.equal(codexTurnFailureReason(), "unknown");
});
