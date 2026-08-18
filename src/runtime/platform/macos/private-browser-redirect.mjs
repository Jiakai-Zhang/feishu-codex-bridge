import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { openPrivateFeishuUrl as openPrivateUrl } from "../../shared/private-browser-redirect.mjs";

const execFile = promisify(nodeExecFile);

async function openLocalUrl(url) {
  await execFile("/usr/bin/open", [url], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 64_000,
  });
}

export async function openPrivateFeishuUrl(targetUrl, {
  open = openLocalUrl,
  timeoutMs = 20_000,
  onReady,
} = {}) {
  return openPrivateUrl(targetUrl, { open, timeoutMs, onReady });
}
