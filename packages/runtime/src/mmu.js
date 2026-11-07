import { MEMORY_PAGE_SIZE, GuestMemory } from "./index.js";

const PAGE_BITS = 12n;
const PAGE_MASK = BigInt(MEMORY_PAGE_SIZE - 1);
const ADDRESS_MASK = (1n << 48n) - 1n;
const CANONICAL_HIGH = 0xffff000000000000n;

export class PageFault extends Error {
  constructor(address, { present = false, write = false, user = false, instruction = false } = {}) {
    const errorCode = (present ? 1 : 0) | (write ? 2 : 0) | (user ? 4 : 0) | (instruction ? 16 : 0);
    super(`Guest page fault at 0x${BigInt(address).toString(16)} (error code 0x${errorCode.toString(16)})`);
    this.name = "PageFault";
    this.address = BigInt(address);
    this.errorCode = errorCode;
    this.present = present;
    this.write = write;
    this.user = user;
    this.instruction = instruction;
  }
}

/**
 * Software-managed 4-level, 48-bit virtual address space.
 * Page mappings point at frames in a bounded GuestMemory instance.
 * This is a deterministic MMU model, not a hardware page-table walker.
 */
export class GuestAddressSpace {
  #mappings = new Map();
  #tlb = new Map();

  constructor(memory, { physicalAddressBits = 48, virtualAddressBits = 48 } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    if (physicalAddressBits !== 48 || virtualAddressBits !== 48) {
      throw new RangeError("Only 48-bit physical and virtual addressing is supported");
    }
    this.memory = memory;
    this.physicalAddressBits = physicalAddressBits;
    this.virtualAddressBits = virtualAddressBits;
  }

  #normalize(address) {
    let value;
    try { value = BigInt(address); } catch { throw new TypeError("Address must be an integer"); }
    if (value < 0n || value > 0xffffffffffffffffn) throw new RangeError("Address is outside 64-bit range");
    const upper = value >> 48n;
    const sign = (value >> 47n) & 1n;
    if ((sign === 0n && upper !== 0n) || (sign === 1n && upper !== 0xffffn)) {
      throw new RangeError("Non-canonical 48-bit virtual address");
    }
    return value;
  }

  #key(address) { return this.#normalize(address) >> PAGE_BITS; }

  map(virtualAddress, physicalAddress, permissions = {}) {
    const virtual = this.#normalize(virtualAddress);
    const physical = BigInt(physicalAddress);
    if ((virtual & PAGE_MASK) !== 0n || physical < 0n || (physical & PAGE_MASK) !== 0n) {
      throw new RangeError("Virtual and physical page addresses must be non-negative and page-aligned");
    }
    if (physical + BigInt(MEMORY_PAGE_SIZE) > BigInt(this.memory.byteLength)) {
      throw new RangeError("Physical page frame is outside guest memory");
    }
    const key = this.#key(virtual);
    if (this.#mappings.has(key) && permissions.replace !== true) {
      throw new Error("Virtual page is already mapped");
    }
    const entry = {
      physical,
      read: permissions.read !== false,
      write: permissions.write === true,
      execute: permissions.execute === true,
      user: permissions.user === true
    };
    if (entry.write && !entry.read) throw new RangeError("Writable pages must also be readable");
    this.#mappings.set(key, entry);
    this.#tlb.delete(key);
    return Object.freeze({ virtual: virtual.toString(), physical: physical.toString(), ...entry });
  }

  unmap(virtualAddress) {
    const virtual = this.#normalize(virtualAddress);
    const key = this.#key(virtual);
    const existed = this.#mappings.delete(key);
    this.#tlb.delete(key);
    return existed;
  }

  protect(virtualAddress, permissions = {}) {
    const virtual = this.#normalize(virtualAddress);
    const key = this.#key(virtual);
    const current = this.#mappings.get(key);
    if (!current) throw new PageFault(virtual);
    return this.map(virtual & ~PAGE_MASK, current.physical, {
      ...current,
      ...permissions,
      replace: true
    });
  }

  translate(virtualAddress, { read = true, write = false, execute = false, user = false } = {}) {
    const virtual = this.#normalize(virtualAddress);
    const key = this.#key(virtual);
    let entry = this.#tlb.get(key);
    if (!entry) {
      entry = this.#mappings.get(key);
      if (entry) this.#tlb.set(key, entry);
    }
    if (!entry) throw new PageFault(virtual, { write, user, instruction: execute });
    const allowed = (!read || entry.read) && (!write || entry.write) && (!execute || entry.execute)
      && (!user || entry.user) && (!write || entry.read);
    if (!allowed) throw new PageFault(virtual, { present: true, write, user, instruction: execute });
    const physical = entry.physical + (virtual & PAGE_MASK);
    if (physical >= BigInt(this.memory.byteLength)) throw new PageFault(virtual, { present: true, write, user, instruction: execute });
    return Number(physical);
  }

  read(virtualAddress, length, options = {}) {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid read length");
    const start = this.#normalize(virtualAddress);
    const output = new Uint8Array(length);
    let copied = 0;
    while (copied < length) {
      const current = start + BigInt(copied);
      const physical = this.translate(current, options);
      const count = Math.min(length - copied, MEMORY_PAGE_SIZE - Number(current & PAGE_MASK));
      output.set(this.memory.read(physical, count), copied);
      copied += count;
    }
    return output;
  }

  write(virtualAddress, source, options = {}) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const start = this.#normalize(virtualAddress);
    let copied = 0;
    while (copied < bytes.length) {
      const current = start + BigInt(copied);
      const physical = this.translate(current, { ...options, write: true });
      const count = Math.min(bytes.length - copied, MEMORY_PAGE_SIZE - Number(current & PAGE_MASK));
      this.memory.write(physical, bytes.subarray(copied, copied + count));
      copied += count;
    }
  }

  fetch(virtualAddress, length, options = {}) {
    return this.read(virtualAddress, length, { ...options, read: false, execute: true });
  }

  get mappingCount() { return this.#mappings.size; }
  flush() { this.#tlb.clear(); }
}
