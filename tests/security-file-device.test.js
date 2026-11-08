import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VmLeaseAuthority } from "../packages/security/src/lease.js";
import { VmCapabilityBroker } from "../packages/security/src/capability-broker.js";
import { FileBlockDevice } from "../packages/runtime/src/file-block-device.js";

test("capability broker mediates persistent block-device reads and writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-broker-disk-"));
  const authority = new VmLeaseAuthority("nexara-file-device-broker-test-secret-32bytes");
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const envelope = authority.issue({
    subject: "tenant-storage", imageDigest,
    capabilities: ["storage-read", "storage-write"], egress: [],
    quotas: { diskMiB: 16 }
  }, { now: 1000 });
  const broker = new VmCapabilityBroker({
    authority, envelope, subject: "tenant-storage", imageDigest, clock: () => 1010
  });
  let device;
  try {
    device = await FileBlockDevice.open({
      directory, vmId: "12345678-1234-4234-8234-123456789abc", sectors: 8
    });
    await broker.writeBlockDevice({ lba: 2, data: new Uint8Array(512).fill(0x7c), device });
    const result = await broker.readBlockDevice({ lba: 2, count: 1, device });
    assert.equal(result[0], 0x7c);
    await assert.rejects(() => broker.writeBlockDevice({
      lba: 32768, data: new Uint8Array(512), device
    }), /quota/);
  } finally {
    await device?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
