import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryBlockDevice } from "../packages/runtime/src/block-device.js";
import { DurableRecoveryJournal } from "../packages/security/src/durable-recovery-journal.js";
import { PersistentVmRegistry } from "../packages/security/src/persistent-vm-registry.js";
import { createMicroVmHost } from "../packages/security/src/microvm-host.js";
import { VmLeaseAuthority } from "../packages/security/src/lease.js";

const digest = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");

test("host startup restores pending guest writes through persistent VM identity registry", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-host-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vmId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const baseBytes = Buffer.alloc(64 * 512, 0x12);
  const writableBase = new MemoryBlockDevice({ sectors: 64 });
  writableBase.writeSectors(0, baseBytes);
  const immutableBase = {
    sectors: 64, readOnly: true,
    readSectors: (lba, count) => writableBase.readSectors(lba, count)
  };
  const baseDigest = digest(baseBytes);
  const resolveBaseDevice = async requested => {
    assert.equal(requested, baseDigest);
    return immutableBase;
  };
  const stateDirectory = path.join(root, "state");
  const overlayDirectory = path.join(root, "overlays");

  // Provision the VM identity before simulated host power loss.
  const firstRegistry = new PersistentVmRegistry({
    directory: path.join(stateDirectory, "vm-registry"),
    overlayDirectory, resolveBaseDevice
  });
  await firstRegistry.create({ vmId, sectors: 64, baseDigest });
  await firstRegistry.close();

  const pendingRaw = path.join(root, "pending.raw");
  const guestBytes = Buffer.from(baseBytes);
  guestBytes.fill(0x7b, 9 * 512, 10 * 512);
  await writeFile(pendingRaw, guestBytes, { mode: 0o600 });
  const firstJournal = new DurableRecoveryJournal({
    directory: path.join(stateDirectory, "disk-recovery")
  });
  await firstJournal.save({ vmId, sourcePath: pendingRaw });

  const host = await createMicroVmHost({
    authority: new VmLeaseAuthority("nexara-host-startup-test-secret-over-32-bytes"),
    provider: { start: async () => { throw new Error("VM launch not expected during startup test"); }, stop: async () => {} },
    resolveImage: async () => { throw new Error("Image resolution not expected during recovery"); },
    resolveBaseDevice,
    stateDirectory, overlayDirectory
  });
  assert.equal(host.recovered.length, 1);
  assert.equal(host.recovered[0].vmId, vmId);
  const restored = await host.registry.open(vmId);
  assert.equal(Buffer.from(await restored.readSectors(9))[0], 0x7b);
  assert.equal(Buffer.from(await restored.readSectors(8))[0], 0x12);
  assert.equal((await host.journal.list()).length, 0);
  await host.close();
});
