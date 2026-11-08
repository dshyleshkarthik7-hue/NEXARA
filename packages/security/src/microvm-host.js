import { lstat } from "node:fs/promises";
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
  const registry = new PersistentVmRegistry({
    directory: stateDirectory + "/vm-registry",
    overlayDirectory,
    resolveBaseDevice
  });
  const journal = new DurableRecoveryJournal({ directory: stateDirectory + "/disk-recovery" });

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
    rootDiskFactory
  });

  try {
    // Fail closed: this promise must resolve before HTTP/API admission starts.
    const recovered = await supervisor.initialize();
    return Object.freeze({
      supervisor, registry, journal, driver,
      recovered,
      async close() {
        const results = await Promise.allSettled([supervisor.close()]);
        await registry.close();
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
      }
    });
  } catch (error) {
    await registry.close().catch(() => {});
    throw error;
  }
}
