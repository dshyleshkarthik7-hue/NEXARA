import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

/**
 * Firecracker API adapter for a host-provisioned, already-jailed process.
 *
 * The host provider is responsible for starting Firecracker through the
 * Firecracker jailer (or an equivalent hardened launcher), applying cgroups,
 * namespaces, seccomp, TAP/network policy and a private API socket. This class
 * configures the guest through that socket; it does not claim to create those
 * host security boundaries itself.
 */
export class FirecrackerDriver {
  isolationType = "microvm";
  #provider;
  #resolveImage;
  #timeoutMs;

  constructor({ provider, resolveImage, timeoutMs = 5000 } = {}) {
    if (!provider || typeof provider.start !== "function" || typeof provider.stop !== "function"
      || typeof resolveImage !== "function" || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 100 || timeoutMs > 60000) {
      throw new TypeError("Firecracker driver requires a jailed host provider, image resolver and bounded timeout");
    }
    this.#provider = provider;
    this.#resolveImage = resolveImage;
    this.#timeoutMs = timeoutMs;
  }

  async launch(config) {
    if (!config || typeof config.id !== "string" || !/^[-a-f0-9]{36}$/i.test(config.id)
      || !config.quotas || !Number.isInteger(config.quotas.cpuMillis)
      || !Number.isInteger(config.quotas.memoryMiB) || !Number.isInteger(config.quotas.diskMiB)
      || config.network?.defaultDeny !== true) {
      throw new TypeError("Invalid microVM launch configuration");
    }
    const manifest = await this.#resolveImage(config.imageDigest);
    if (!manifest || manifest.digest !== config.imageDigest
      || typeof manifest.kernelPath !== "string" || !path.isAbsolute(manifest.kernelPath)
      || typeof manifest.rootfsPath !== "string" || !path.isAbsolute(manifest.rootfsPath)
      || typeof manifest.kernelDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(manifest.kernelDigest)
      || typeof manifest.rootfsDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(manifest.rootfsDigest)) {
      throw new Error("Trusted image manifest is missing or does not match the leased image digest");
    }
    await verifyFileDigest(manifest.kernelPath, manifest.kernelDigest);
    await verifyFileDigest(manifest.rootfsPath, manifest.rootfsDigest);

    const host = await this.#provider.start(Object.freeze({
      id: config.id,
      quotas: config.quotas,
      network: config.network,
      devices: config.devices,
      requireJailer: true,
      requireCgroups: true,
      requireNamespaces: true,
      requireSeccomp: true,
      requirePrivateApiSocket: true
    }));
    if (!host || typeof host.socketPath !== "string" || !path.isAbsolute(host.socketPath)
      || typeof host.stop !== "function") {
      await this.#provider.stop(host).catch(() => {});
      throw new Error("Host provider did not return a private Firecracker API socket and stop handle");
    }

    const handle = { host, started: false, id: config.id };
    try {
      await waitForApi(host.socketPath, this.#timeoutMs);
      await apiRequest(host.socketPath, "PUT", "/machine-config", {
        vcpu_count: Math.max(1, Math.ceil(config.quotas.cpuMillis / 1000)),
        mem_size_mib: config.quotas.memoryMiB,
        track_dirty_pages: true
      }, this.#timeoutMs);
      await apiRequest(host.socketPath, "PUT", "/boot-source", {
        kernel_image_path: manifest.kernelPath,
        boot_args: typeof manifest.bootArgs === "string" ? manifest.bootArgs : "console=ttyS0 reboot=k panic=1"
      }, this.#timeoutMs);
      await apiRequest(host.socketPath, "PUT", "/drives/rootfs", {
        drive_id: "rootfs",
        path_on_host: manifest.rootfsPath,
        is_root_device: true,
        is_read_only: manifest.readOnlyRootfs === true
      }, this.#timeoutMs);
      if (manifest.networkInterface) {
        if (typeof manifest.networkInterface.hostDevName !== "string"
          || !/^[a-zA-Z0-9_.-]{1,15}$/.test(manifest.networkInterface.hostDevName)) {
          throw new Error("Invalid pre-provisioned TAP interface name");
        }
        await apiRequest(host.socketPath, "PUT", "/network-interfaces/eth0", {
          iface_id: "eth0",
          host_dev_name: manifest.networkInterface.hostDevName,
          guest_mac: manifest.networkInterface.guestMac ?? "06:00:ac:10:00:02"
        }, this.#timeoutMs);
      }
      await apiRequest(host.socketPath, "PUT", "/actions", { action_type: "InstanceStart" }, this.#timeoutMs);
      handle.started = true;
      return handle;
    } catch (error) {
      await this.#provider.stop(host).catch(() => {});
      throw error;
    }
  }

  async stop(handle) {
    if (!handle || !handle.host) throw new TypeError("Invalid Firecracker instance handle");
    try {
      if (handle.started) {
        await apiRequest(handle.host.socketPath, "PUT", "/actions", {
          action_type: "SendCtrlAltDel"
        }, this.#timeoutMs).catch(() => {});
      }
    } finally {
      await this.#provider.stop(handle.host);
      handle.started = false;
    }
  }
}

async function verifyFileDigest(filePath, expected) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Guest image artifacts must be regular files");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if ("sha256:" + hash.digest("hex") !== expected) throw new Error("Guest image artifact digest mismatch");
}

function apiRequest(socketPath, method, endpoint, body, timeoutMs) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath, path: endpoint, method,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      timeout: timeoutMs
    }, response => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { data += chunk; if (data.length > 65536) request.destroy(new Error("Firecracker API response too large")); });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error("Firecracker API request failed: " + response.statusCode + " " + data.slice(0, 512)));
        } else resolve(data ? JSON.parse(data) : {});
      });
    });
    request.on("timeout", () => request.destroy(new Error("Firecracker API request timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

async function waitForApi(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await apiRequest(socketPath, "GET", "/", {}, Math.min(500, timeoutMs));
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error("Firecracker API socket did not become ready: " + (lastError?.message ?? "timeout"));
}
