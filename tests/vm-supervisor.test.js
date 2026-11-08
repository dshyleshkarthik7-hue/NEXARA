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


test("supervisor enforces aggregate instance and resource quotas", async () => {
  let launches = 0;
  const supervisor = new VmSupervisor({
    authority,
    driver: { isolationType: "microvm", launch: async () => { launches++; return {}; }, stop: async () => {} },
    clock: () => 1010,
    limits: { maxInstances: 1, cpuMillis: 1000, memoryMiB: 512, diskMiB: 16 }
  });
  await supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest });
  await assert.rejects(() => supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest }), /aggregate resource limits/);
  assert.equal(launches, 1);
  await supervisor.close();
});

test("supervisor reaps expired leases and releases aggregate capacity", async () => {
  let now = 1010;
  let stops = 0;
  const supervisor = new VmSupervisor({
    authority,
    driver: { isolationType: "microvm", launch: async () => ({}), stop: async () => { stops++; } },
    clock: () => now,
    limits: { maxInstances: 1 }
  });
  const vm = await supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest });
  now = 1_000 + 15 * 60 * 1000;
  assert.deepEqual(await supervisor.reapExpired(), [vm.id]);
  assert.equal(stops, 1);
  assert.equal(supervisor.get(vm.id), null);
  await supervisor.create({ envelope: lease(now), subject: "tenant-1", imageDigest: digest });
  await supervisor.close();
});


test("supervisor blocks VM admission until durable recovery succeeds", async () => {
  let replayCalls = 0;
  let launches = 0;
  let fail = true;
  const recoveryJournal = {
    recoverPending: async resolver => {
      replayCalls++;
      assert.equal(typeof resolver, "function");
      if (fail) throw new Error("overlay not ready");
      return [{ vmId: "pending-vm" }];
    }
  };
  const supervisor = new VmSupervisor({
    authority,
    driver: { isolationType: "microvm", launch: async () => { launches++; return {}; }, stop: async () => {} },
    clock: () => 1010,
    recoveryJournal,
    resolveRecoveryDevice: async () => ({ importRaw: async () => ({}) })
  });
  await assert.rejects(() => supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest }), /recovery must complete/);
  assert.equal(launches, 0);
  await assert.rejects(() => supervisor.initialize(), /overlay not ready/);
  await assert.rejects(() => supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest }), /recovery must complete/);
  fail = false;
  assert.deepEqual(await supervisor.initialize(), [{ vmId: "pending-vm" }]);
  const vm = await supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest });
  assert.equal(vm.state, "running");
  assert.equal(launches, 1);
  assert.equal(replayCalls, 2);
  await supervisor.close();
});


test("supervisor releases persistent disk handles after stop and failed launch", async () => {
  const released = [];
  const disk = { sectors: 32, close: async () => {} };
  const supervisor = new VmSupervisor({
    authority,
    driver: {
      isolationType: "microvm",
      launch: async () => ({ id: "host-vm" }),
      stop: async () => {}
    },
    clock: () => 1010,
    rootDiskFactory: async () => disk,
    releaseRootDisk: async id => { released.push(id); }
  });
  const vm = await supervisor.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest });
  await supervisor.stop(vm.id);
  assert.deepEqual(released, [vm.id]);
  await supervisor.close();

  const failed = new VmSupervisor({
    authority,
    driver: {
      isolationType: "microvm",
      launch: async () => { throw new Error("jailer failed"); },
      stop: async () => {}
    },
    clock: () => 1010,
    rootDiskFactory: async () => disk,
    releaseRootDisk: async id => { released.push(id); }
  });
  await assert.rejects(() => failed.create({ envelope: lease(), subject: "tenant-1", imageDigest: digest }), /jailer failed/);
  assert.equal(released.length, 2);
  await failed.close();
});
