import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PersistentVmStorageRegistry } from "../packages/security/src/persistent-vm-storage-registry.js";
import { DurableRecoveryJournal } from "../packages/security/src/durable-recovery-journal.js";

const vmId = "12345678-1234-4234-8234-123456789abc";
const sectors = 2;
const baseBytes = Buffer.alloc(sectors * 512);
const baseDigest = "sha256:" + createHash("sha256").update(baseBytes).digest("hex");
function baseDevice() {
  return {
    sectors, readOnly: true,
    readSectors: async (lba, count) => new Uint8Array(baseBytes.subarray(lba * 512, (lba + count) * 512))
  };
}

test("persistent VM registry reconstructs the same COW overlay from stable VM identity", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-vm-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    directory: path.join(root, "registry"),
    overlayDirectory: path.join(root, "overlays"),
    resolveBaseDevice: async digest => {
      assert.equal(digest, baseDigest);
      return baseDevice();
    }
  };
  const registry = new PersistentVmStorageRegistry(options);
  const device = await registry.createDevice({ vmId, sectors, baseDigest });
  await device.writeSectors(1, Buffer.alloc(512, 0x5a));
  await device.sync();
  await device.close();

  const restarted = new PersistentVmStorageRegistry(options);
  const record = await restarted.getRecord(vmId);
  assert.equal(record.vmId, vmId);
  assert.equal(record.sectors, sectors);
  const restored = await restarted.resolveDevice(vmId);
  const bytes = Buffer.from(await restored.readSectors(1, 1));
  assert.equal(bytes[0], 0x5a);
  await restored.close();
});

test("registry rejects duplicate registration and untrusted VM IDs", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-vm-registry-dup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new PersistentVmStorageRegistry({
    directory: path.join(root, "registry"), overlayDirectory: path.join(root, "overlays"),
    resolveBaseDevice: async () => baseDevice()
  });
  const device = await registry.createDevice({ vmId, sectors, baseDigest });
  await device.close();
  await assert.rejects(() => registry.createDevice({ vmId, sectors, baseDigest }), /already registered/);
  await assert.rejects(() => registry.getRecord("../../escape"), /must be a UUID/);
});

test("durable journal replay resolves the COW overlay from persistent VM registry", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-registry-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    directory: path.join(root, "registry"), overlayDirectory: path.join(root, "overlays"),
    resolveBaseDevice: async () => baseDevice()
  };
  const registry = new PersistentVmStorageRegistry(options);
  const device = await registry.createDevice({ vmId, sectors, baseDigest });
  await device.close();

  const rawPath = path.join(root, "recovery.raw");
  const rawBytes = Buffer.alloc(sectors * 512);
  rawBytes.fill(0x7c, 512);
  await writeFile(rawPath, rawBytes, { mode: 0o600 });
  const journal = new DurableRecoveryJournal({ directory: path.join(root, "journal") });
  await journal.save({ vmId, sourcePath: rawPath });

  const restartedRegistry = new PersistentVmStorageRegistry(options);
  const replay = new DurableRecoveryJournal({ directory: path.join(root, "journal") });
  await replay.recoverPending(id => restartedRegistry.resolveForRecovery(id));

  const recovered = await restartedRegistry.resolveDevice(vmId);
  assert.equal(Buffer.from(await recovered.readSectors(1, 1))[0], 0x7c);
  await recovered.close();
  assert.equal((await replay.list()).length, 0);
});
