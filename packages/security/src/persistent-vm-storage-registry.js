import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { CopyOnWriteBlockDevice } from "../../runtime/src/copy-on-write-block-device.js";

/**
 * Durable, host-owned mapping from stable VM UUIDs to COW overlay geometry.
 * Base devices are never described by guest-controlled paths: callers resolve
 * an immutable base image from a trusted digest-indexed image store.
 */
export class PersistentVmStorageRegistry {
  #directory;
  #overlayDirectory;
  #resolveBaseDevice;
  #ready;

  constructor({ directory, overlayDirectory, resolveBaseDevice } = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)
      || typeof overlayDirectory !== "string" || !path.isAbsolute(overlayDirectory)
      || typeof resolveBaseDevice !== "function") {
      throw new TypeError("Storage registry requires absolute private directories and a trusted base-image resolver");
    }
    this.#directory = path.resolve(directory);
    this.#overlayDirectory = path.resolve(overlayDirectory);
    this.#resolveBaseDevice = resolveBaseDevice;
    this.#ready = this.#initialize();
  }

  async #initialize() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await mkdir(this.#overlayDirectory, { recursive: true, mode: 0o700 });
    for (const dir of [this.#directory, this.#overlayDirectory]) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error("VM storage registry and overlay directories must be private non-symlink directories");
      }
    }
  }

  async registerDevice(vmId, device) {
    await this.#ready;
    validateVmId(vmId);
    if (!device || typeof device.filePath !== "string"
      || path.resolve(device.filePath) !== path.join(this.#overlayDirectory, vmId + ".overlay")
      || !Number.isSafeInteger(device.sectors) || device.sectors < 1
      || typeof device.baseDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(device.baseDigest)
      || typeof device.close !== "function") {
      throw new TypeError("Only the broker-created overlay for this VM can be registered");
    }
    const stat = await lstat(device.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error("Registered overlay must be a private regular file with one link");
    }
    const record = Object.freeze({
      version: 1, vmId, overlayName: vmId + ".overlay",
      sectors: device.sectors, baseDigest: device.baseDigest
    });
    await this.#writeRecord(record);
    return record;
  }

  /** Create and register a new VM overlay from a trusted immutable base image. */
  async createDevice({ vmId, sectors, baseDigest } = {}) {
    await this.#ready;
    validateVmId(vmId);
    if (!Number.isSafeInteger(sectors) || sectors < 1
      || typeof baseDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(baseDigest)) {
      throw new TypeError("Invalid persistent VM disk geometry or base digest");
    }
    if (await this.getRecord(vmId)) throw new Error("Persistent storage is already registered for this VM");
    const baseDevice = await this.#resolveBaseDevice(baseDigest, sectors);
    if (!baseDevice || baseDevice.readOnly !== true || baseDevice.sectors !== sectors) {
      throw new Error("Trusted base-image resolver returned incompatible or writable storage");
    }
    const device = await CopyOnWriteBlockDevice.open({
      directory: this.#overlayDirectory, vmId, sectors, baseDigest, baseDevice, create: true
    });
    try {
      await this.registerDevice(vmId, device);
      return device;
    } catch (error) {
      await device.close().catch(() => {});
      throw error;
    }
  }

  /** Recovery resolver with bounded handle lifetime for journal replay. */
  async resolveForRecovery(vmId) {
    const device = await this.resolveDevice(vmId);
    let used = false;
    return Object.freeze({
      importRaw: async rawPath => {
        if (used) throw new Error("Recovery device handle has already been consumed");
        used = true;
        try { return await device.importRaw(rawPath); }
        finally { await device.close(); }
      }
    });
  }

  async getRecord(vmId) {
    await this.#ready;
    validateVmId(vmId);
    const file = path.join(this.#directory, vmId + ".json");
    let stat;
    try { stat = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error("Unsafe persistent VM storage registry record");
    }
    const record = JSON.parse(await readFile(file, "utf8"));
    if (record.version !== 1 || record.vmId !== vmId || record.overlayName !== vmId + ".overlay"
      || !Number.isSafeInteger(record.sectors) || record.sectors < 1
      || typeof record.baseDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.baseDigest)) {
      throw new Error("Invalid persistent VM storage registry record");
    }
    return Object.freeze(record);
  }

  /** Resolver compatible with DurableRecoveryJournal and VmSupervisor. */
  async resolveDevice(vmId) {
    const record = await this.getRecord(vmId);
    if (!record) throw new Error("No registered persistent storage for VM " + vmId);
    const baseDevice = await this.#resolveBaseDevice(record.baseDigest, record.sectors);
    if (!baseDevice || baseDevice.readOnly !== true || baseDevice.sectors !== record.sectors) {
      throw new Error("Trusted base-image resolver returned incompatible or writable storage");
    }
    return CopyOnWriteBlockDevice.open({
      directory: this.#overlayDirectory,
      vmId,
      sectors: record.sectors,
      baseDigest: record.baseDigest,
      baseDevice,
      create: false
    });
  }

  async remove(vmId) {
    await this.#ready;
    validateVmId(vmId);
    const record = await this.getRecord(vmId);
    if (!record) return false;
    // Registry metadata is removed only. Overlay deletion belongs to a
    // separate lifecycle operation after all journal records are recovered.
    await unlink(path.join(this.#directory, vmId + ".json"));
    await this.#syncDirectory();
    return true;
  }

  async #writeRecord(record) {
    const target = path.join(this.#directory, record.vmId + ".json");
    const temp = path.join(this.#directory, record.vmId + "." + randomUUID() + ".tmp");
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); }
    finally { await file.close(); }
    try {
      await rename(temp, target);
      await this.#syncDirectory();
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  async #syncDirectory() {
    const dir = await open(this.#directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

function validateVmId(vmId) {
  if (typeof vmId !== "string" || !/^[-a-f0-9]{36}$/i.test(vmId)) {
    throw new TypeError("VM storage identity must be a UUID");
  }
}
