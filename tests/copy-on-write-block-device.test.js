import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileBlockDevice } from "../packages/runtime/src/file-block-device.js";
import { CopyOnWriteBlockDevice } from "../packages/runtime/src/copy-on-write-block-device.js";

const digestOf = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");

test("copy-on-write disk reads base sectors until changed and persists overlay writes", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-cow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = await FileBlockDevice.open({ directory, vmId: "ba5e1234-1234-1234", sectors: 16 });
  const baseBytes = new Uint8Array(16 * 512);
  baseBytes.fill(0x31);
  await base.writeSectors(0, baseBytes);
  await base.sync();
  await base.close();
  const immutableBase = await FileBlockDevice.open({
    directory, vmId: "ba5e1234-1234-1234", sectors: 16, readOnly: true, create: false
  });
  let overlay = await CopyOnWriteBlockDevice.open({
    directory, vmId: "12345678-1234-4234-8234-123456789abc",
    sectors: 16, baseDigest: digestOf(baseBytes), baseDevice: immutableBase
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
    sectors: 16, baseDigest: digestOf(baseBytes), baseDevice: immutableBase, create: false
  });
  assert.equal((await overlay.readSectors(2, 2))[512], 0x7a);
  assert.equal(await overlay.changedSectorCount(), 2);
  await overlay.close();
  await immutableBase.close();
});

