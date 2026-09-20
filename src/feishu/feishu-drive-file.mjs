import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createSerializedFileWriter, readJsonArrayFile } from "../persistence/serialized-json-file.mjs";
import { parseJsonEnvelope, requiredString } from "./lark-cli-json.mjs";

function safeDriveUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { return undefined; }
  const hostname = url.hostname.toLowerCase();
  const trustedHost = hostname === "feishu.cn"
    || hostname.endsWith(".feishu.cn")
    || hostname === "larksuite.com"
    || hostname.endsWith(".larksuite.com");
  if (!trustedHost || url.protocol !== "https:" || url.username || url.password) return undefined;
  return url.href;
}

function driveUrlFromResponse(response) {
  const data = response?.data;
  return safeDriveUrl(
    data?.file?.url
    || data?.url
    || data?.file_url
    || data?.result?.url
    || response?.url,
  );
}

function runLarkCliDriveJson(nodeExecutable, larkCliEntry, args, {
  cwd,
  execFile = nodeExecFile,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      requiredString(nodeExecutable, "nodeExecutable"),
      [requiredString(larkCliEntry, "larkCliEntry"), ...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 10_000_000,
        timeout: 2 * 60 * 60_000,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      },
      (error, stdout, stderr) => {
        const envelope = parseJsonEnvelope(stdout) || parseJsonEnvelope(stderr);
        if (error || envelope?.ok !== true) {
          const failure = new Error("Feishu Drive file upload failed", { cause: error });
          failure.name = "FeishuDriveFileError";
          failure.code = envelope?.error?.subtype === "missing_scope"
            ? "drive_auth_required"
            : "drive_upload_failed";
          reject(failure);
          return;
        }
        resolve(envelope);
      },
    );
  });
}

export async function fingerprintDriveFile(localPath, { fsImpl = fs } = {}) {
  const target = String(localPath || "");
  if (!path.isAbsolute(target)) throw new TypeError("Drive upload path must be absolute");
  const stat = await fsImpl.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new TypeError("Drive upload source must be a regular non-empty file");
  }
  const fingerprint = createHash("sha256")
    .update(`${path.resolve(target)}\0${stat.size}\0${Number(stat.mtimeMs) || 0}`)
    .digest("hex");
  return Object.freeze({ fingerprint, size: stat.size, modifiedAtMs: Number(stat.mtimeMs) || 0 });
}

export class FeishuDriveFileManager {
  constructor({
    nodeExecutable,
    larkCliEntry,
    runCommand = runLarkCliDriveJson,
    fsImpl = fs,
  }) {
    this.nodeExecutable = requiredString(nodeExecutable, "nodeExecutable");
    this.larkCliEntry = requiredString(larkCliEntry, "larkCliEntry");
    this.runCommand = runCommand;
    this.fsImpl = fsImpl;
  }

  async upload({ localPath, name }) {
    const target = path.resolve(requiredString(localPath, "localPath"));
    await fingerprintDriveFile(target, { fsImpl: this.fsImpl });
    const cwd = path.dirname(target);
    const relativeFile = `.${path.sep}${path.basename(target)}`;
    const args = [
      "drive", "+upload",
      "--as", "user",
      "--file", relativeFile,
      "--format", "json",
    ];
    const fileName = String(name || "").replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim().slice(0, 200);
    if (fileName) args.push("--name", fileName);
    const response = await this.runCommand(this.nodeExecutable, this.larkCliEntry, args, { cwd });
    const url = driveUrlFromResponse(response);
    if (!url) {
      const error = new Error("Feishu Drive upload returned no safe file URL");
      error.name = "FeishuDriveFileError";
      error.code = "drive_invalid_response";
      throw error;
    }
    return Object.freeze({ url });
  }
}

function normalizeRecord(record) {
  const fingerprint = requiredString(record?.fingerprint, "fingerprint");
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) throw new TypeError("Drive file fingerprint is invalid");
  const url = safeDriveUrl(record?.url);
  if (!url) throw new TypeError("A safe Feishu Drive URL is required");
  return {
    fingerprint: fingerprint.toLowerCase(),
    url,
    createdAt: Number(record?.createdAt) || Date.now(),
  };
}

export class DriveFileUploadStore {
  constructor(filePath, records = []) {
    this.records = new Map(records.map((record) => {
      const normalized = normalizeRecord(record);
      return [normalized.fingerprint, normalized];
    }));
    this.writeSnapshot = createSerializedFileWriter(requiredString(filePath, "filePath"));
  }

  static async open(filePath) {
    const records = await readJsonArrayFile(filePath, "Drive file upload store");
    return new DriveFileUploadStore(filePath, records);
  }

  get(fingerprint) {
    const record = this.records.get(String(fingerprint || "").toLowerCase());
    return record ? structuredClone(record) : undefined;
  }

  list() {
    return [...this.records.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => structuredClone(record));
  }

  async put(record) {
    const normalized = normalizeRecord(record);
    this.records.set(normalized.fingerprint, normalized);
    await this.writeSnapshot(JSON.stringify(this.list(), null, 2));
    return structuredClone(normalized);
  }
}
