import { promises as fs } from "node:fs";

export async function readJsonArrayFile(filePath, description, { readFile = fs.readFile } = {}) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (!Array.isArray(value)) throw new TypeError(`${description} must contain an array`);
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function createSerializedFileWriter(filePath, { writeFile = fs.writeFile } = {}) {
  let tail = Promise.resolve();
  return (snapshot) => {
    const write = () => writeFile(filePath, snapshot, "utf8");
    tail = tail.then(write, write);
    return tail;
  };
}
