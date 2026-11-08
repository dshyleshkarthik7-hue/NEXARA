import test from "node:test";
import assert from "node:assert/strict";
import { runTwoBootValidation } from "../packages/security/src/two-boot-validation.js";

const firstOutput = [
  "NEXARA_GUEST_BOOT_OK",
  "NEXARA_DISK_WRITE_OK",
  "NEXARA_EGRESS_BLOCKED",
  "NEXARA_GUEST_VALIDATION_COMPLETE"
].join("\n");
const secondOutput = [
  "NEXARA_GUEST_BOOT_OK",
  "NEXARA_DISK_PERSISTENCE_PRESENT",
  "NEXARA_EGRESS_BLOCKED",
  "NEXARA_GUEST_VALIDATION_COMPLETE"
].join("\n");

function evidence(bootNumber, overrides = {}) {
  return {
    serialOutput: bootNumber === 1 ? firstOutput : secondOutput,
    diskId: "vm-disk-001",
    hostInstanceId: "host-" + bootNumber,
    nftDropCounterBefore: bootNumber * 10,
    nftDropCounterAfter: bootNumber * 10 + 2,
    ...overrides
  };
}

test("two-boot orchestrator reuses disk identity across reconstructed hosts", async () => {
  const calls = [];
  const result = await runTwoBootValidation({
    stateDirectory: "/var/lib/nexara",
    diskId: "vm-disk-001",
    bootOnce: async input => {
      calls.push(input);
      return evidence(input.bootNumber);
    }
  });
  assert.equal(result.passed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].diskId, calls[1].diskId);
  assert.deepEqual(result.hostInstances, ["host-1", "host-2"]);
});

test("two-boot orchestrator rejects missing persistence marker", async () => {
  await assert.rejects(() => runTwoBootValidation({
    stateDirectory: "/var/lib/nexara",
    diskId: "vm-disk-001",
    bootOnce: async input => evidence(input.bootNumber, {
      serialOutput: input.bootNumber === 2 ? secondOutput.replace("NEXARA_DISK_PERSISTENCE_PRESENT", "") : firstOutput
    })
  }), /missing required evidence marker/);
});

test("two-boot orchestrator rejects host reuse and non-increasing firewall counters", async t => {
  await t.test("same host instance", async () => {
    await assert.rejects(() => runTwoBootValidation({
      stateDirectory: "/var/lib/nexara", diskId: "vm-disk-001",
      bootOnce: async input => evidence(input.bootNumber, { hostInstanceId: "same-host" })
    }), /reused the first host instance/);
  });
  await t.test("counter did not increase", async () => {
    await assert.rejects(() => runTwoBootValidation({
      stateDirectory: "/var/lib/nexara", diskId: "vm-disk-001",
      bootOnce: async input => evidence(input.bootNumber, { nftDropCounterAfter: input.bootNumber * 10 })
    }), /increasing per-VM nftables drop counter/);
  });
});

test("two-boot orchestrator rejects disk identity changes", async () => {
  await assert.rejects(() => runTwoBootValidation({
    stateDirectory: "/var/lib/nexara", diskId: "vm-disk-001",
    bootOnce: async input => evidence(input.bootNumber, { diskId: input.bootNumber === 1 ? "disk-a" : "disk-b" })
  }), /changed persistent disk identity/);
});

test("two-boot orchestrator validates trusted inputs", async () => {
  await assert.rejects(() => runTwoBootValidation({
    stateDirectory: "relative/path", diskId: "vm-disk-001", bootOnce: async () => evidence(1)
  }), /requires a trusted boot adapter/);
});
