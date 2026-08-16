import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeFileAtomic(filePath, content, { mode = 0o600 } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, mode);
}

export async function ensurePrivateDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
}

export async function writeJsonAtomic(filePath, value, options) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
