import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

export async function readJsonArrayFile(filePath, description, {
  readFile = fs.readFile,
  rename = fs.rename,
  warn = console.warn,
} = {}) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const backupPath = `${filePath}.corrupt-${timestamp}-${randomUUID()}`;
    // Do not silently discard data if quarantine itself fails (e.g. permissions).
    await rename(filePath, backupPath);
    warn(`${description}: invalid JSON preserved at ${backupPath}; recovering with an empty array.`);
    return [];
  }
  if (!Array.isArray(value)) throw new TypeError(`${description} must contain an array`);
  return value;
}

export function createSerializedFileWriter(filePath, {
  writeFile = fs.writeFile,
  open = fs.open,
  rename = fs.rename,
  rm = fs.rm,
} = {}) {
  let tail = Promise.resolve();
  return (snapshot) => {
    const write = async () => {
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, snapshot, { encoding: "utf8", flag: "wx", mode: 0o600 });
        const handle = await open(temporaryPath, "r+");
        try { await handle.sync(); }
        finally { await handle.close(); }
        // The destination is untouched until the complete snapshot has been flushed.
        await rename(temporaryPath, filePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    };
    tail = tail.then(write, write);
    return tail;
  };
}
