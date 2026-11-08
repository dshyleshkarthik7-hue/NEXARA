import test from "node:test";
import assert from "node:assert/strict";
import { executeLinuxKvmTwoBootValidation } from "../packages/security/src/linux-kvm-two-boot-adapter.js";

const firstLog = "NEXARA_GUEST_BOOT_OK\nNEXARA_DISK_WRITE_OK\nNEXARA_EGRESS_BLOCKED\nNEXARA_GUEST_VALIDATION_COMPLETE";
const secondLog = "NEXARA_GUEST_BOOT_OK\nNEXARA_DISK_PERSISTENCE_PRESENT\nNEXARA_EGRESS_BLOCKED\nNEXARA_GUEST_VALIDATION_COMPLETE";

test("Linux KVM adapter creates and closes fresh host stacks while resolving the same persistent disk", async () => {
  const hosts = [];
  const diskIds = [];
  const report = await executeLinuxKvmTwoBootValidation({
    stateDirectory: "/var/lib/nexara",
    diskId: "vm-disk-001",
    createHost: async options => {
      assert.equal(options.requireKvm, true);
      assert.equal(options.defaultDeny, true);
      const host = { id: "host-" + options.bootNumber, closed: false, close: async () => { host.closed = true; } };
      hosts.push(host);
      return host;
    },
    resolveDisk: async ({ diskId }) => {
      diskIds.push(diskId);
      return { id: diskId, device: { importRaw: async () => ({}) } };
    },
    readDropCounter: async ({ phase, bootNumber }) => bootNumber * 10 + (phase === "after" ? 2 : 0),
    bootGuest: async ({ bootNumber, disk }) => ({
      serialOutput: bootNumber === 1 ? firstLog : secondLog,
      diskId: disk.id,
      guestStopped: true,
      writebackComplete: true
    })
  });
  assert.equal(report.passed, true);
  assert.deepEqual(diskIds, ["vm-disk-001", "vm-disk-001"]);
  assert.deepEqual(hosts.map(host => host.closed), [true, true]);
  assert.deepEqual(report.hostInstances, ["host-1", "host-2"]);
});

test("Linux KVM adapter closes host when guest validation fails", async () => {
  let closed = false;
  await assert.rejects(() => executeLinuxKvmTwoBootValidation({
    stateDirectory: "/var/lib/nexara", diskId: "vm-disk-001",
    createHost: async () => ({ id: "host-1", close: async () => { closed = true; } }),
    resolveDisk: async ({ diskId }) => ({ id: diskId, device: { importRaw: async () => ({}) } }),
    readDropCounter: async () => 1,
    bootGuest: async () => { throw new Error("Firecracker launch failed"); }
  }), /Firecracker launch failed/);
  assert.equal(closed, true);
});

test("Linux KVM adapter rejects incomplete guest write-back evidence", async () => {
  await assert.rejects(() => executeLinuxKvmTwoBootValidation({
    stateDirectory: "/var/lib/nexara", diskId: "vm-disk-001",
    createHost: async () => ({ id: "host-1", close: async () => {} }),
    resolveDisk: async ({ diskId }) => ({ id: diskId, device: { importRaw: async () => ({}) } }),
    readDropCounter: async () => 2,
    bootGuest: async () => ({ serialOutput: firstLog, diskId: "vm-disk-001", guestStopped: true, writebackComplete: false })
  }), /did not confirm serial capture, disk write-back and clean shutdown/);
});
