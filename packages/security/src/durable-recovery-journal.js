import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, unlink, chmod } from "node:fs/promises";
import path from "node:path";

/**
 * Host-local durable queue for stopped guest disks awaiting COW write-back.
 * The journal directory must live on persistent host storage, outside the jail.
 */
export class DurableRecoveryJournal {
  #directory;
  #ready;

  constructor({ directory } = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new TypeError("Recovery journal requires an absolute persistent directory");
    }
    this.#directory = path.resolve(directory);
    this.#ready = this.#initialize();
  }

  async #initialize() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.#directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error("Recovery journal directory must be a private, non-symlink directory");
    }
  }

  async save({ vmId, sourcePath } = {}) {
    await this.#ready;
    if (typeof vmId !== "string" || !/^[-a-f0-9]{36}$/i.test(vmId)
      || typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) {
      throw new TypeError("Invalid recovery record");
    }
    const source = await lstat(sourcePath);
    if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1 || (source.mode & 0o077) !== 0) {
      throw new Error("Recovery source must be a private regular file with one link");
    }
    const id = randomUUID();
    const diskName = id + ".raw";
    const metadataName = id + ".json";
    const diskPath = path.join(this.#directory, diskName);
    const tempMetadata = path.join(this.#directory, id + ".tmp");
    await copyFile(sourcePath, diskPath);
    try {
      await chmod(diskPath, 0o600);
      const disk = await open(diskPath, "r");
      try { await disk.sync(); } finally { await disk.close(); }
      const record = { version: 1, id, vmId, diskName, bytes: source.size, createdAt: new Date().toISOString() };
      const file = await open(tempMetadata, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); } finally { await file.close(); }
      await rename(tempMetadata, path.join(this.#directory, metadataName));
      const dir = await open(this.#directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
      return Object.freeze({ ...record, diskPath });
    } catch (error) {
      await unlink(diskPath).catch(() => {});
      await unlink(tempMetadata).catch(() => {});
      throw error;
    }
  }

  async list() {
    await this.#ready;
    const records = [];
    for (const name of (await readdir(this.#directory)).filter(name => /^[a-f0-9-]{36}\.json$/i.test(name)).sort()) {
      const metadataPath = path.join(this.#directory, name);
      const stat = await lstat(metadataPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe recovery metadata file");
      const record = JSON.parse(await readFile(metadataPath, "utf8"));
      if (record.version !== 1 || name !== record.id + ".json"
        || !/^[-a-f0-9]{36}$/i.test(record.vmId) || record.diskName !== record.id + ".raw"
        || !Number.isSafeInteger(record.bytes) || record.bytes < 1) {
        throw new Error("Invalid recovery journal record");
      }
      const diskPath = path.join(this.#directory, record.diskName);
      const diskStat = await lstat(diskPath);
      if (!diskStat.isFile() || diskStat.isSymbolicLink() || diskStat.nlink !== 1
        || diskStat.size !== record.bytes || (diskStat.mode & 0o077) !== 0) {
        throw new Error("Recovery disk is missing or unsafe");
      }
      records.push(Object.freeze({ ...record, diskPath }));
    }
    return records;
  }

  async remove(id) {
    await this.#ready;
    if (typeof id !== "string" || !/^[-a-f0-9]{36}$/i.test(id)) throw new TypeError("Invalid recovery record id");
    const diskPath = path.join(this.#directory, id + ".raw");
    const metadataPath = path.join(this.#directory, id + ".json");
    await unlink(diskPath);
    await unlink(metadataPath);
    const dir = await open(this.#directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }

  /** Replay queued disks after host restart; failed imports remain queued. */
  async recoverPending(resolveDevice) {
    if (typeof resolveDevice !== "function") throw new TypeError("A trusted VM disk resolver is required");
    const results = [];
    for (const record of await this.list()) {
      const device = await resolveDevice(record.vmId);
      if (!device || typeof device.importRaw !== "function") throw new Error("No trusted COW device for pending VM " + record.vmId);
      const imported = await device.importRaw(record.diskPath);
      await this.remove(record.id);
      results.push(Object.freeze({ vmId: record.vmId, imported }));
    }
    return results;
  }
}
