import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatAutomationInterval,
  readAutomationSchedule,
} from "../../../src/codex/codex-automation-metadata.mjs";

test("formats supported automation intervals in Chinese", () => {
  assert.equal(formatAutomationInterval("FREQ=MINUTELY;INTERVAL=10"), "每 10 分钟");
  assert.equal(formatAutomationInterval("FREQ=HOURLY;INTERVAL=1"), "每小时");
  assert.equal(formatAutomationInterval("FREQ=DAILY"), "每天");
  assert.equal(formatAutomationInterval("FREQ=UNKNOWN;INTERVAL=2"), undefined);
});

test("reads the live interval from an automation config", async (context) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-automation-"));
  context.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const automationDir = path.join(codexHome, "automations", "p1118-w6");
  await fs.mkdir(automationDir, { recursive: true });
  await fs.writeFile(
    path.join(automationDir, "automation.toml"),
    'id = "p1118-w6"\nrrule = "FREQ=MINUTELY;INTERVAL=10"\n',
    "utf8",
  );

  assert.deepEqual(await readAutomationSchedule("p1118-w6", { codexHome }), {
    rrule: "FREQ=MINUTELY;INTERVAL=10",
    interval: "每 10 分钟",
  });
  assert.equal(await readAutomationSchedule("../unsafe", { codexHome }), undefined);
});
