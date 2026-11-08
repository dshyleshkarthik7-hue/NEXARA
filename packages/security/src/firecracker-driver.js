import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, copyFile, chmod, chown, unlink } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
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
  #recoveryJournal;

  constructor({ provider, resolveImage, recoveryJournal = null, timeoutMs = 5000 } = {}) {
    if (!provider || typeof provider.start !== "function" || typeof provider.stop !== "function"
      || typeof resolveImage !== "function" || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 100 || timeoutMs > 60000) {
      throw new TypeError("Firecracker driver requires a jailed host provider, image resolver and bounded timeout");
    }
    this.#provider = provider;
    this.#resolveImage = resolveImage;
    if (recoveryJournal !== null && typeof recoveryJournal.save !== "function") throw new TypeError("Invalid durable recovery journal");
    this.#timeoutMs = timeoutMs;
    this.#recoveryJournal = recoveryJournal;
  }

  async launch(config) {
    if (!config || typeof config.id !== "string" || !/^[-a-f0-9]{36}$/i.test(config.id)
      || !config.quotas || !Number.isInteger(config.quotas.cpuMillis)
      || !Number.isInteger(config.quotas.memoryMiB) || !Number.isInteger(config.quotas.diskMiB)
      || config.network?.defaultDeny !== true) {
      throw new TypeError("Invalid microVM launch configuration");
    }
    if (config.rootfsDevice !== undefined) {
      const disk = config.rootfsDevice;
      if (!disk || typeof disk.materializeRaw !== "function" || typeof disk.importRaw !== "function" || !Number.isSafeInteger(disk.sectors)
        || disk.sectors < 1 || !Number.isSafeInteger(config.quotas.diskMiB)
        || disk.sectors * 512 > config.quotas.diskMiB * 1024 * 1024) {
        throw new TypeError("Invalid broker-managed root disk or disk quota");
      }
    }
    const manifest = await this.#resolveImage(config.imageDigest);
    if (!manifest || manifest.digest !== config.imageDigest
      || typeof manifest.kernelPath !== "string" || !path.isAbsolute(manifest.kernelPath)
      || typeof manifest.rootfsPath !== "string" || !path.isAbsolute(manifest.rootfsPath)
      || typeof manifest.kernelDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(manifest.kernelDigest)
      || typeof manifest.rootfsDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(manifest.rootfsDigest)
      || ((manifest.initrdPath !== undefined || manifest.initrdDigest !== undefined)
        && (typeof manifest.initrdPath !== "string" || !path.isAbsolute(manifest.initrdPath)
          || typeof manifest.initrdDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(manifest.initrdDigest)))) {
      throw new Error("Trusted image manifest is missing or does not match the leased image digest");
    }
    await verifyFileDigest(manifest.kernelPath, manifest.kernelDigest);
    const rootfsBytes = await verifyFileDigest(manifest.rootfsPath, manifest.rootfsDigest);
    if (manifest.initrdPath) await verifyFileDigest(manifest.initrdPath, manifest.initrdDigest);
    if (rootfsBytes > config.quotas.diskMiB * 1024 * 1024) {
      throw new Error("Guest root filesystem exceeds the leased disk quota");
    }

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
      ) {
      await Promise.resolve().then(() => this.#provider.stop(host)).catch(() => {});
      throw new Error("Host provider did not return a private Firecracker API socket and stop handle");
    }

    const handle = { host, started: false, id: config.id, rootfsDevice: config.rootfsDevice ?? null };
    try {
      await waitForApi(host.socketPath, this.#timeoutMs);
      if (typeof host.jailRoot !== "string" || !path.isAbsolute(host.jailRoot)
        || !Number.isSafeInteger(host.uid) || !Number.isSafeInteger(host.gid)) {
        throw new Error("Host provider did not expose the Firecracker jail root for image staging");
      }
      const rootStat = await lstat(host.jailRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Firecracker jail root is not a trusted directory");
      const artifactDir = path.join(host.jailRoot, "nexara");
      await mkdir(artifactDir, { mode: 0o755 });
      const kernelTarget = path.join(artifactDir, "vmlinux");
      const rootfsTarget = path.join(artifactDir, "rootfs.ext4");
      const initrdTarget = manifest.initrdPath ? path.join(artifactDir, "initramfs.cpio.gz") : null;
      await copyFile(manifest.kernelPath, kernelTarget);
      if (initrdTarget) await copyFile(manifest.initrdPath, initrdTarget);
      if (config.rootfsDevice !== undefined) {
        const disk = config.rootfsDevice;
        const materialized = await disk.materializeRaw(rootfsTarget);
        if (!materialized || materialized.path !== rootfsTarget || materialized.format !== "raw"
          || materialized.byteLength !== disk.sectors * 512) {
          throw new Error("Copy-on-write root disk did not produce a valid raw image");
        }
        handle.materializedRootfs = rootfsTarget;
      } else {
        await copyFile(manifest.rootfsPath, rootfsTarget);
      }
      await chmod(kernelTarget, 0o444);
      if (initrdTarget) { await chmod(initrdTarget, 0o444); await chown(initrdTarget, host.uid, host.gid); }
      await chmod(rootfsTarget, config.rootfsDevice !== undefined ? 0o660 : (manifest.readOnlyRootfs === true ? 0o444 : 0o660));
      await chown(rootfsTarget, host.uid, host.gid);
      await apiRequest(host.socketPath, "PUT", "/machine-config", {
        vcpu_count: Math.max(1, Math.ceil(config.quotas.cpuMillis / 1000)),
        mem_size_mib: config.quotas.memoryMiB,
        track_dirty_pages: true
      }, this.#timeoutMs);
      await apiRequest(host.socketPath, "PUT", "/boot-source", {
        kernel_image_path: "/nexara/vmlinux",
        boot_args: typeof manifest.bootArgs === "string" ? manifest.bootArgs : (initrdTarget ? "console=ttyS0 rdinit=/init reboot=k panic=1" : "console=ttyS0 reboot=k panic=1"),
        ...(initrdTarget ? { initrd_path: "/nexara/initramfs.cpio.gz" } : {})
      }, this.#timeoutMs);
      await apiRequest(host.socketPath, "PUT", "/drives/rootfs", {
        drive_id: "rootfs",
        path_on_host: "/nexara/rootfs.ext4",
        is_root_device: true,
        is_read_only: config.rootfsDevice === undefined && manifest.readOnlyRootfs === true
      }, this.#timeoutMs);
      const tapName = host.network?.tapName ?? manifest.networkInterface?.hostDevName;
      if (tapName !== undefined) {
        if (typeof tapName !== "string" || !/^[a-zA-Z0-9_.-]{1,15}$/.test(tapName)) {
          throw new Error("Invalid pre-provisioned TAP interface name");
        }
        await apiRequest(host.socketPath, "PUT", "/network-interfaces/eth0", {
          iface_id: "eth0",
          host_dev_name: tapName,
          guest_mac: manifest.networkInterface?.guestMac ?? "06:00:ac:10:00:02"
        }, this.#timeoutMs);
      }
      await apiRequest(host.socketPath, "PUT", "/actions", { action_type: "InstanceStart" }, this.#timeoutMs);
      handle.started = true;
      return handle;
    } catch (error) {
      await Promise.resolve().then(() => this.#provider.stop(host)).catch(() => {});
      // The guest has not been admitted as running; this materialized image is
      // only a launch-time copy and contains no guest writes to preserve.
      if (handle.materializedRootfs) await unlink(handle.materializedRootfs).catch(() => {});
      throw error;
    }
  }

  async stop(handle) {
    if (!handle || !handle.host) throw new TypeError("Invalid Firecracker instance handle");
    if (handle.stopped) {
      if (handle.writebackPending) return this.retryWriteback(handle);
      return;
    }
    try {
      if (handle.started) {
        await apiRequest(handle.host.socketPath, "PUT", "/actions", {
          action_type: "SendCtrlAltDel"
        }, this.#timeoutMs).catch(() => {});
      }
    } finally {
      handle.started = false;
      handle.writebackPending = Boolean(handle.materializedRootfs && handle.rootfsDevice);
      await this.#provider.stop(handle.host);
      handle.stopped = true;
      if (handle.materializedRootfs && handle.rootfsDevice) {
        await chmod(handle.materializedRootfs, 0o600);
        try {
          await handle.rootfsDevice.importRaw(handle.materializedRootfs);
          handle.writebackPending = false;
        } catch (writebackError) {
          // Queue a durable copy before removing the jail-local recovery image.
          if (!this.#recoveryJournal) {
            handle.writebackPending = true;
            throw writebackError;
          }
          try {
            handle.recoveryRecord = await this.#recoveryJournal.save({
              vmId: handle.id, sourcePath: handle.materializedRootfs
            });
            handle.recoveryQueued = true;
          } catch (journalError) {
            handle.writebackPending = true;
            throw new AggregateError([writebackError, journalError], "Guest write-back and durable recovery journaling both failed");
          }
        }
      }
      if (handle.materializedRootfs && handle.recoveryQueued) {
        await unlink(handle.materializedRootfs);
        handle.writebackPending = false;
      } else if (handle.materializedRootfs && !handle.writebackPending) {
        await unlink(handle.materializedRootfs).catch(() => {});
      }
    }
  }

  /** Retry persistence after a previous shutdown left a recoverable raw disk behind. */
  async retryWriteback(handle) {
    if (!handle || !handle.stopped || !handle.writebackPending
      || !handle.materializedRootfs || !handle.rootfsDevice
      || typeof handle.rootfsDevice.importRaw !== "function") {
      throw new TypeError("No recoverable guest disk write-back is pending");
    }
    await chmod(handle.materializedRootfs, 0o600);
    const result = await handle.rootfsDevice.importRaw(handle.materializedRootfs);
    await unlink(handle.materializedRootfs);
    handle.writebackPending = false;
    return result;
  }

}

async function verifyFileDigest(filePath, expected) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Guest image artifacts must be regular files");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if ("sha256:" + hash.digest("hex") !== expected) throw new Error("Guest image artifact digest mismatch");
  return stat.size;
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
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
        socket.setTimeout(Math.min(500, timeoutMs), () => socket.destroy(new Error("Socket connect timed out")));
      });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error("Firecracker API socket did not become ready before timeout");
}
