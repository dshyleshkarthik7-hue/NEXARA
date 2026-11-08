/**
 * Bounded in-memory sector device for guest storage experiments.
 * This is a block-device primitive, not an ATA/AHCI controller or boot firmware.
 */
export const BLOCK_SECTOR_SIZE = 512;

export class MemoryBlockDevice {
  #bytes;

  constructor({ sectors = 2048, readOnly = false } = {}) {
    if (!Number.isSafeInteger(sectors) || sectors < 1 || sectors > 2 ** 20) {
      throw new RangeError("Block device sector count must be between 1 and 1048576");
    }
    if (typeof readOnly !== "boolean") throw new TypeError("readOnly must be boolean");
    this.sectors = sectors;
    this.readOnly = readOnly;
    this.#bytes = new Uint8Array(sectors * BLOCK_SECTOR_SIZE);
  }

  get byteLength() { return this.#bytes.byteLength; }

  #range(lba, count) {
    if (!Number.isSafeInteger(lba) || !Number.isSafeInteger(count)
      || lba < 0 || count < 1 || lba + count > this.sectors) {
      throw new RangeError("Block device access is outside the configured disk");
    }
  }

  readSectors(lba, count = 1) {
    this.#range(lba, count);
    const start = lba * BLOCK_SECTOR_SIZE;
    return this.#bytes.slice(start, start + count * BLOCK_SECTOR_SIZE);
  }

  writeSectors(lba, source) {
    if (this.readOnly) throw new Error("Block device is read-only");
    if (!(source instanceof Uint8Array) || source.byteLength === 0
      || source.byteLength % BLOCK_SECTOR_SIZE !== 0) {
      throw new TypeError("Block writes must contain whole 512-byte sectors");
    }
    const count = source.byteLength / BLOCK_SECTOR_SIZE;
    this.#range(lba, count);
    this.#bytes.set(source, lba * BLOCK_SECTOR_SIZE);
  }

  snapshot() {
    return Object.freeze({
      format: "nexara-memory-block-device-v1",
      sectors: this.sectors,
      bytes: this.#bytes.slice()
    });
  }

  restore(state) {
    if (!state || state.format !== "nexara-memory-block-device-v1"
      || state.sectors !== this.sectors || !(state.bytes instanceof Uint8Array)
      || state.bytes.byteLength !== this.#bytes.byteLength) {
      throw new TypeError("Invalid block device snapshot");
    }
    this.#bytes = state.bytes.slice();
    return this.snapshot();
  }
}
