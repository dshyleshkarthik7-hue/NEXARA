import { constants as fsConstants } from "node:fs";
import { mkdir, lstat, open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { BLOCK_SECTOR_SIZE } from "./block-device.js";

const MAGIC = Buffer.from("NEXARACOW1");
const HEADER_SIZE = 64;

/**
 * Sparse sector-level copy-on-write disk. The base device must be immutable
 * for the lifetime of the overlay. Overlay metadata binds it to a base digest.
 */
export class CopyOnWriteBlockDevice {
  #handle;
  #base;
  #closed = false;
  #bitmapOffset;
  #dataOffset;

  constructor({ handle, baseDevice, sectors, baseDigest, filePath }) {
    this.#handle = handle;
    this.#base = baseDevice;
    this.sectors = sectors;
    this.baseDigest = baseDigest;
    this.filePath = filePath;
    this.#bitmapOffset = HEADER_SIZE;
    this.#dataOffset = HEADER_SIZE + Math.ceil(sectors / 8);
  }

  static async open({ directory, vmId, sectors, baseDigest, baseDevice, create = true } = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)
      || typeof vmId !== "string" || !/^[a-f0-9-]{16,64}$/i.test(vmId)
      || !Number.isSafeInteger(sectors) || sectors < 1 || sectors > 2 ** 20
      || typeof baseDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(baseDigest)
      || !baseDevice || typeof baseDevice.readSectors !== "function"
      || baseDevice.sectors !== sectors || baseDevice.readOnly !== true
      || typeof create !== "boolean") {
      throw new TypeError("Invalid copy-on-write disk configuration; base device must be read-only with matching geometry");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Overlay storage root must be a real directory");
    const filePath = path.join(directory, vmId + ".overlay");
    const flags = fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0);
    let handle;
    if (create) {
      try { handle = await open(filePath, flags | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        handle = await open(filePath, flags);
      }
    } else handle = await open(filePath, flags);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Overlay image must be a regular file");
      const bitmapBytes = Math.ceil(sectors / 8);
      const expectedBytes = HEADER_SIZE + bitmapBytes + sectors * BLOCK_SECTOR_SIZE;
      if (stat.size === 0 && create) {
        const header = Buffer.alloc(HEADER_SIZE);
        MAGIC.copy(header, 0);
        header.writeUInt32LE(1, 12);
        header.writeUInt32LE(sectors, 16);
        Buffer.from(baseDigest.slice(7), "hex").copy(header, 20);
        await writeAll(handle, header, 0);
        await handle.truncate(expectedBytes);
        await handle.sync();
      } else {
        if (stat.size !== expectedBytes) throw new Error("Overlay geometry or file size mismatch");
        const header = Buffer.alloc(HEADER_SIZE);
        await readAll(handle, header, 0);
        if (!header.subarray(0, MAGIC.length).equals(MAGIC)
          || header.readUInt32LE(12) !== 1 || header.readUInt32LE(16) !== sectors
          || "sha256:" + header.subarray(20, 52).toString("hex") !== baseDigest) {
          throw new Error("Overlay header does not match the requested base image and geometry");
        }
      }
      return new CopyOnWriteBlockDevice({ handle, baseDevice, sectors, baseDigest, filePath });
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async readSectors(lba, count = 1) {
    this.#assertOpen();
    this.#range(lba, count);
    const result = Buffer.from(await this.#base.readSectors(lba, count));
    const bitmap = Buffer.alloc(Math.ceil(count / 8));
    // Read individual bitmap bytes; adjacent sectors share a bitmap byte.
    for (let i = 0; i < count; i++) {
      const sector = lba + i;
      const byte = Buffer.alloc(1);
      await readAll(this.#handle, byte, this.#bitmapOffset + (sector >> 3));
      if (byte[0] & (1 << (sector & 7))) {
        const data = Buffer.alloc(BLOCK_SECTOR_SIZE);
        await readAll(this.#handle, data, this.#dataOffset + sector * BLOCK_SECTOR_SIZE);
        data.copy(result, i * BLOCK_SECTOR_SIZE);
      }
    }
    return new Uint8Array(result);
  }

  async writeSectors(lba, source) {
    this.#assertOpen();
    if (!(source instanceof Uint8Array) || source.byteLength === 0 || source.byteLength % BLOCK_SECTOR_SIZE !== 0) {
      throw new TypeError("Overlay writes must contain whole 512-byte sectors");
    }
    const count = source.byteLength / BLOCK_SECTOR_SIZE;
    this.#range(lba, count);
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    // Data reaches disk before its bitmap bit is published. A crash can lose
    // the latest write, but cannot expose an uninitialized overlay sector.
    for (let i = 0; i < count; i++) {
      const sector = lba + i;
      await writeAll(this.#handle, bytes.subarray(i * BLOCK_SECTOR_SIZE, (i + 1) * BLOCK_SECTOR_SIZE),
        this.#dataOffset + sector * BLOCK_SECTOR_SIZE);
      const position = this.#bitmapOffset + (sector >> 3);
      const bit = Buffer.alloc(1);
      await readAll(this.#handle, bit, position);
      bit[0] |= 1 << (sector & 7);
      await writeAll(this.#handle, bit, position);
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

  async changedSectorCount() {
    this.#assertOpen();
    const bytes = Buffer.alloc(Math.ceil(this.sectors / 8));
    await readAll(this.#handle, bytes, this.#bitmapOffset);
    let count = 0;
    for (const value of bytes) {
      let n = value;
      while (n) { count += n & 1; n >>>= 1; }
    }
    return count;
  }

  #assertOpen() {
    if (this.#closed) throw new Error("Copy-on-write block device is closed");
  }

  #range(lba, count) {
    if (!Number.isSafeInteger(lba) || !Number.isSafeInteger(count) || lba < 0
      || count < 1 || lba + count > this.sectors) {
      throw new RangeError("Copy-on-write disk access is outside configured geometry");
    }
  }
}

async function readAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error("Unexpected end of copy-on-write overlay");
    offset += result.bytesRead;
  }
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesWritten === 0) throw new Error("Copy-on-write overlay write made no progress");
    offset += result.bytesWritten;
  }
}
