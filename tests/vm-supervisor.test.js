import test from "node:test";
import assert from "node:assert/strict";
import { VmLeaseAuthority } from "../packages/security/src/lease.js";
import { VmSupervisor } from "../packages/security/src/vm-supervisor.js";

const authority = new VmLeaseAuthority("nexara-supervisor-test-secret-which-is-over-32-bytes");
const digest = `sha256:${"d".repeat(64)}`;
function lease(now = 1000) {
  return authority.issue({ subject: "tenant-1", imageDigest: digest,
    capabilities: ["storage-read"], egress: [], quotas: { diskMiB: 16 } }, { now });
}

test("supervisor refuses non-microVM drivers", () => {
  assert.throws(() => new VmSupervisor({ authority, driver: {
    isolationType: "container", launch: async () => ({}), stop: async () => {}
  } }), /microVM/);
});

test("supervisor verifies lease binding before launching and passes deny-by-default policy", async () => {
  let config;
  const driver = { isolationType: "microvm", launch: async value => { config = value; return { pid: 7 }; }, stop: async () => {} };
  const supervisor = new VmSupervisor({ authority, driver, clock: () => 1010 });
  const record = await supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest });
  assert.equal(record.state, "running");
  assert.equal(config.network.defaultDeny, true);
  assert.deepEqual(config.devices, ["storage-read"]);
  assert.deepEqual(config.quotas, { cpuMillis: 1000, memoryMiB: 512, diskMiB: 16 });
  await supervisor.close();
  assert.equal(supervisor.list().length, 0);
});

test("supervisor never launches for a mismatched tenant or image", async () => {
  let launches = 0;
  const supervisor = new VmSupervisor({ authority, driver: {
    isolationType: "microvm", launch: async () => { launches++; return {}; }, stop: async () => {}
  }, clock: () => 1010 });
  await assert.rejects(() => supervisor.create({ envelope: lease(), subject: "tenant-2", imageDigest: digest }), /subject mismatch/);
  await assert.rejects(() => supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: `sha256:${"e".repeat(64)}` }), /image digest mismatch/);
  assert.equal(launches, 0);
});

test("supervisor removes failed launches and supports explicit stop", async () => {
  let stops = 0;
  const supervisor = new VmSupervisor({ authority, driver: {
    isolationType: "microvm", launch: async () => ({ id: "vm" }), stop: async () => { stops++; }
  }, clock: () => 1010 });
  const vm = await supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest });
  assert.equal(await supervisor.stop(vm.id), true);
  assert.equal(await supervisor.stop(vm.id), false);
  assert.equal(stops, 1);
  assert.equal(supervisor.get(vm.id), null);
});

test("supervisor refuses new VMs after shutdown", async () => {
  const supervisor = new VmSupervisor({ authority, driver: {
    isolationType: "microvm", launch: async () => ({}), stop: async () => {}
  }, clock: () => 1010 });
  await supervisor.close();
  await assert.rejects(() => supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest }), /closed/);
});
