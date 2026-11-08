import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir, open } from "node:fs/promises";
import http from "node:http";
import { FirecrackerDriver } from "../packages/security/src/firecracker-driver.js";
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


test("host guest-write lifecycle persists COW sectors across host restart", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-host-writeback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kernelPath = path.join(root, "vmlinux");
  const rootfsPath = path.join(root, "rootfs.raw");
  const kernelBytes = Buffer.from("nexara-test-kernel");
  const baseBytes = Buffer.alloc(64 * 512, 0x21);
  await writeFile(kernelPath, kernelBytes, { mode: 0o600 });
  await writeFile(rootfsPath, baseBytes, { mode: 0o600 });
  const imageDigest = digest(Buffer.from("signed-test-image-manifest"));
  const rootfsDigest = digest(baseBytes);
  const kernelDigest = digest(kernelBytes);
  const resolveImage = async requested => {
    assert.equal(requested, imageDigest);
    return { digest: imageDigest, kernelPath, rootfsPath, kernelDigest, rootfsDigest, readOnlyRootfs: true };
  };
  const baseMemory = new MemoryBlockDevice({ sectors: 64 });
  baseMemory.writeSectors(0, baseBytes);
  const resolveBaseDevice = async requested => {
    assert.equal(requested, rootfsDigest);
    return {
      sectors: 64, readOnly: true,
      readSectors: (lba, count) => baseMemory.readSectors(lba, count)
    };
  };
  const stateDirectory = path.join(root, "state");
  const overlayDirectory = path.join(root, "overlays");
  let apiServer;
  let stagedDisk;
  const provider = {
    start: async () => {
      const jailRoot = path.join(root, "jail");
      await mkdir(jailRoot, { recursive: true, mode: 0o700 });
      const socketPath = path.join(root, "firecracker.sock");
      apiServer = http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const payload = body ? JSON.parse(body) : {};
        if (request.url === "/drives/rootfs") {
          stagedDisk = path.join(jailRoot, "nexara", "rootfs.ext4");
          assert.equal(payload.is_read_only, false);
        }
        if (request.url === "/actions" && payload.action_type === "InstanceStart") {
          const file = await open(stagedDisk, "r+");
          try { await file.write(Buffer.alloc(512, 0x7b), 0, 512, 11 * 512); }
          finally { await file.close(); }
        }
        response.writeHead(204);
        response.end();
      });
      await new Promise((resolve, reject) => apiServer.listen(socketPath, error => error ? reject(error) : resolve()));
      return {
        socketPath, jailRoot,
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000
      };
    },
    stop: async () => {
      if (apiServer?.listening) await new Promise(resolve => apiServer.close(resolve));
    }
  };
  const authority = new VmLeaseAuthority("nexara-end-to-end-writeback-test-secret-32-bytes");
  const makeHost = () => createMicroVmHost({
    authority, provider, resolveImage, resolveBaseDevice,
    stateDirectory, overlayDirectory
  });
  const host = await makeHost();
  const envelope = authority.issue({
    subject: "tenant-writeback",
    imageDigest,
    quotas: { cpuMillis: 1000, memoryMiB: 128, diskMiB: 16 },
    capabilities: ["storage-read", "storage-write"],
    egress: []
  });
  const workloadKey = "integration-workload-writeback-1";
  const vm = await host.supervisor.create({ envelope, subject: "tenant-writeback", imageDigest, workloadKey });
  assert.equal(vm.state, "running");
  await host.supervisor.stop(vm.id);
  assert.equal((await host.journal.list()).length, 0);
  await host.close();

  // Reopen all persistent host state as if the host process restarted.
  const restarted = await makeHost();
  assert.equal(await restarted.registry.getOrCreateIdentity({ workloadKey, subject: "tenant-writeback", imageDigest }), vm.id);
  const restored = await restarted.registry.open(vm.id);
  assert.equal(Buffer.from(await restored.readSectors(11))[0], 0x7b);
  assert.equal(Buffer.from(await restored.readSectors(10))[0], 0x21);
  await restarted.close();
});
