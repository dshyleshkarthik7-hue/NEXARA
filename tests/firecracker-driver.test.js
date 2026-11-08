import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { FirecrackerDriver } from "../packages/security/src/firecracker-driver.js";
import { DurableRecoveryJournal } from "../packages/security/src/durable-recovery-journal.js";

const digest = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-fc-"));
  const kernel = path.join(directory, "vmlinux");
  const rootfs = path.join(directory, "rootfs.ext4");
  const kernelBytes = Buffer.from("test-kernel-image");
  const rootfsBytes = Buffer.from("test-rootfs-image");
  await writeFile(kernel, kernelBytes);
  await writeFile(rootfs, rootfsBytes);
  const jailRoot = path.join(directory, "jail-root");
  await mkdir(jailRoot);
  const socketPath = path.join(jailRoot, "firecracker.socket");
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, error => error ? reject(error) : resolve()));
  const host = { socketPath, jailRoot, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, network: { tapName: "tap12345678" }, token: "host-token" };
  let stopped = 0;
  const provider = {
    start: async options => { assert.equal(options.requireJailer, true); assert.equal(options.requireCgroups, true); return host; },
    stop: async value => { assert.equal(value, host); stopped++; await new Promise(resolve => server.close(resolve)); }
  };
  const resolveImage = async imageDigest => ({
    digest: imageDigest, kernelPath: kernel, rootfsPath: rootfs,
    kernelDigest: digest(kernelBytes), rootfsDigest: digest(rootfsBytes)
  });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, kernel, rootfs, jailRoot, socketPath, requests, provider, resolveImage, get stopped() { return stopped; } };
}

const config = {
  id: "12345678-1234-4234-8234-123456789abc",
  imageDigest: "sha256:" + "a".repeat(64),
  quotas: { cpuMillis: 2000, memoryMiB: 512, diskMiB: 1024 },
  network: { defaultDeny: true, egress: [] },
  devices: ["storage-read"]
};

test("Firecracker driver verifies artifacts and configures machine before starting", async t => {
  const f = await fixture(t);
  const driver = new FirecrackerDriver({ provider: f.provider, resolveImage: f.resolveImage });
  const handle = await driver.launch(config);
  assert.equal(handle.started, true);
  assert.deepEqual(f.requests.map(x => x.url), [
    "/machine-config", "/boot-source", "/drives/rootfs", "/network-interfaces/eth0", "/actions"
  ]);
  assert.equal(f.requests[0].body.vcpu_count, 2);
  assert.equal(f.requests[0].body.mem_size_mib, 512);
  assert.equal(f.requests[1].body.kernel_image_path, "/nexara/vmlinux");
  assert.equal(f.requests[2].body.path_on_host, "/nexara/rootfs.ext4");
  assert.equal((await readFile(path.join(f.jailRoot, "nexara", "vmlinux"))).toString(), "test-kernel-image");
  assert.equal((await readFile(path.join(f.jailRoot, "nexara", "rootfs.ext4"))).toString(), "test-rootfs-image");
  assert.equal(f.requests[3].body.host_dev_name, "tap12345678");
  assert.equal(f.requests[4].body.action_type, "InstanceStart");
  await driver.stop(handle);
  assert.equal(f.stopped, 1);
});

