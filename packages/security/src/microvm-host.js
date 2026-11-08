import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { DurableRecoveryJournal } from "./durable-recovery-journal.js";
import { FirecrackerDriver } from "./firecracker-driver.js";
import { VmSupervisor } from "./vm-supervisor.js";
import { PersistentVmRegistry } from "./persistent-vm-registry.js";

/**
 * Assemble the production host microVM stack. Resolves all persisted VM disks
 * before returning; callers must not expose workload admission until this
 * factory resolves. Provider and base-device resolver are trusted host code.
 */
export async function createMicroVmHost({
  authority, provider, resolveImage, resolveBaseDevice,
  stateDirectory, overlayDirectory, clock = Date.now, limits = {}, timeoutMs = 5000
} = {}) {
  if (typeof stateDirectory !== "string" || typeof overlayDirectory !== "string"
    || !authority || typeof resolveImage !== "function" || typeof resolveBaseDevice !== "function") {
    throw new TypeError("MicroVM host requires authority, image/base resolvers, and persistent storage directories");
  }
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const stateStat = await lstat(stateDirectory);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || (stateStat.mode & 0o077) !== 0) {
    throw new Error("MicroVM host state directory must be private and non-symlink");
  }
  const registry = new PersistentVmRegistry({
    directory: path.join(stateDirectory, "vm-registry"),
    overlayDirectory,
    resolveBaseDevice
  });
  const journal = new DurableRecoveryJournal({ directory: path.join(stateDirectory, "disk-recovery") });

  const rootDiskFactory = async ({ id, imageDigest, quotas }) => {
    const manifest = await resolveImage(imageDigest);
    if (!manifest || manifest.digest !== imageDigest
      || typeof manifest.rootfsPath !== "string" || typeof manifest.rootfsDigest !== "string") {
      throw new Error("Cannot provision VM disk without a trusted image manifest");
    }
    const stat = await lstat(manifest.rootfsPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 512 || stat.size % 512 !== 0
      || stat.size > quotas.diskMiB * 1024 * 1024) {
      throw new Error("Trusted root image has invalid geometry or exceeds the VM disk quota");
    }
    return registry.create({
      vmId: id,
      sectors: stat.size / 512,
      baseDigest: manifest.rootfsDigest
    });
  };

  const driver = new FirecrackerDriver({ provider, resolveImage, recoveryJournal: journal, timeoutMs });
  const supervisor = new VmSupervisor({
    authority, driver, clock, limits, recoveryJournal: journal,
    resolveRecoveryDevice: registry.resolveDevice,
    rootDiskFactory,
    releaseRootDisk: vmId => registry.release(vmId)
  });

  try {
    // Fail closed: this promise must resolve before HTTP/API admission starts.
    const recovered = await supervisor.initialize();
    return Object.freeze({
      supervisor, registry, journal, driver,
      recovered,
      async close() {
        // Keep disk handles open if VM shutdown/write-back fails so the host
        // can retry persistence instead of closing the only recovery device.
        await supervisor.close();
        await registry.close();
      }
    });
  } catch (error) {
    await registry.close().catch(() => {});
    throw error;
  }
}
