import assert from "node:assert/strict";
import test from "node:test";
import { scopeSessionCatalog } from "../../../src/relay/session-access-policy.mjs";

const access = {
  projectRoot: "C:\\bridge-projects",
  users: [
    { openId: "ou_owner", status: "active", directoryName: "owner" },
    { openId: "ou_member", status: "active", directoryName: "member" },
  ],
};

const catalog = {
  projects: [
    {
      id: "owner-project",
      name: "Owner",
      rootPaths: ["C:\\bridge-projects\\owner\\alpha"],
      sessions: [{ id: "owner-task", cwd: "C:\\bridge-projects\\owner\\alpha", displayTitle: "Owner task" }],
    },
    {
      id: "member-project",
      name: "Member",
      rootPaths: ["C:\\bridge-projects\\member\\beta"],
      sessions: [{ id: "member-task", cwd: "C:\\bridge-projects\\member\\beta", displayTitle: "Member task" }],
    },
    {
      id: "unassigned-project",
      name: "Legacy",
      rootPaths: ["C:\\legacy\\gamma"],
      sessions: [{ id: "legacy-task", cwd: "C:\\legacy\\gamma", displayTitle: "Legacy task" }],
    },
    {
      id: "mixed-project",
      name: "Mixed",
      rootPaths: ["C:\\bridge-projects\\member\\inside", "C:\\outside\\mixed"],
      sessions: [{ id: "mixed-task", cwd: "C:\\bridge-projects\\member\\inside", displayTitle: "Mixed task" }],
    },
  ],
  independent: [
    { id: "member-independent", cwd: "C:\\bridge-projects\\member", displayTitle: "Member independent" },
    { id: "legacy-independent", cwd: "C:\\outside", displayTitle: "Legacy independent" },
    {
      id: "shared-bound-task",
      cwd: "C:\\bridge-projects\\owner\\alpha",
      displayTitle: "Bound",
      binding: { ownerOpenId: "ou_member" },
    },
  ],
  sessionsById: new Map(),
};

test("owner sees only owned plus unassigned projects and sessions", () => {
  const scoped = scopeSessionCatalog(catalog, access, {
    actorOpenId: "ou_owner",
    ownerOpenId: "ou_owner",
  });
  assert.deepEqual(scoped.projects.map(({ id }) => id), ["owner-project", "unassigned-project"]);
  assert.deepEqual(scoped.independent.map(({ id }) => id), ["legacy-independent"]);
  assert.equal(scoped.sessionsById.has("member-task"), false);
  assert.equal(scoped.canCreateProject, true);
});

test("member sees only its own directory and binding-owned sessions", () => {
  const scoped = scopeSessionCatalog(catalog, access, {
    actorOpenId: "ou_member",
    ownerOpenId: "ou_owner",
  });
  assert.deepEqual(scoped.projects.map(({ id }) => id), ["member-project"]);
  assert.deepEqual(scoped.independent.map(({ id }) => id), ["member-independent", "shared-bound-task"]);
  assert.equal(scoped.sessionsById.has("legacy-task"), false);
  assert.equal(scoped.independentCreateMode, "member-root");
  assert.equal(scoped.actorRoot, "C:\\bridge-projects\\member");
});

test("legacy unconfigured installations remain owner-only", () => {
  const owner = scopeSessionCatalog(catalog, { users: [] }, {
    actorOpenId: "ou_owner",
    ownerOpenId: "ou_owner",
  });
  const member = scopeSessionCatalog(catalog, { users: [] }, {
    actorOpenId: "ou_member",
    ownerOpenId: "ou_owner",
  });
  assert.equal(owner.projects.length, 4);
  assert.equal(owner.independentCreateMode, "prompt-cwd");
  assert.deepEqual(member.projects, []);
  assert.deepEqual(member.independent, []);
});