test("Firecracker driver rejects digest mismatch before starting host process", async t => {
  const f = await fixture(t);
  let starts = 0;
  const driver = new FirecrackerDriver({
    provider: { start: async () => { starts++; }, stop: async () => {} },
    resolveImage: async imageDigest => ({
      digest: imageDigest, kernelPath: f.kernel, rootfsPath: f.rootfs,
      kernelDigest: "sha256:" + "0".repeat(64), rootfsDigest: "sha256:" + "1".repeat(64)
    })
  });
  await assert.rejects(() => driver.launch(config), /digest mismatch/);
  assert.equal(starts, 0);
});
test("Firecracker driver tears down jailed worker when API configuration fails", async t => {
  const f = await fixture(t);
  const original = f.provider.start;
  f.provider.start = async options => {
    const host = await original(options);
    const server = http.createServer((req, res) => { res.writeHead(500); res.end("rejected"); });
    await new Promise(resolve => server.listen(f.socketPath + ".bad", resolve));
    // The provider returns a socket that accepts connections but rejects configuration.
    f.provider.stop = async () => {
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => f.provider._close?.(resolve) ?? resolve());
    };
    return { socketPath: f.socketPath + ".bad", jailRoot: f.jailRoot, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, stop: async () => {} };
  };
  const driver = new FirecrackerDriver({ provider: f.provider, resolveImage: f.resolveImage });
  await assert.rejects(() => driver.launch(config), /API request failed/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.requests.length, 0);
});

test("Firecracker driver rejects a root disk larger than the signed disk quota", async t => {
  const f = await fixture(t);
  const oversized = Buffer.alloc(1024 * 1024 + 1, 0x5a);
  await writeFile(f.rootfs, oversized);
  let starts = 0;
  const driver = new FirecrackerDriver({
    provider: { start: async () => { starts++; }, stop: async () => {} },
    resolveImage: async imageDigest => ({
      digest: imageDigest, kernelPath: f.kernel, rootfsPath: f.rootfs,
      kernelDigest: digest(Buffer.from("test-kernel-image")),
      rootfsDigest: digest(oversized)
    })
  });
  await assert.rejects(() => driver.launch({
    ...config, quotas: { ...config.quotas, diskMiB: 1 }
  }), /exceeds the leased disk quota/);
  assert.equal(starts, 0);
});


test("Firecracker driver attaches a broker-managed copy-on-write disk as raw rootfs", async t => {
  const f = await fixture(t);
  const calls = [];
  let imported = null;
  const rootfsDevice = {
    sectors: 2048,
    materializeRaw: async target => {
      calls.push(target);
      await writeFile(target, Buffer.alloc(2048 * 512, 0x5a), { flag: "wx", mode: 0o600 });
      return { path: target, sectors: 2048, byteLength: 2048 * 512, format: "raw" };
    },
    importRaw: async source => { imported = source; return { changedSectors: 1 }; }
  };
  const driver = new FirecrackerDriver({ provider: f.provider, resolveImage: async imageDigest => ({ ...(await f.resolveImage(imageDigest)), readOnlyRootfs: true }) });
  const handle = await driver.launch({ ...config, rootfsDevice });
  const staged = path.join(f.jailRoot, "nexara", "rootfs.ext4");
  assert.deepEqual(calls, [staged]);
  assert.equal((await readFile(staged)).length, 2048 * 512);
  assert.equal(f.requests.find(x => x.url === "/drives/rootfs").body.path_on_host, "/nexara/rootfs.ext4");
  assert.equal(f.requests.find(x => x.url === "/drives/rootfs").body.is_read_only, false, "COW-backed root disks must accept guest writes");
  assert.equal((await stat(staged)).mode & 0o777, 0o660, "jailer-owned COW image must be writable by the guest process");
  await driver.stop(handle);
  assert.equal(imported, staged, "stopped guest disk must be imported into persistent COW storage");
  await assert.rejects(() => readFile(staged), { code: "ENOENT" });
});

test("Firecracker driver rejects broker root disks exceeding lease quota", async t => {
  const f = await fixture(t);
  let starts = 0;
  const driver = new FirecrackerDriver({ provider: { start: async () => { starts++; return {}; }, stop: async () => {} }, resolveImage: f.resolveImage });
  await assert.rejects(() => driver.launch({ ...config, quotas: { ...config.quotas, diskMiB: 1 }, rootfsDevice: { sectors: 4097, materializeRaw: async () => ({}) } }), /Invalid broker-managed root disk/);
  assert.equal(starts, 0);
});


