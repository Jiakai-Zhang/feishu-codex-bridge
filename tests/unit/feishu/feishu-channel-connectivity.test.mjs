import assert from "node:assert/strict";
import test from "node:test";
import { FeishuChannelConnectivity } from "../../../src/feishu/feishu-channel-connectivity.mjs";

test("recovers when a force-reconnected transport reports connected without a reconnected event", () => {
  const connectivity = new FeishuChannelConnectivity({ connected: true });

  assert.equal(connectivity.markDisconnected(), true);
  assert.equal(connectivity.observeTransportState("reconnecting"), false);
  assert.equal(connectivity.connected, false);

  assert.equal(connectivity.observeTransportState("connected"), true);
  assert.equal(connectivity.connected, true);
  assert.equal(connectivity.observeTransportState("connected"), false);
});

test("an inbound message is accepted as proof that the Channel is connected", () => {
  const connectivity = new FeishuChannelConnectivity();

  assert.equal(connectivity.observeInbound(), true);
  assert.equal(connectivity.connected, true);
  assert.equal(connectivity.observeInbound(), false);
});
