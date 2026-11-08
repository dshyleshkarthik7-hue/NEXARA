import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileBlockDevice } from "../packages/runtime/src/file-block-device.js";
import { CopyOnWriteBlockDevice } from "../packages/runtime/src/copy-on-write-block-device.js";

const digest = "sha256:" + "a".repeat(64);

test("copy-on-write disk reads base sectors until changed and persists overlay writes", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-cow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = await FileBlockDevice.open({ directory, vmId: "base-12345678-1234", sectors: 16 });
  const baseBytes = new Uint8Array(16 * 512);
  baseBytes.fill(0x31);
  await base.writeSectors(0, baseBytes);
  await base.sync();
  await base.close();
  const immutableBase = await FileBlockDevice.open({
    directory, vmId: "base-12345678-1234", sectors: 16, readOnly: true, create: false
  });
  let overlay = await CopyOnWriteBlockDevice.open({
    directory, vmId: "12345678-1234-4234-8234-123456789abc",
    sectors: 16, baseDigest: digest, baseDevice: immutableBase
  });
  assert.equal((await overlay.readSectors(2))[0], 0x31);
  await overlay.writeSectors(2, new Uint8Array(1024).fill(0x7a));
  assert.equal(await overlay.changedSectorCount(), 2);
  assert.equal((await overlay.readSectors(1, 3))[0], 0x31);
  assert.equal((await overlay.readSectors(2, 2))[0], 0x7a);
  await overlay.sync();
  await overlay.close();
  overlay = await CopyOnWriteBlockDevice.open({
    directory, vmId: "12345678-1234-4234-8234-123456789abc",
    sectors: 16, baseDigest: digest, baseDevice: immutableBase, create: false
  });
  assert.equal((await overlay.readSectors(2, 2))[512], 0x7a);
  assert.equal(await overlay.changedSectorCount(), 2);
  await overlay.close();
  await immutableBase.close();
});

test("copy-on-write disk rejects base mismatch, writable base and out-of-range writes", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-cow-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = await FileBlockDevice.open({ directory, vmId: "base-12345678-1234", sectors: 4 });
  await assert.rejects(() => CopyOnWriteBlockDevice.open({
    directory, vmId: "12345678-1234-4234-8234-123456789abc",
    sectors: 4, baseDigest: digest, baseDevice: base
  }), /base device must be read-only/);
  await base.close();
  const readOnly = await FileBlockDevice.open({
    directory, vmId: "base-12345678-1234", sectors: 4, readOnly: true, create: false
  });
  const overlay = await CopyOnWriteBlockDevice.open({
    directory, vmId: "12345678-1234-4234-8234-123456789abc",
    sectors: 4, baseDigest: digest, baseDevice: readOnly
  });
  await assert.rejects(() => overlay.writeSectors(4, new Uint8Array(512)), /outside/);
  await overlay.close();
  await assert.rejects(() => CopyOnWriteBlockDevice.open({
    directory, vmId: "12345678-1234-4234-8234-123456789abc",
    sectors: 4, baseDigest: "sha256:" + "b".repeat(64), baseDevice: readOnly, create: false
  }), /does not match/);
  await readOnly.close();
});

test("copy-on-write disk works through the lease capability broker", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-cow-broker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { VmLeaseAuthority } = await import("../packages/security/src/lease.js");
  const { VmCapabilityBroker } = await import("../packages/security/src/capability-broker.js");
  const authority = new VmLeaseAuthority("nexara-cow-broker-secret-key-32-bytes-long");
  const imageDigest = "sha256:" + "c".repeat(64);
  const envelope = authority.issue({
    subject: "cow-tenant", imageDigest,
    capabilities: ["storage-read", "storage-write"], egress: [],
    quotas: { diskMiB: 16 }
  }, { now: 100 });
  const broker = new VmCapabilityBroker({
    authority, envelope, subject: "cow-tenant", imageDigest, clock: () => 110
  });
  const base = await FileBlockDevice.open({ directory, vmId: "base-12345678-1234", sectors: 8 });
  await base.writeSectors(0, new Uint8Array(4096).fill(0x11));
  await base.close();
  const immutableBase = await FileBlockDevice.open({
    directory, vmId: "base-12345678-1234", sectors: 8, readOnly: true, create: false
  });
  const overlay = await CopyOnWriteBlockDevice.open({
    directory, vmId: "12345678-1234-4234-8234-123456789abc",
    sectors: 8, baseDigest: imageDigest, baseDevice: immutableBase
  });
  await broker.writeBlockDevice({ lba: 4, data: new Uint8Array(512).fill(0x55), device: overlay });
  assert.equal((await broker.readBlockDevice({ lba: 4, device: overlay }))[0], 0x55);
  assert.equal((await broker.readBlockDevice({ lba: 3, device: overlay }))[0], 0x11);
  await overlay.close();
  await immutableBase.close();
});
