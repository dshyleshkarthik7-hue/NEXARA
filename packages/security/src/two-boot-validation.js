const REQUIRED_FIRST = [
  "NEXARA_GUEST_BOOT_OK",
  "NEXARA_DISK_WRITE_OK",
  "NEXARA_GUEST_VALIDATION_COMPLETE",
  "NEXARA_EGRESS_BLOCKED"
];
const REQUIRED_SECOND = [
  "NEXARA_GUEST_BOOT_OK",
  "NEXARA_DISK_PERSISTENCE_PRESENT",
  "NEXARA_GUEST_VALIDATION_COMPLETE",
  "NEXARA_EGRESS_BLOCKED"
];

/**
 * Run two sequential boots through a trusted host adapter.
 *
 * bootOnce({ bootNumber, stateDirectory, diskId }) must fully boot and stop
 * Firecracker, persist disk write-back, close the host stack, and return
 * { serialOutput, diskId, hostInstanceId, nftDropCounter }.
 * The caller must create a fresh host instance on each invocation while
 * retaining the same registry/state directory and persistent disk identity.
 */
export async function runTwoBootValidation({
  bootOnce, stateDirectory, diskId
} = {}) {
  if (typeof bootOnce !== "function" || typeof stateDirectory !== "string"
    || !stateDirectory.startsWith("/") || typeof diskId !== "string"
    || !/^[a-zA-Z0-9._-]{1,128}$/.test(diskId)) {
    throw new TypeError("Two-boot validation requires a trusted boot adapter, absolute state directory and stable disk ID");
  }

  const first = await bootOnce(Object.freeze({ bootNumber: 1, stateDirectory, diskId }));
  validateBoot(first, 1);
  requireMarkers(first.serialOutput, REQUIRED_FIRST, "first boot");
  if (first.nftDropCounterBefore === undefined || first.nftDropCounterAfter === undefined
    || !Number.isSafeInteger(first.nftDropCounterBefore) || !Number.isSafeInteger(first.nftDropCounterAfter)
    || first.nftDropCounterAfter <= first.nftDropCounterBefore) {
    throw new Error("First boot did not provide an increasing per-VM nftables drop counter");
  }

  const second = await bootOnce(Object.freeze({ bootNumber: 2, stateDirectory, diskId }));
  validateBoot(second, 2);
  requireMarkers(second.serialOutput, REQUIRED_SECOND, "second boot");
  if (second.diskId !== first.diskId) throw new Error("Host adapter changed persistent disk identity between boots");
  if (second.hostInstanceId === first.hostInstanceId) throw new Error("Second boot reused the first host instance instead of reconstructing host state");
  if (second.nftDropCounterBefore === undefined || second.nftDropCounterAfter === undefined
    || !Number.isSafeInteger(second.nftDropCounterBefore) || !Number.isSafeInteger(second.nftDropCounterAfter)
    || second.nftDropCounterAfter <= second.nftDropCounterBefore) {
    throw new Error("Second boot did not provide an increasing per-VM nftables drop counter");
  }

  return Object.freeze({
    passed: true,
    diskId: first.diskId,
    hostInstances: Object.freeze([first.hostInstanceId, second.hostInstanceId]),
    nftDropCounters: Object.freeze([
      Object.freeze({ before: first.nftDropCounterBefore, after: first.nftDropCounterAfter }),
      Object.freeze({ before: second.nftDropCounterBefore, after: second.nftDropCounterAfter })
    ]),
    serialOutput: Object.freeze([first.serialOutput, second.serialOutput])
  });
}

function validateBoot(result, bootNumber) {
  if (!result || typeof result.serialOutput !== "string" || !result.serialOutput.length
    || typeof result.diskId !== "string" || !result.diskId
    || typeof result.hostInstanceId !== "string" || !result.hostInstanceId) {
    throw new Error("Boot adapter returned incomplete evidence for boot " + bootNumber);
  }
}

function requireMarkers(output, markers, label) {
  for (const marker of markers) {
    if (!output.includes(marker)) throw new Error(label + " missing required evidence marker: " + marker);
  }
  if (/NEXARA_(?:DISK_MOUNT_FAILED|DISK_WRITE_FAILED|EGRESS_UNEXPECTEDLY_ALLOWED|EGRESS_PROBE_UNAVAILABLE)/.test(output)) {
    throw new Error(label + " reported a disk or network validation failure");
  }
}
