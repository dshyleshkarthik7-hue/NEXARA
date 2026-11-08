import { randomUUID, createHash } from "node:crypto";
import { mkdir, lstat, open, readFile, unlink, link } from "node:fs/promises";
import path from "node:path";
import { CopyOnWriteBlockDevice } from "../../runtime/src/copy-on-write-block-device.js";

/**
 * Host-owned persistent mapping from VM identity to its COW overlay geometry
 * and immutable base digest. The base-device resolver is trusted host code;
 * no path or device object is accepted from journal metadata or a guest.
 */
export class PersistentVmRegistry {
  #directory;
  #overlayDirectory;
  #resolveBaseDevice;
  #ready;
  #opened = new Map();

  constructor({ directory, overlayDirectory, resolveBaseDevice } = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)
      || typeof overlayDirectory !== "string" || !path.isAbsolute(overlayDirectory)
      || typeof resolveBaseDevice !== "function") {
      throw new TypeError("Persistent VM registry requires absolute storage roots and a trusted base-device resolver");
    }
    this.#directory = path.resolve(directory);
    this.#overlayDirectory = path.resolve(overlayDirectory);
    this.#resolveBaseDevice = resolveBaseDevice;
    this.#ready = this.#initialize();
  }

  async #initialize() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await mkdir(this.#overlayDirectory, { recursive: true, mode: 0o700 });
    for (const directory of [this.#directory, this.#overlayDirectory]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error("VM registry and overlay roots must be private non-symlink directories");
      }
    }
  }

  /** Stable host-generated UUID bound to a trusted workload key, tenant and image. */
  async getOrCreateIdentity({ workloadKey, subject, imageDigest } = {}) {
    await this.#ready;
    if (typeof workloadKey !== "string" || workloadKey.length < 1 || workloadKey.length > 256
      || typeof subject !== "string" || !subject || subject.length > 256
      || typeof imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
      throw new TypeError("Stable VM identity requires trusted workload key, subject and image digest");
    }
    const keyHash = createHash("sha256").update(workloadKey).digest("hex");
    const target = path.join(this.#directory, "identity-" + keyHash + ".json");
    let record;
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
        throw new Error("Unsafe stable VM identity record");
      }
      record = JSON.parse(await readFile(target, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (record) {
      if (record.version !== 1 || record.keyHash !== keyHash || record.subject !== subject
        || record.imageDigest !== imageDigest || !/^[-a-f0-9]{36}$/i.test(record.vmId)) {
        throw new Error("Workload identity is already bound to another tenant or image");
      }
      return record.vmId;
    }
    const next = { version: 1, keyHash, subject, imageDigest, vmId: randomUUID() };
    const temp = path.join(this.#directory, randomUUID() + ".identity.tmp");
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(next) + "\n"); await file.sync(); }
    finally { await file.close(); }
    try {
      await link(temp, target);
      await unlink(temp);
      const dir = await open(this.#directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
      return next.vmId;
    } catch (error) {
      await unlink(temp).catch(() => {});
      if (error.code === "EEXIST") return this.getOrCreateIdentity({ workloadKey, subject, imageDigest });
      throw error;
    }
  }

  /** Reopen a registered overlay or create it exactly once for this stable UUID. */
  async openOrCreate({ vmId, sectors, baseDigest } = {}) {
    await this.#ready;
    validateIdentity(vmId, sectors, baseDigest);
    try {
      const device = await this.open(vmId);
      const metadataPath = this.#metadataPath(vmId);
      const record = JSON.parse(await readFile(metadataPath, "utf8"));
      if (record.sectors !== sectors || record.baseDigest !== baseDigest) {
        await this.release(vmId);
        throw new Error("Persistent VM identity is bound to different disk geometry or base image");
      }
      return device;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return this.create({ vmId, sectors, baseDigest });
    }
  }

  async create({ vmId = randomUUID(), sectors, baseDigest } = {}) {
    await this.#ready;
    validateIdentity(vmId, sectors, baseDigest);
    const metadataPath = this.#metadataPath(vmId);
    let metadata;
    try {
      await lstat(metadataPath);
      throw new Error("VM identity is already registered");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const baseDevice = await this.#resolveBaseDevice(baseDigest);
    if (!baseDevice || baseDevice.readOnly !== true || baseDevice.sectors !== sectors) {
      throw new Error("Trusted immutable base device does not match registered disk geometry");
    }
    const device = await CopyOnWriteBlockDevice.open({
      directory: this.#overlayDirectory, vmId, sectors, baseDigest, baseDevice, create: true
    });
    metadata = { version: 1, vmId, sectors, baseDigest, overlayName: vmId + ".overlay" };
    const temporary = path.join(this.#directory, vmId + "." + randomUUID() + ".tmp");
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(metadata) + "\n"); await file.sync(); }
      finally { await file.close(); }
      // Hard-link publication is exclusive: never overwrite a concurrently
      // registered VM identity. Metadata is small and lives on one filesystem.
      await link(temporary, metadataPath);
      await unlink(temporary);
      const dir = await open(this.#directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
      this.#opened.set(vmId, device);
      return device;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      await device.close().catch(() => {});
      throw error;
    }
  }

  async open(vmId) {
    await this.#ready;
    validateVmId(vmId);
    if (this.#opened.has(vmId)) return this.#opened.get(vmId);
    const metadataPath = this.#metadataPath(vmId);
    const stat = await lstat(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error("VM registry record is unsafe");
    }
    const record = JSON.parse(await readFile(metadataPath, "utf8"));
    if (record.version !== 1 || record.vmId !== vmId || record.overlayName !== vmId + ".overlay") {
      throw new Error("VM registry record is invalid");
    }
    validateIdentity(record.vmId, record.sectors, record.baseDigest);
    const baseDevice = await this.#resolveBaseDevice(record.baseDigest);
    if (!baseDevice || baseDevice.readOnly !== true || baseDevice.sectors !== record.sectors) {
      throw new Error("Trusted base device is unavailable or mismatched for VM " + vmId);
    }
    const device = await CopyOnWriteBlockDevice.open({
      directory: this.#overlayDirectory, vmId, sectors: record.sectors,
      baseDigest: record.baseDigest, baseDevice, create: false
    });
    this.#opened.set(vmId, device);
    return device;
  }

  /** Resolver passed to DurableRecoveryJournal; identity is resolved only via host registry. */
  resolveDevice = async vmId => this.open(vmId);

  async release(vmId) {
    await this.#ready;
    validateVmId(vmId);
    const device = this.#opened.get(vmId);
    if (!device) return false;
    this.#opened.delete(vmId);
    await device.close();
    return true;
  }

  async close() {
    const devices = [...this.#opened.values()];
    this.#opened.clear();
    const results = await Promise.allSettled(devices.map(device => device.close()));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Failed to close registered VM disks");
  }

  #metadataPath(vmId) { return path.join(this.#directory, vmId + ".json"); }
}

function validateVmId(vmId) {
  if (typeof vmId !== "string" || !/^[-a-f0-9]{36}$/i.test(vmId)) throw new TypeError("Invalid VM identity");
}

function validateIdentity(vmId, sectors, baseDigest) {
  validateVmId(vmId);
  if (!Number.isSafeInteger(sectors) || sectors < 1 || sectors > 2 ** 20
    || typeof baseDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(baseDigest)) {
    throw new TypeError("Invalid persistent VM disk identity");
  }
}
