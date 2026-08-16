import assert from "node:assert/strict";
import test from "node:test";
import {
  createSerializedFileWriter,
  readJsonArrayFile,
} from "../../../src/persistence/serialized-json-file.mjs";

test("reads arrays and treats a missing JSON file as empty", async () => {
  assert.deepEqual(await readJsonArrayFile("state.json", "State", {
    readFile: async () => '[{"id":1}]',
  }), [{ id: 1 }]);
  assert.deepEqual(await readJsonArrayFile("missing.json", "State", {
    readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  }), []);
  await assert.rejects(
    readJsonArrayFile("invalid.json", "State", { readFile: async () => "{}" }),
    /State must contain an array/,
  );
});

test("serializes writes and recovers after a rejected write", async () => {
  const calls = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const write = createSerializedFileWriter("state.json", {
    writeFile: async (_filePath, snapshot) => {
      calls.push(snapshot);
      if (snapshot === "first") await firstBlocked;
      if (snapshot === "failed") throw new Error("write failed");
    },
  });

  const first = write("first");
  const second = write("second");
  await Promise.resolve();
  assert.deepEqual(calls, ["first"]);
  releaseFirst();
  await Promise.all([first, second]);
  await assert.rejects(write("failed"), /write failed/);
  await write("recovered");
  assert.deepEqual(calls, ["first", "second", "failed", "recovered"]);
});
