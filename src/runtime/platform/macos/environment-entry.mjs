import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MACOS_LABELS } from "./constants.mjs";
import { setLaunchEnvironment } from "./launchd-service-manager.mjs";

const pointerPath = path.join(os.homedir(), "Library", "Application Support", "FeishuCodexBridge", "bootstrap", "installation.json");
const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
await setLaunchEnvironment("FEISHU_CODEX_BRIDGE_HOME", String(pointer.repositoryRoot));
await setLaunchEnvironment("FEISHU_CODEX_BRIDGE_NODE", String(pointer.nodeExecutable));
process.stdout.write(`${MACOS_LABELS.environment} configured\n`);
