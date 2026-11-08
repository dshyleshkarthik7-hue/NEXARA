import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { FirecrackerDriver } from "../packages/security/src/firecracker-driver.js";

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
  const host = { socketPath, jailRoot, token: "host-token" };
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
  return { directory, kernel, rootfs, socketPath, requests, provider, resolveImage, get stopped() { return stopped; } };
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
    "/machine-config", "/boot-source", "/drives/rootfs", "/actions"
  ]);
  assert.equal(f.requests[0].body.vcpu_count, 2);
  assert.equal(f.requests[0].body.mem_size_mib, 512);
  assert.equal(f.requests[1].body.kernel_image_path, "/nexara/vmlinux");
  assert.equal(f.requests[2].body.path_on_host, "/nexara/rootfs.ext4");
  assert.equal((await readFile(path.join(f.jailRoot, "nexara", "vmlinux"))).toString(), "test-kernel-image");
  assert.equal((await readFile(path.join(f.jailRoot, "nexara", "rootfs.ext4"))).toString(), "test-rootfs-image");
  assert.equal(f.requests[3].body.action_type, "InstanceStart");
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
    return { socketPath: f.socketPath + ".bad", jailRoot: f.jailRoot, stop: async () => {} };
  };
  const driver = new FirecrackerDriver({ provider: f.provider, resolveImage: f.resolveImage });
  await assert.rejects(() => driver.launch(config), /API request failed/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.requests.length, 0);
});
