import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTOMATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function formatAutomationInterval(rrule) {
  const fields = Object.fromEntries(String(rrule || "")
    .split(";")
    .map((part) => part.split("=", 2).map((value) => value.trim().toUpperCase()))
    .filter(([key, value]) => key && value));
  const interval = Number(fields.INTERVAL || 1);
  if (!Number.isSafeInteger(interval) || interval < 1) return undefined;
  const units = {
    MINUTELY: interval === 1 ? "每分钟" : `每 ${interval} 分钟`,
    HOURLY: interval === 1 ? "每小时" : `每 ${interval} 小时`,
    DAILY: interval === 1 ? "每天" : `每 ${interval} 天`,
    WEEKLY: interval === 1 ? "每周" : `每 ${interval} 周`,
    MONTHLY: interval === 1 ? "每月" : `每 ${interval} 个月`,
    YEARLY: interval === 1 ? "每年" : `每 ${interval} 年`,
  };
  return units[fields.FREQ];
}

export async function readAutomationSchedule(automationId, {
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
} = {}) {
  const id = String(automationId || "").trim();
  if (!AUTOMATION_ID.test(id)) return undefined;
  const automationPath = path.join(path.resolve(codexHome), "automations", id, "automation.toml");
  let source;
  try {
    source = await fs.readFile(automationPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const rrule = source.match(/^rrule\s*=\s*"([^"]+)"\s*$/mi)?.[1]?.trim();
  const interval = formatAutomationInterval(rrule);
  return rrule && interval ? Object.freeze({ rrule, interval }) : undefined;
}
