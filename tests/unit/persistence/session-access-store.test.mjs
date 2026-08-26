import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionAccessStore,
  SessionAccessStoreError,
} from "../../../src/persistence/session-access-store.mjs";

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-access-store-"));
  try {
    await run({
      directory,
      statePath: path.join(directory, "access.json"),
      projectRoot: path.join(directory, "projects"),
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("configures one owner root and persists member directories without exposing paths in records", async () => {
  await fixture(async ({ statePath, projectRoot }) => {
    const store = await SessionAccessStore.open(statePath, { ownerOpenId: "ou_owner" });
    assert.equal(store.isConfigured(), false);

    await store.configureProjectRoot({ projectRoot, ownerDirectoryName: "owner" });
    const member = await store.addMember({
      openId: "ou_member",
      directoryName: "member-a",
      displayName: "Member A",
    });

    assert.deepEqual(member, {
      openId: "ou_member",
      role: "member",
      status: "active",
      directoryName: "member-a",
      displayName: "Member A",
      createdAt: member.createdAt,
    });
    assert.equal(store.isConfigured(), true);
    assert.equal((await fs.stat(store.getUserRoot("ou_member"))).isDirectory(), true);

    const reopened = await SessionAccessStore.open(statePath, { ownerOpenId: "ou_owner" });
    assert.equal(reopened.isActive("ou_member"), true);
    assert.equal(reopened.getUser("ou_member").directoryName, "member-a");
  });
});

test("requires a new member directory to be empty and never reassigns it", async () => {
  await fixture(async ({ statePath, projectRoot }) => {
    await fs.mkdir(path.join(projectRoot, "occupied"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "occupied", "user.txt"), "keep");
    const store = await SessionAccessStore.open(statePath, { ownerOpenId: "ou_owner" });
    await store.configureProjectRoot({ projectRoot, ownerDirectoryName: "owner" });

    await assert.rejects(
      store.addMember({ openId: "ou_member", directoryName: "occupied" }),
      (error) => error instanceof SessionAccessStoreError && error.code === "member_directory_not_empty",
    );
    await store.addMember({ openId: "ou_member", directoryName: "member-a" });
    await assert.rejects(
      store.addMember({ openId: "ou_member", directoryName: "member-b" }),
      (error) => error?.code === "member_directory_immutable",
    );
  });
});

test("creates Bridge Projects only as new directories below the active user's root", async () => {
  await fixture(async ({ statePath, projectRoot }) => {
    const store = await SessionAccessStore.open(statePath, { ownerOpenId: "ou_owner" });
    await store.configureProjectRoot({ projectRoot, ownerDirectoryName: "owner" });
    await store.addMember({ openId: "ou_member", directoryName: "member-a" });

    const project = await store.createProject({ ownerOpenId: "ou_member", name: "frontend" });
    assert.equal(project.ownerOpenId, "ou_member");
    assert.equal(project.name, "frontend");
    assert.equal((await fs.stat(project.rootPath)).isDirectory(), true);
    assert.equal(store.listProjects()[0].source, "bridge");

    await assert.rejects(
      store.createProject({ ownerOpenId: "ou_member", name: "frontend" }),
      (error) => error?.code === "project_directory_exists",
    );
    await store.deactivateMember("ou_member");
    await assert.rejects(
      store.createProject({ ownerOpenId: "ou_member", name: "another" }),
      (error) => error?.code === "member_root_unavailable",
    );
  });
});

test("does not silently reassign an already configured Project root", async () => {
  await fixture(async ({ statePath, projectRoot, directory }) => {
    const store = await SessionAccessStore.open(statePath, { ownerOpenId: "ou_owner" });
    await store.configureProjectRoot({ projectRoot, ownerDirectoryName: "owner" });
    await store.configureProjectRoot({ projectRoot, ownerDirectoryName: "owner" });
    await assert.rejects(
      store.configureProjectRoot({ projectRoot: path.join(directory, "other"), ownerDirectoryName: "owner" }),
      (error) => error?.code === "project_root_immutable",
    );
  });
});
