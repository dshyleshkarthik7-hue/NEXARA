import { runTwoBootValidation } from "./two-boot-validation.js";

/**
 * Build the concrete lifecycle adapter for a dedicated Linux/KVM host.
 *
 * createHost must construct a fresh host stack (jailer, network provider,
 * Firecracker driver, supervisor and persistent registry) on every call.
 * resolveDisk must return the broker-owned persistent disk and its stable ID.
 * bootGuest must launch the guest on that host and return captured serial data.
 * readDropCounter must read the per-VM nftables counter from the VM's namespace.
 *
 * The host integration supplies these privileged operations explicitly;
 * this module owns sequencing, identity checks, cleanup and evidence collection.
 */
export function createLinuxKvmTwoBootAdapter({
  createHost, resolveDisk, bootGuest, readDropCounter
} = {}) {
  for (const [name, fn] of Object.entries({ createHost, resolveDisk, bootGuest, readDropCounter })) {
    if (typeof fn !== "function") throw new TypeError(name + " must be a trusted host integration function");
  }

  return async function bootOnce({ bootNumber, stateDirectory, diskId } = {}) {
    if (![1, 2].includes(bootNumber) || typeof stateDirectory !== "string"
      || !stateDirectory.startsWith("/") || typeof diskId !== "string" || !diskId) {
      throw new TypeError("Invalid two-boot host invocation");
    }

    const host = await createHost(Object.freeze({
      bootNumber, stateDirectory, reconstruct: true, requireKvm: true,
      requireJailer: true, requireCgroups: true, requireSeccomp: true,
      requireNamespaces: true, defaultDeny: true
    }));
    if (!host || typeof host.id !== "string" || !host.id
      || typeof host.close !== "function") {
      throw new Error("Host factory must return a uniquely identified host with close()");
    }

    let primaryError;
    try {
      const disk = await resolveDisk(Object.freeze({ host, stateDirectory, diskId }));
      if (!disk || disk.id !== diskId || typeof disk.device?.importRaw !== "function") {
        throw new Error("Persistent disk resolver did not return the requested broker-owned disk");
      }
      const before = await readDropCounter(Object.freeze({ host, disk, phase: "before", bootNumber }));
      if (!Number.isSafeInteger(before) || before < 0) throw new Error("Invalid per-VM nftables counter before guest boot");
      const guest = await bootGuest(Object.freeze({
        host, disk, bootNumber, stateDirectory,
        requireSerialCapture: true, requireCleanShutdown: true,
        requireDiskWriteback: true
      }));
      if (!guest || typeof guest.serialOutput !== "string" || !guest.serialOutput.length
        || guest.diskId !== diskId || guest.writebackComplete !== true
        || guest.guestStopped !== true) {
        throw new Error("Guest runner did not confirm serial capture, disk write-back and clean shutdown");
      }
      const after = await readDropCounter(Object.freeze({ host, disk, phase: "after", bootNumber }));
      if (!Number.isSafeInteger(after) || after <= before) {
        throw new Error("Per-VM nftables drop counter did not increase during guest probe");
      }
      return Object.freeze({
        serialOutput: guest.serialOutput,
        diskId: disk.id,
        hostInstanceId: host.id,
        nftDropCounterBefore: before,
        nftDropCounterAfter: after
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await host.close();
      } catch (closeError) {
        if (primaryError) throw new AggregateError([primaryError, closeError], "Guest validation and host cleanup both failed");
        throw closeError;
      }
    }
  };
}

/** Run the validated two-boot scenario using a freshly constructed host per boot. */
export async function executeLinuxKvmTwoBootValidation({
  stateDirectory, diskId, createHost, resolveDisk, bootGuest, readDropCounter
} = {}) {
  const bootOnce = createLinuxKvmTwoBootAdapter({ createHost, resolveDisk, bootGuest, readDropCounter });
  return runTwoBootValidation({ stateDirectory, diskId, bootOnce });
}
