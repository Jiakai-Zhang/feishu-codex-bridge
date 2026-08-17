import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  basenameFsPath,
  extnameFsPath,
  isAbsoluteFsPath,
  isPathInside,
  normalizeFsPath,
  sameFsPath,
} from "../../../src/runtime/shared/fs-paths.mjs";

test("handles Windows paths without applying POSIX cwd semantics", () => {
  assert.equal(isAbsoluteFsPath("C:/repo/file.txt"), true);
  assert.equal(normalizeFsPath("\\\\?\\C:\\repo\\file.txt"), "C:\\repo\\file.txt");
  assert.equal(isPathInside("C:/repo", "C:/repo/src"), true);
  assert.equal(isPathInside("C:/repo", "C:/repository"), false);
  assert.equal(sameFsPath("C:/Repo", "c:\\repo"), true);
  assert.equal(basenameFsPath("C:/private/report.txt"), "report.txt");
  assert.equal(extnameFsPath("C:/private/report.txt"), ".txt");
});

test("uses native filesystem identity and resolves existing POSIX symlinks", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-fs-paths-"));
  const target = path.join(directory, "Target");
  const link = path.join(directory, "link");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(target);
  await fs.symlink(target, link);

  assert.equal(isAbsoluteFsPath(target), true);
  assert.equal(normalizeFsPath(link), normalizeFsPath(target));
  assert.equal(sameFsPath(link, target), true);
  assert.equal(basenameFsPath(path.join(target, "report.txt")), "report.txt");
});
