import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryBlockDevice } from "../packages/runtime/src/block-device.js";
import { PersistentVmRegistry } from "../packages/security/src/persistent-vm-registry.js";

const digest = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");

test("persistent VM registry reopens the same COW overlay after reconstruction", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-vm-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(64 * 512, 0x11);
  // Seed the fixture before making its immutable read-only view.
  const writable = new MemoryBlockDevice({ sectors: 64 });
  writable.writeSectors(0, bytes);
  const immutableBase = { sectors: 64, readOnly: true, readSectors: (lba, count) => writable.readSectors(lba, count) };
  const baseDigest = digest(bytes);
  const options = {
    directory: path.join(root, "registry"),
    overlayDirectory: path.join(root, "overlays"),
    resolveBaseDevice: async requested => {
      assert.equal(requested, baseDigest);
      return immutableBase;
    }
  };
  const vmId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const registry = new PersistentVmRegistry(options);
  const device = await registry.create({ vmId, sectors: 64, baseDigest });
  await device.writeSectors(3, Buffer.alloc(512, 0x7a));
  await registry.close();

  const restarted = new PersistentVmRegistry(options);
  const recovered = await restarted.open(vmId);
  assert.equal(Buffer.from(await recovered.readSectors(3))[0], 0x7a);
  assert.equal(Buffer.from(await recovered.readSectors(4))[0], 0x11);
  await assert.rejects(() => restarted.create({ vmId, sectors: 64, baseDigest }), /already registered/);
  await restarted.close();
});

test("persistent VM registry refuses untrusted or mismatched base devices", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-vm-registry-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new PersistentVmRegistry({
    directory: path.join(root, "registry"),
    overlayDirectory: path.join(root, "overlays"),
    resolveBaseDevice: async () => ({ sectors: 8, readOnly: false, readSectors: () => new Uint8Array(512) })
  });
  await assert.rejects(() => registry.create({
    vmId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    sectors: 8,
    baseDigest: "sha256:" + "a".repeat(64)
  }), /immutable base device/);
  await registry.close();
});


test("persistent VM registry restores stable workload UUID and prevents tenant/image rebinding", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-stable-workload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(64 * 512, 0x22);
  const writable = new MemoryBlockDevice({ sectors: 64 });
  writable.writeSectors(0, bytes);
  const baseDigest = digest(bytes);
  const options = {
    directory: path.join(root, "registry"),
    overlayDirectory: path.join(root, "overlays"),
    resolveBaseDevice: async () => ({
      sectors: 64, readOnly: true,
      readSectors: (lba, count) => writable.readSectors(lba, count)
    })
  };
  const workload = { workloadKey: "control-plane-job-88", subject: "tenant-a", imageDigest: baseDigest };
  const first = new PersistentVmRegistry(options);
  const id = await first.getOrCreateIdentity(workload);
  await first.create({ vmId: id, sectors: 64, baseDigest });
  await first.close();

  const restarted = new PersistentVmRegistry(options);
  assert.equal(await restarted.getOrCreateIdentity(workload), id);
  const reopened = await restarted.openOrCreate({ vmId: id, sectors: 64, baseDigest });
  assert.equal(Buffer.from(await reopened.readSectors(0))[0], 0x22);
  await assert.rejects(() => restarted.getOrCreateIdentity({ ...workload, subject: "tenant-b" }), /already bound/);
  await assert.rejects(() => restarted.getOrCreateIdentity({ ...workload, imageDigest: digest(Buffer.alloc(64 * 512, 0x33)) }), /already bound/);
  await restarted.close();
});
