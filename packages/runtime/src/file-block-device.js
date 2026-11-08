import { constants as fsConstants } from "node:fs";
import { mkdir, lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { BLOCK_SECTOR_SIZE } from "./block-device.js";

/**
 * File-backed per-VM block device. The caller supplies a private storage root;
 * filenames are derived only from a strict VM identifier, never guest input.
 * The containing root must itself be provisioned and protected by the host.
 */
export class FileBlockDevice {
  #handle;
  #closed = false;

  constructor({ handle, sectors, readOnly, filePath }) {
    this.#handle = handle;
    this.sectors = sectors;
    this.readOnly = readOnly;
    this.filePath = filePath;
  }

  static async open({ directory, vmId, sectors, readOnly = false, create = true } = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new TypeError("Block storage directory must be an absolute path");
    }
    if (typeof vmId !== "string" || !/^[a-f0-9-]{16,64}$/i.test(vmId)) {
      throw new TypeError("VM identifier is invalid");
    }
    if (!Number.isSafeInteger(sectors) || sectors < 1 || sectors > 2 ** 20) {
      throw new RangeError("Block device sector count must be between 1 and 1048576");
    }
    if (typeof readOnly !== "boolean" || typeof create !== "boolean") throw new TypeError("Invalid block device mode");
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Block storage root must be a real directory");
    const filePath = path.join(directory, vmId + ".disk");
    let handle;
    if (readOnly) {
      handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } else if (create) {
      try {
        handle = await open(filePath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        handle = await open(filePath, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
      }
    } else {
      handle = await open(filePath, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Block image is not a regular file");
      const expectedBytes = sectors * BLOCK_SECTOR_SIZE;
      if (stat.size === 0 && !readOnly && create) await handle.truncate(expectedBytes);
      else if (stat.size !== expectedBytes) throw new Error("Existing disk image geometry does not match requested sectors");
      return new FileBlockDevice({ handle, sectors, readOnly, filePath });
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async readSectors(lba, count = 1) {
    this.#assertOpen();
    this.#range(lba, count);
    const buffer = Buffer.alloc(count * BLOCK_SECTOR_SIZE);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await this.#handle.read(buffer, offset, buffer.length - offset, lba * BLOCK_SECTOR_SIZE + offset);
      if (result.bytesRead === 0) throw new Error("Unexpected end of block image");
      offset += result.bytesRead;
    }
    return new Uint8Array(buffer);
  }

  async writeSectors(lba, source) {
    this.#assertOpen();
    if (this.readOnly) throw new Error("Block device is read-only");
    if (!(source instanceof Uint8Array) || source.byteLength === 0 || source.byteLength % BLOCK_SECTOR_SIZE !== 0) {
      throw new TypeError("Block writes must contain whole 512-byte sectors");
    }
    const count = source.byteLength / BLOCK_SECTOR_SIZE;
    this.#range(lba, count);
    const buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await this.#handle.write(buffer, offset, buffer.length - offset, lba * BLOCK_SECTOR_SIZE + offset);
      if (result.bytesWritten === 0) throw new Error("Block image write made no progress");
      offset += result.bytesWritten;
    }
  }

  async sync() {
    this.#assertOpen();
    await this.#handle.sync();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }

  #assertOpen() {
    if (this.#closed) throw new Error("Block device is closed");
  }

  #range(lba, count) {
    if (!Number.isSafeInteger(lba) || !Number.isSafeInteger(count) || lba < 0 || count < 1 || lba + count > this.sectors) {
      throw new RangeError("Block device access is outside the configured disk");
    }
  }

  static async remove(directory, vmId) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)
      || typeof vmId !== "string" || !/^[a-f0-9-]{16,64}$/i.test(vmId)) {
      throw new TypeError("Invalid block image removal target");
    }
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Block storage root must be a real directory");
    await rm(path.join(directory, vmId + ".disk"), { force: true });
  }
}
