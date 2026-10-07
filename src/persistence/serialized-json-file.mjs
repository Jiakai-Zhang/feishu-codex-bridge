import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

function parseArray(text, description) {
  const value = JSON.parse(text);
  if (!Array.isArray(value)) throw new TypeError(`${description} must contain an array`);
  return value;
}

export async function readJsonArrayFile(filePath, description, {
  readFile = fs.readFile,
  rename = fs.rename,
  warn = console.warn,
} = {}) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try { return parseArray(await readFile(`${filePath}.bak`, "utf8"), description); }
    catch (backupError) {
      if (backupError?.code === "ENOENT" || backupError instanceof SyntaxError) return [];
      throw backupError;
    }
  }
  try {
    return parseArray(text, description);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const backupPath = `${filePath}.corrupt-${timestamp}-${randomUUID()}`;
    // Quarantine must succeed before attempting fallback; preserve the evidence.
    await rename(filePath, backupPath);
    warn(`${description}: invalid JSON preserved at ${backupPath}; attempting backup recovery.`);
    try {
      return parseArray(await readFile(`${filePath}.bak`, "utf8"), description);
    } catch (backupError) {
      if (backupError?.code !== "ENOENT" && !(backupError instanceof SyntaxError)) throw backupError;
      warn(`${description}: no valid JSON backup available; recovering with an empty array.`);
      return [];
    }
  }
}

export function createSerializedFileWriter(filePath, {
  writeFile = fs.writeFile,
  readFile = fs.readFile,
  open = fs.open,
  rename = fs.rename,
  rm = fs.rm,
} = {}) {
  let tail = Promise.resolve();
  return (snapshot) => {
    const write = async () => {
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      const backupTemporaryPath = `${temporaryPath}.bak`;
      const writeFlushed = async (target, content) => {
        await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        const handle = await open(target, "r+");
        try { await handle.sync(); }
        finally { await handle.close(); }
      };
      try {
        await writeFlushed(temporaryPath, snapshot);
        let previous = snapshot;
        try {
          const existing = await readFile(filePath, "utf8");
          JSON.parse(existing);
          previous = existing;
        } catch (error) {
          if (!(error instanceof SyntaxError) && error?.code !== "ENOENT") throw error;
          // Do not overwrite an existing valid recovery copy with corruption.
          try {
            const backup = await readFile(`${filePath}.bak`, "utf8");
            JSON.parse(backup);
            previous = backup;
          } catch (backupError) {
            if (!(backupError instanceof SyntaxError) && backupError?.code !== "ENOENT") throw backupError;
          }
        }
        await writeFlushed(backupTemporaryPath, previous);
        await rename(backupTemporaryPath, `${filePath}.bak`);
        // Live state is untouched until both complete private snapshots are flushed.
        await rename(temporaryPath, filePath);
      } finally {
        await Promise.all([
          rm(temporaryPath, { force: true }),
          rm(backupTemporaryPath, { force: true }),
        ]);
      }
    };
    tail = tail.then(write, write);
    return tail;
  };
}
