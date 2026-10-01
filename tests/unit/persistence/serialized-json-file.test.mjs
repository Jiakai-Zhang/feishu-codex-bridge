import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
    open: async () => ({ sync: async () => {}, close: async () => {} }),
    rename: async () => {},
    rm: async () => {},
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

async function stateDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-json-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

for (const content of ["", "  \n", '[{"id":']) {
  test(`quarantines ${content ? "malformed" : "empty"} JSON before recovering`, async (t) => {
    const directory = await stateDirectory(t);
    const file = path.join(directory, "state.json");
    await fs.writeFile(file, content);
    const warnings = [];
    assert.deepEqual(await readJsonArrayFile(file, "State store", { warn: (warning) => warnings.push(warning) }), []);
    const [backup] = await fs.readdir(directory);
    assert.match(backup, /^state\.json\.corrupt-/);
    assert.equal(await fs.readFile(path.join(directory, backup), "utf8"), content);
    assert.match(warnings[0], /State store: invalid JSON preserved/);
    assert.ok(warnings[0].includes(path.join(directory, backup)));
    // A second startup is healthy without repeatedly moving the damaged snapshot.
    assert.deepEqual(await readJsonArrayFile(file, "State store"), []);
    await createSerializedFileWriter(file)('[{"id":2}]');
    assert.deepEqual(await readJsonArrayFile(file, "State store"), [{ id: 2 }]);
    assert.equal((await fs.readdir(directory)).length, 2);
  });
}

test("valid non-array JSON is never quarantined or silently cleared", async (t) => {
  const directory = await stateDirectory(t);
  for (const content of ["{}", "null", "42"]) {
    const file = path.join(directory, "state.json");
    await fs.writeFile(file, content);
    await assert.rejects(readJsonArrayFile(file, "Versioned store"), /Versioned store must contain an array/);
    assert.equal(await fs.readFile(file, "utf8"), content);
    assert.deepEqual(await fs.readdir(directory), ["state.json"]);
  }
});

test("quarantine failure preserves corruption and does not pretend recovery succeeded", async () => {
  await assert.rejects(readJsonArrayFile("state.json", "State", {
    readFile: async () => "",
    rename: async () => { throw new Error("quarantine denied"); },
    warn: () => assert.fail("must not claim recovery"),
  }), /quarantine denied/);
});

for (const stage of ["write", "sync", "rename"]) {
  test(`atomic ${stage} failure preserves the old snapshot and allows the next write`, async (t) => {
    const directory = await stateDirectory(t);
    const file = path.join(directory, "state.json");
    await fs.writeFile(file, '[{"id":1}]');
    let fail = true;
    const writer = createSerializedFileWriter(file, {
      writeFile: async (temporaryPath, snapshot, options) => {
        assert.notEqual(temporaryPath, file);
        assert.equal(path.dirname(temporaryPath), directory);
        await fs.writeFile(temporaryPath, fail && stage === "write" ? "[" : snapshot, options);
        if (fail && stage === "write") throw new Error("injected write failure");
      },
      open: async (...args) => {
        const handle = await fs.open(...args);
        return { close: () => handle.close(), sync: async () => {
          if (fail && stage === "sync") throw new Error("injected sync failure");
          await handle.sync();
        } };
      },
      rename: async (...args) => {
        if (fail && stage === "rename") throw new Error("injected rename failure");
        await fs.rename(...args);
      },
    });
    await assert.rejects(writer('[{"id":2}]'), /injected/);
    assert.equal(await fs.readFile(file, "utf8"), '[{"id":1}]');
    assert.deepEqual(await fs.readdir(directory), ["state.json"]);
    fail = false;
    await writer('[{"id":3}]');
    assert.deepEqual(await readJsonArrayFile(file, "State"), [{ id: 3 }]);
    assert.deepEqual(await fs.readdir(directory), ["state.json"]);
  });
}

test("concurrent atomic writes are committed in order with unique cleaned-up temporary paths", async (t) => {
  const directory = await stateDirectory(t);
  const file = path.join(directory, "state.json");
  const paths = [];
  const committed = [];
  const write = createSerializedFileWriter(file, {
    writeFile: async (temporaryPath, snapshot, options) => {
      paths.push(temporaryPath);
      await fs.writeFile(temporaryPath, snapshot, options);
    },
    rename: async (source, target) => {
      await fs.rename(source, target);
      committed.push(await fs.readFile(target, "utf8"));
    },
  });
  const snapshots = ["[1]", "[2]", "[3]"];
  await Promise.all(snapshots.map(write));
  assert.deepEqual(committed, snapshots);
  assert.equal(new Set(paths).size, snapshots.length);
  assert.deepEqual(await fs.readdir(directory), ["state.json"]);
});