test("copy-on-write disk rejects base mismatch, writable base and out-of-range writes", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-cow-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = await FileBlockDevice.open({ directory, vmId: "ba5e1234-1234-1234", sectors: 4 });
  await assert.rejects(() => CopyOnWriteBlockDevice.open({
    directory, vmId: "12345678-1234-4234-8234-123456789abc",
    sectors: 4, baseDigest: digestOf(new Uint8Array(4 * 512)), baseDevice: base
  }), /base device must be read-only/);
  await base.close();
  const readOnly = await FileBlockDevice.open({
    directory, vmId: "ba5e1234-1234-1234", sectors: 4, readOnly: true, create: false
  });
  const zeroDigest = digestOf(new Uint8Array(4 * 512));
  const overlay = await CopyOnWriteBlockDevice.open({
    directory, vmId: "12345678-1234-4234-8234-123456789abc",
    sectors: 4, baseDigest: zeroDigest, baseDevice: readOnly
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
  const baseBytes = new Uint8Array(4096).fill(0x11);
  const imageDigest = digestOf(baseBytes);
  const envelope = authority.issue({
    subject: "cow-tenant", imageDigest,
    capabilities: ["storage-read", "storage-write"], egress: [],
    quotas: { diskMiB: 16 }
  }, { now: 100 });
  const broker = new VmCapabilityBroker({
    authority, envelope, subject: "cow-tenant", imageDigest, clock: () => 110
  });
  const base = await FileBlockDevice.open({ directory, vmId: "ba5e1234-1234-1234", sectors: 8 });
  await base.writeSectors(0, baseBytes);
  await base.close();
  const immutableBase = await FileBlockDevice.open({
    directory, vmId: "ba5e1234-1234-1234", sectors: 8, readOnly: true, create: false
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

test("copy-on-write disk rejects overlay files with permissive modes", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-cow-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = await FileBlockDevice.open({ directory, vmId: "ba5e1234-1234-1234", sectors: 2 });
  const baseBytes = new Uint8Array(1024);
  await base.close();
  const readOnly = await FileBlockDevice.open({
    directory, vmId: "ba5e1234-1234-1234", sectors: 2, readOnly: true, create: false
  });
  const vmId = "12345678-1234-4234-8234-123456789abc";
  const overlay = await CopyOnWriteBlockDevice.open({
    directory, vmId, sectors: 2, baseDigest: digestOf(baseBytes), baseDevice: readOnly
  });
  await overlay.close();
  await chmod(path.join(directory, vmId + ".overlay"), 0o644);
  await assert.rejects(() => CopyOnWriteBlockDevice.open({
    directory, vmId, sectors: 2, baseDigest: digestOf(baseBytes), baseDevice: readOnly, create: false
  }), /private regular file/);
  await readOnly.close();
});


test("copy-on-write disk materializes a hypervisor-compatible raw image without mutating its overlay", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-cow-raw-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseBytes = new Uint8Array(8 * 512).fill(0x21);
  const base = await FileBlockDevice.open({ directory, vmId: "ba5e1234-1234-1234", sectors: 8 });
  await base.writeSectors(0, baseBytes);
  await base.close();
  const immutableBase = await FileBlockDevice.open({ directory, vmId: "ba5e1234-1234-1234", sectors: 8, readOnly: true, create: false });
  const overlay = await CopyOnWriteBlockDevice.open({ directory, vmId: "12345678-1234-4234-8234-123456789abc", sectors: 8, baseDigest: digestOf(baseBytes), baseDevice: immutableBase });
  await overlay.writeSectors(3, new Uint8Array(512).fill(0x7c));
  const target = path.join(directory, "guest.raw");
  const result = await overlay.materializeRaw(target);
  const bytes = await readFile(target);
  assert.equal(result.format, "raw");
  assert.equal(result.byteLength, 4096);
  assert.equal(bytes.length, 4096);
  assert.equal(bytes[0], 0x21);
  assert.equal(bytes[3 * 512], 0x7c);
  assert.equal(bytes[4 * 512], 0x21);
  await assert.rejects(() => overlay.materializeRaw(target), { code: "EEXIST" });
  await overlay.close();
  await immutableBase.close();
});


test("copy-on-write snapshots restore into a new VM overlay without changing the source", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-cow-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseBytes = new Uint8Array(8 * 512).fill(0x19);
  const base = await FileBlockDevice.open({ directory, vmId: "ba5e1234-1234-1234", sectors: 8 });
  await base.writeSectors(0, baseBytes); await base.close();
  const immutableBase = await FileBlockDevice.open({ directory, vmId: "ba5e1234-1234-1234", sectors: 8, readOnly: true, create: false });
  const source = await CopyOnWriteBlockDevice.open({ directory, vmId: "12345678-1234-4234-8234-123456789abc", sectors: 8, baseDigest: digestOf(baseBytes), baseDevice: immutableBase });
  await source.writeSectors(2, new Uint8Array(512).fill(0x72));
  const snapshotPath = path.join(directory, "snapshot.cow");
  const metadata = await source.createSnapshot(snapshotPath);
  assert.equal(metadata.format, "nexara-cow-v1");
  const restored = await CopyOnWriteBlockDevice.restore({ snapshotPath, directory, vmId: "87654321-4321-4321-8321-cba987654321", sectors: 8, baseDigest: digestOf(baseBytes), baseDevice: immutableBase, expectedSnapshotDigest: metadata.snapshotDigest });
  assert.equal((await restored.readSectors(2))[0], 0x72);
  assert.equal((await restored.readSectors(1))[0], 0x19);
  await restored.writeSectors(2, new Uint8Array(512).fill(0x44));
  assert.equal((await source.readSectors(2))[0], 0x72);
  await assert.rejects(() => CopyOnWriteBlockDevice.restore({ snapshotPath, directory, vmId: "87654321-4321-4321-8321-cba987654321", sectors: 8, baseDigest: digestOf(baseBytes), baseDevice: immutableBase, expectedSnapshotDigest: metadata.snapshotDigest }));
  const tampered = path.join(directory, "tampered.cow");
  await copyFile(snapshotPath, tampered);
  const tamperedBytes = await readFile(tampered); tamperedBytes[tamperedBytes.length - 1] ^= 0xff; await writeFile(tampered, tamperedBytes);
  await assert.rejects(() => CopyOnWriteBlockDevice.restore({ snapshotPath: tampered, directory, vmId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sectors: 8, baseDigest: digestOf(baseBytes), baseDevice: immutableBase, expectedSnapshotDigest: metadata.snapshotDigest }), /integrity digest mismatch/);
  await restored.close(); await source.close(); await immutableBase.close();
});