test("Firecracker preserves staged guest disk when COW write-back fails", async t => {
  const f = await fixture(t);
  let failImport = true;
  const rootfsDevice = {
    sectors: 2048,
    materializeRaw: async target => {
      await writeFile(target, Buffer.alloc(2048 * 512, 0x5a), { flag: "wx", mode: 0o600 });
      return { path: target, sectors: 2048, byteLength: 2048 * 512, format: "raw" };
    },
    importRaw: async () => { if (failImport) throw new Error("overlay unavailable"); return { changedSectors: 3 }; }
  };
  const driver = new FirecrackerDriver({ provider: f.provider, resolveImage: f.resolveImage });
  const handle = await driver.launch({ ...config, rootfsDevice });
  const staged = path.join(f.jailRoot, "nexara", "rootfs.ext4");
  await assert.rejects(() => driver.stop(handle), /overlay unavailable/);
  assert.equal(handle.writebackPending, true);
  assert.equal((await readFile(staged)).length, 2048 * 512, "guest changes must remain recoverable");
  failImport = false;
  const result = await driver.retryWriteback(handle);
  assert.equal(result.changedSectors, 3);
  assert.equal(handle.writebackPending, false);
  await assert.rejects(() => readFile(staged), { code: "ENOENT" });
});


test("Firecracker shutdown journals failed write-back outside the jail", async t => {
  const f = await fixture(t);
  const journal = new DurableRecoveryJournal({ directory: path.join(f.directory, "host-recovery") });
  const rootfsDevice = {
    sectors: 2048,
    materializeRaw: async target => {
      await writeFile(target, Buffer.alloc(2048 * 512, 0x5a), { flag: "wx", mode: 0o600 });
      return { path: target, sectors: 2048, byteLength: 2048 * 512, format: "raw" };
    },
    importRaw: async () => { throw new Error("overlay unavailable"); }
  };
  const driver = new FirecrackerDriver({ provider: f.provider, resolveImage: f.resolveImage, recoveryJournal: journal });
  const handle = await driver.launch({ ...config, rootfsDevice });
  const staged = path.join(f.jailRoot, "nexara", "rootfs.ext4");
  await driver.stop(handle);
  assert.equal(handle.recoveryQueued, true);
  assert.equal(handle.writebackPending, false);
  assert.equal((await journal.list()).length, 1);
  await assert.rejects(() => readFile(staged), { code: "ENOENT" });
});

test("Firecracker driver verifies, stages and configures a digest-pinned initramfs", async t => {
  const f = await fixture(t);
  const initrdPath = path.join(f.directory, "initramfs.cpio.gz");
  const initrdBytes = Buffer.from("test-initramfs");
  await writeFile(initrdPath, initrdBytes);
  const driver = new FirecrackerDriver({
    provider: f.provider,
    resolveImage: async imageDigest => ({ ...(await f.resolveImage(imageDigest)), initrdPath, initrdDigest: digest(initrdBytes) })
  });
  await driver.launch(config);
  const boot = f.requests.find(x => x.url === "/boot-source").body;
  assert.equal(boot.initrd_path, "/nexara/initramfs.cpio.gz");
  assert.match(boot.boot_args, /rdinit=\\/init/);
  assert.equal((await readFile(path.join(f.jailRoot, "nexara", "initramfs.cpio.gz"))).toString(), "test-initramfs");
});

test("Firecracker driver rejects an initramfs digest mismatch before starting host", async t => {
  const f = await fixture(t);
  let starts = 0;
  const driver = new FirecrackerDriver({
    provider: { start: async () => { starts++; }, stop: async () => {} },
    resolveImage: async imageDigest => ({ ...(await f.resolveImage(imageDigest)), initrdPath: f.rootfs, initrdDigest: "sha256:" + "0".repeat(64) })
  });
  await assert.rejects(() => driver.launch(config), /digest mismatch/);
  assert.equal(starts, 0);
});
