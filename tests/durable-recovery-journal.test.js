import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DurableRecoveryJournal } from "../packages/security/src/durable-recovery-journal.js";

test("durable recovery journal survives reconstruction and replays write-back", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journalDir = path.join(root, "journal");
  const source = path.join(root, "guest.raw");
  await writeFile(source, Buffer.alloc(4096, 0x6a), { mode: 0o600 });
  const vmId = "12345678-1234-4234-8234-123456789abc";
  const journal = new DurableRecoveryJournal({ directory: journalDir });
  const saved = await journal.save({ vmId, sourcePath: source });
  assert.equal((await journal.list()).length, 1);
  const restartedJournal = new DurableRecoveryJournal({ directory: journalDir });
  let importedPath;
  const results = await restartedJournal.recoverPending(async id => {
    assert.equal(id, vmId);
    return { importRaw: async diskPath => { importedPath = diskPath; return { changedSectors: 8 }; } };
  });
  assert.equal(importedPath, saved.diskPath);
  assert.equal(results[0].imported.changedSectors, 8);
  assert.equal((await restartedJournal.list()).length, 0);
});

test("failed recovery replay leaves the durable record intact", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-recovery-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "guest.raw");
  await writeFile(source, Buffer.alloc(512, 0x2b), { mode: 0o600 });
  const journal = new DurableRecoveryJournal({ directory: path.join(root, "journal") });
  await journal.save({ vmId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourcePath: source });
  await assert.rejects(() => journal.recoverPending(async () => ({ importRaw: async () => { throw new Error("storage unavailable"); } })), /storage unavailable/);
  assert.equal((await journal.list()).length, 1);
});


test("durable recovery journal rejects tampered disk contents before import", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-recovery-tamper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "guest.raw");
  await writeFile(source, Buffer.alloc(1024, 0x31), { mode: 0o600 });
  const journal = new DurableRecoveryJournal({ directory: path.join(root, "journal") });
  const saved = await journal.save({ vmId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sourcePath: source });
  const { writeFile: overwrite } = await import("node:fs/promises");
  await overwrite(saved.diskPath, Buffer.alloc(1024, 0x32));
  let imports = 0;
  await assert.rejects(() => journal.recoverPending(async () => ({
    importRaw: async () => { imports++; }
  })), /integrity check failed/);
  assert.equal(imports, 0);
});


test("durable recovery journal excludes concurrent replay workers", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-recovery-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "guest.raw");
  await writeFile(source, Buffer.alloc(512, 0x41), { mode: 0o600 });
  const journal = new DurableRecoveryJournal({ directory: path.join(root, "journal") });
  await journal.save({ vmId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sourcePath: source });
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const first = journal.recoverPending(async () => ({
    importRaw: async () => { entered(); await blocked; return { changedSectors: 1 }; }
  }));
  await enteredPromise;
  await assert.rejects(() => journal.recoverPending(async () => ({ importRaw: async () => ({}) })), /already running/);
  release();
  await first;
  assert.equal((await journal.list()).length, 0);
});
