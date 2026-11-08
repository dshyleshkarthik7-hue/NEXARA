/**
 * Integration boundary for execution engines.
 * Implementations must report capabilities honestly and isolate guest state.
 * The host-PTY backend is not an emulator and must never advertise x86 support.
 */
export class ExecutionBackend {
  constructor(id) {
    if (!id || typeof id !== "string") throw new TypeError("Backend id is required");
    this.id = id;
  }
  getCapabilities() {
    throw new Error("getCapabilities() must be implemented");
  }
  async createMachine(_configuration) {
    throw new Error("createMachine() must be implemented");
  }
}

export const MACHINE_ARCHITECTURES = Object.freeze(["x86", "x86_64"]);
export const MEMORY_PAGE_SIZE = 4096;

/**
 * Bounds-checked, little-endian guest memory storage.
 * This is a memory primitive, not an x86 MMU, paging implementation, or emulator.
 */
export class GuestMemory {
  #bytes;

  constructor({ initialPages = 1, maximumPages = 256 } = {}) {
    if (!Number.isInteger(initialPages) || !Number.isInteger(maximumPages)
      || initialPages < 1 || maximumPages < initialPages) {
      throw new RangeError("Invalid guest memory page limits");
    }
    this.maximumPages = maximumPages;
    this.#bytes = new Uint8Array(initialPages * MEMORY_PAGE_SIZE);
  }

  get byteLength() { return this.#bytes.byteLength; }
  get pageCount() { return this.#bytes.byteLength / MEMORY_PAGE_SIZE; }

  #range(address, length) {
    if (!Number.isSafeInteger(address) || !Number.isSafeInteger(length) || address < 0 || length < 0
      || address + length > this.#bytes.byteLength) {
      throw new RangeError("Guest memory access is out of bounds");
    }
  }

  grow(additionalPages) {
    if (!Number.isInteger(additionalPages) || additionalPages < 0) throw new RangeError("Invalid page count");
    const nextPages = this.pageCount + additionalPages;
    if (nextPages > this.maximumPages) throw new RangeError("Guest memory maximum exceeded");
    if (additionalPages === 0) return this.pageCount;
    const next = new Uint8Array(nextPages * MEMORY_PAGE_SIZE);
    next.set(this.#bytes);
    this.#bytes = next;
    return this.pageCount - additionalPages;
  }

  read(address, length) {
    this.#range(address, length);
    return this.#bytes.slice(address, address + length);
  }

  write(address, source) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    this.#range(address, bytes.byteLength);
    this.#bytes.set(bytes, address);
  }

  readU32(address) {
    this.#range(address, 4);
    return new DataView(this.#bytes.buffer).getUint32(address, true);
  }

  writeU32(address, value) {
    this.#range(address, 4);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError("Invalid u32 value");
    new DataView(this.#bytes.buffer).setUint32(address, value, true);
  }

  snapshot() {
    return this.#bytes.slice();
  }

  restore(snapshot) {
    if (!(snapshot instanceof Uint8Array) || snapshot.byteLength === 0
      || snapshot.byteLength % MEMORY_PAGE_SIZE !== 0
      || snapshot.byteLength > this.maximumPages * MEMORY_PAGE_SIZE) {
      throw new TypeError("Invalid guest memory snapshot");
    }
    this.#bytes = snapshot.slice();
  }
}

export { Pic8259, Pit8253, PcAtInterruptFabric } from "./devices.js";

export { MemoryBlockDevice, BLOCK_SECTOR_SIZE } from "./block-device.js";
export { AtaPioDevice } from "./ata-pio.js";
export { LegacyBootSectorLoader, LEGACY_BOOT_ADDRESS, LEGACY_BOOT_SIGNATURE } from "./legacy-boot.js";

