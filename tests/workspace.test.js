import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryWorkspaceStore,
  WorkspaceConflictError,
  normalizeWorkspacePath,
  WORKSPACE_LIMITS
} from "../packages/workspace/src/index.js";

test("workspace paths are normalized and traversal is rejected", () => {
  assert.equal(normalizeWorkspacePath("src\\main.js"), "src/main.js");
  assert.equal(normalizeWorkspacePath("notes/readme.md"), "notes/readme.md");
  for (const path of ["", "../secret", "/etc/passwd", "src/../../secret", "C:\\secret", ".nexara/config", "bad\\u0000name"]) {
    assert.throws(() => normalizeWorkspacePath(path), TypeError);
  }
});

test("workspace files persist in the store and list in path order", async () => {
  const store = new MemoryWorkspaceStore();
  const a = await store.write("zeta.txt", "last");
  const b = await store.write("src/main.js", "console.log('NEXARA')");
  assert.equal(a.revision, 1);
  assert.equal(b.revision, 1);
  assert.deepEqual((await store.list()).map(file => file.path), ["src/main.js", "zeta.txt"]);
  assert.equal((await store.read("src/main.js")).content, "console.log('NEXARA')");
});

test("workspace revision checks reject stale writes and deletes", async () => {
  const store = new MemoryWorkspaceStore();
  const first = await store.write("main.js", "one");
  const second = await store.write("main.js", "two", { expectedRevision: first.revision });
  assert.equal(second.revision, 2);
  await assert.rejects(
    store.write("main.js", "stale", { expectedRevision: first.revision }),
    WorkspaceConflictError
  );
  await assert.rejects(
    store.delete("main.js", { expectedRevision: first.revision }),
    WorkspaceConflictError
  );
  assert.equal((await store.read("main.js")).content, "two");
});

test("workspace delete is revision checked and idempotent for missing files", async () => {
  const store = new MemoryWorkspaceStore();
  const file = await store.write("tmp.txt", "discard");
  assert.equal(await store.delete("tmp.txt", { expectedRevision: file.revision }), true);
  assert.equal(await store.delete("tmp.txt"), false);
});

test("workspace rejects oversized and non-text content", async () => {
  const store = new MemoryWorkspaceStore();
  await assert.rejects(store.write("large.txt", "x".repeat(WORKSPACE_LIMITS.maxFileBytes + 1)), RangeError);
  await assert.rejects(store.write("bad.txt", new Uint8Array([1, 2])), TypeError);
});
