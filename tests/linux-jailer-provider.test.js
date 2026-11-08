import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LinuxJailerProvider } from "../packages/security/src/linux-jailer-provider.js";

test("Linux jailer provider builds a fail-closed Firecracker jailer command", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-jailer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jailer = path.join(directory, "jailer");
  const firecracker = path.join(directory, "firecracker");
  for (const file of [jailer, firecracker]) await writeFile(file, "test");
  await chmod(jailer, 0o755);
  await chmod(firecracker, 0o755);

  let invoked;
  let released = 0;
  const networkProvider = {
    provision: async () => ({ netnsPath: "/run/netns/nexara-test", tapName: "taptest", release: async () => { released++; } }),
    release: async handle => handle.release()
  };
  const spawn = (command, args, options) => {
    invoked = { command, args, options };
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = signal => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", 0, signal));
      return true;
    };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const provider = new LinuxJailerProvider({
    jailerPath: jailer, firecrackerPath: firecracker,
    chrootBaseDir: "/j",
    uid: 10001, gid: 10001, networkProvider, spawn
  });
  const host = await provider.start({
    id: "12345678-1234-4234-8234-123456789abc",
    quotas: { cpuMillis: 1500, memoryMiB: 768, diskMiB: 2048 },
    network: { defaultDeny: true, egress: [] },
    requireJailer: true, requireCgroups: true, requireNamespaces: true,
    requireSeccomp: true, requirePrivateApiSocket: true
  });
  assert.equal(invoked.command, jailer);
  assert.equal(invoked.options.shell, false);
  assert.equal(invoked.args.includes("--new-pid-ns"), true);
  assert.ok(invoked.args.includes("--netns"));
  assert.ok(invoked.args.includes("/run/netns/nexara-test"));
  assert.ok(invoked.args.includes("cpu.max=150000 100000"));
  assert.ok(invoked.args.includes("memory.max=805306368"));
  assert.equal(host.socketPath, path.join("/j", "firecracker",
    "12345678-1234-4234-8234-123456789abc", "root", "firecracker.socket"));
  assert.equal(host.jailRoot, path.dirname(host.socketPath));
  await provider.stop(host);
  assert.equal(host.child.signalCode, "SIGTERM");
  assert.equal(released, 1);
  await provider.stop(host);
});

test("Linux jailer provider rejects unsafe configuration and writable binaries", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-jailer-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jailer = path.join(directory, "jailer");
  const firecracker = path.join(directory, "firecracker");
  for (const file of [jailer, firecracker]) await writeFile(file, "test");
  await chmod(jailer, 0o777);
  await chmod(firecracker, 0o755);
  const provider = new LinuxJailerProvider({
    jailerPath: jailer, firecrackerPath: firecracker,
    chrootBaseDir: path.join(directory, "jails"),
    uid: 10001, gid: 10001,
    networkProvider: { provision: async () => { throw new Error("must not provision"); }, release: async () => {} },
    spawn: () => { throw new Error("must not spawn"); }
  });
  await assert.rejects(() => provider.start({
    id: "12345678-1234-4234-8234-123456789abc",
    quotas: { cpuMillis: 1000, memoryMiB: 512 },
    network: { defaultDeny: true },
    requireJailer: true, requireCgroups: true, requireNamespaces: true,
    requireSeccomp: true, requirePrivateApiSocket: true
  }), /not writable by group or others/);
});
