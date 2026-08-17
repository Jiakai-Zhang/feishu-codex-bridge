import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPlatform,
  platformId,
  PLATFORM_IDS,
} from "../../../src/runtime/platform/detect.mjs";

test("normalizes supported runtime platform identifiers", () => {
  assert.equal(platformId("darwin"), PLATFORM_IDS.macOS);
  assert.equal(platformId("macos"), PLATFORM_IDS.macOS);
  assert.equal(platformId("win32"), PLATFORM_IDS.Windows);
  assert.equal(platformId("windows"), PLATFORM_IDS.Windows);
  assert.throws(() => platformId("linux"), /Unsupported runtime platform/);
});

test("fails closed when a platform entrypoint runs on another platform", () => {
  assert.equal(assertPlatform("macos", "darwin"), "macos");
  assert.throws(() => assertPlatform("macos", "win32"), /macos only/);
});
