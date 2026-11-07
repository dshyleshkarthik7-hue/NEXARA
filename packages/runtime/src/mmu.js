import { MEMORY_PAGE_SIZE, GuestMemory } from "./index.js";

const PAGE_BITS = 12n;
const PAGE_MASK = BigInt(MEMORY_PAGE_SIZE - 1);
const ADDRESS_MASK = (1n << 48n) - 1n;
const CANONICAL_HIGH = 0xffff000000000000n;

export class PageFault extends Error {
  constructor(address, { present = false, write = false, user = false, reserved = false, instruction = false } = {}) {
    const errorCode = (present ? 1 : 0) | (write ? 2 : 0) | (user ? 4 : 0) | (reserved ? 8 : 0) | (instruction ? 16 : 0);
    super(`Guest page fault at 0x${BigInt(address).toString(16)} (error code 0x${errorCode.toString(16)})`);
    this.name = "PageFault";
    this.address = BigInt(address);
    this.errorCode = errorCode;
    this.present = present;
    this.write = write;
    this.user = user;
    this.reserved = reserved;
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
  #pageTableRoot = null;
  #nxEnabled = false;

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

  setPageTableRoot(cr3) {
    const root = BigInt(cr3);
    if (root < 0n || (root & PAGE_MASK) !== 0n || root + PAGE_MASK >= BigInt(this.memory.byteLength)) {
      throw new RangeError("CR3 must reference an aligned page-table frame in guest physical memory");
    }
    this.#pageTableRoot = root;
    this.#tlb.clear();
    return root;
  }

  get pageTableRoot() { return this.#pageTableRoot; }
  setNxEnabled(enabled) { this.#nxEnabled = Boolean(enabled); this.#tlb.clear(); }
  clearPageTableRoot() { this.#pageTableRoot = null; this.#tlb.clear(); }

  #readEntry(address) {
    if (address < 0n || address + 8n > BigInt(this.memory.byteLength)) {
      throw new PageFault(0n);
    }
    const bytes = this.memory.read(Number(address), 8);
    let value = 0n;
    for (let i = 0; i < 8; i++) value |= BigInt(bytes[i]) << BigInt(i * 8);
    return value;
  }

  #walkPageTables(virtual, { read, write, execute, user }) {
    const indexes = [39n, 30n, 21n, 12n].map(shift => Number((virtual >> shift) & 0x1ffn));
    let table = this.#pageTableRoot;
    let effectiveWrite = true;
    let effectiveUser = true;
    let effectiveExecute = true;
    for (let level = 0; level < 4; level++) {
      const entryAddress = table + BigInt(indexes[level] * 8);
      const entry = this.#readEntry(entryAddress);
      const present = (entry & 1n) !== 0n;
      if (!present) throw new PageFault(virtual, { write, user, instruction: execute });
      if ((entry & 0x7fff000000000000n) !== 0n || (!this.#nxEnabled && (entry & (1n << 63n)) !== 0n)) {
        throw new PageFault(virtual, { present: true, write, user, reserved: true, instruction: execute });
      }
      effectiveWrite &&= (entry & 2n) !== 0n;
      effectiveUser &&= (entry & 4n) !== 0n;
      effectiveExecute &&= (entry & (1n << 63n)) === 0n;
      const pageSize = level === 1 ? (1n << 30n) : level === 2 ? (1n << 21n) : PAGE_MASK + 1n;
      const largePage = (level === 1 || level === 2) && (entry & (1n << 7n)) !== 0n;
      if (level === 0 && (entry & (1n << 7n)) !== 0n) {
        throw new PageFault(virtual, { present: true, write, user, instruction: execute });
      }
      if (level < 3 && !largePage) {
        table = entry & 0x0000fffffffff000n;
        if (table + PAGE_MASK >= BigInt(this.memory.byteLength)) {
          throw new PageFault(virtual, { present: true, write, user, instruction: execute });
        }
        continue;
      }
      const allowed = (!write || effectiveWrite) && (!user || effectiveUser)
        && (!execute || effectiveExecute);
      if (!allowed) throw new PageFault(virtual, { present: true, write, user, instruction: execute });
      const alignmentMask = pageSize - 1n;
      const addressField = entry & 0x0000fffffffff000n;
      const reservedAddressBits = alignmentMask & ~0x1000n; // bit 12 is the large-page PAT bit
      if ((addressField & reservedAddressBits) !== 0n) {
        throw new PageFault(virtual, { present: true, write, user, reserved: true, instruction: execute });
      }
      const physicalBase = addressField & ~alignmentMask;
      const physical = physicalBase | (virtual & alignmentMask);
      if (physical >= BigInt(this.memory.byteLength)) {
        throw new PageFault(virtual, { present: true, write, user, instruction: execute });
      }
      return Number(physical);
    }
    throw new PageFault(virtual);
  }

  translate(virtualAddress, { read = true, write = false, execute = false, user = false } = {}) {
    const virtual = this.#normalize(virtualAddress);
    if (this.#pageTableRoot !== null) return this.#walkPageTables(virtual, { read, write, execute, user });
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

  snapshot() {
    return [...this.#mappings.entries()].map(([page, entry]) => ({
      virtual: (page << PAGE_BITS).toString(),
      physical: entry.physical.toString(),
      read: entry.read,
      write: entry.write,
      execute: entry.execute,
      user: entry.user
    }));
  }

  restore(snapshot) {
    if (!Array.isArray(snapshot)) throw new TypeError("Invalid address-space snapshot");
    const next = new GuestAddressSpace(this.memory, {
      physicalAddressBits: this.physicalAddressBits,
      virtualAddressBits: this.virtualAddressBits
    });
    for (const entry of snapshot) {
      if (!entry || typeof entry.virtual !== "string" || typeof entry.physical !== "string"
        || !["read", "write", "execute", "user"].every(key => typeof entry[key] === "boolean")) {
        throw new TypeError("Invalid address-space mapping snapshot");
      }
      next.map(BigInt(entry.virtual), BigInt(entry.physical), entry);
    }
    this.#mappings = next.#mappings;
    this.#tlb.clear();
  }

  get mappingCount() { return this.#mappings.size; }
  flush() { this.#tlb.clear(); }
}


/**
 * Legacy non-PAE 32-bit x86 paging (two-level PDE/PTE walk).
 * Supports 4 KiB pages and CR4.PSE 4 MiB pages. This is a paging primitive;
 * the CPU must route all guest linear memory accesses through it for enforcement.
 */
export class X86LegacyPaging32 {
  #cr3 = null;
  #tlb = new Map();

  constructor(memory, { pse = false, writeProtect = false } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    this.memory = memory;
    this.pse = Boolean(pse);
    this.writeProtect = Boolean(writeProtect);
  }

  setControl({ pse = this.pse, writeProtect = this.writeProtect } = {}) {
    this.pse = Boolean(pse);
    this.writeProtect = Boolean(writeProtect);
    this.flush();
  }

  loadCr3(value) {
    const cr3 = BigInt(value);
    if (cr3 < 0n || cr3 > 0xfffff000n || (cr3 & 0xfffn) !== 0n
      || cr3 + 4096n > BigInt(this.memory.byteLength)) {
      throw new RangeError("32-bit CR3 must reference an aligned page directory in guest physical memory");
    }
    this.#cr3 = cr3;
    this.flush();
  }

  get cr3() { return this.#cr3; }
  flush() { this.#tlb.clear(); }

  #read32(address) {
    if (address < 0n || address + 4n > BigInt(this.memory.byteLength)) {
      throw new PageFault(0n, { present: true, reserved: true });
    }
    const b = this.memory.read(Number(address), 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  #write32(address, value) {
    const v = value >>> 0;
    this.memory.write(Number(address), Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255));
  }

  translate(linearAddress, { write = false, user = false, execute = false } = {}) {
    const linear = BigInt(linearAddress);
    if (linear < 0n || linear > 0xffffffffn) throw new RangeError("Linear address is outside 32-bit range");
    if (this.#cr3 === null) return Number(linear);
    const cached = this.#tlb.get(linear >> 12n);
    if (cached) {
      const denied = (user && !cached.user) || (write && !cached.writable && (user || this.writeProtect));
      if (denied) throw new PageFault(linear, { present: true, write, user, instruction: execute });
      if (write && cached.dirtyAddress !== null && !cached.dirty) {
        const leaf = this.#read32(cached.dirtyAddress) | 0x40;
        this.#write32(cached.dirtyAddress, leaf);
        cached.dirty = true;
      }
      return Number(cached.physical | (linear & 0xfffn));
    }

    const directoryIndex = Number((linear >> 22n) & 0x3ffn);
    const tableIndex = Number((linear >> 12n) & 0x3ffn);
    const pdeAddress = this.#cr3 + BigInt(directoryIndex * 4);
    let pde = this.#read32(pdeAddress);
    if ((pde & 1) === 0) throw new PageFault(linear, { write, user, instruction: execute });

    const large = (pde & 0x80) !== 0;
    if (large && !this.pse) throw new PageFault(linear, { present: true, write, user, reserved: true, instruction: execute });
    if (large && (pde & 0x003fe000) !== 0) {
      throw new PageFault(linear, { present: true, write, user, reserved: true, instruction: execute });
    }
    let pteAddress = null;
    let pte = null;
    let physicalBase;
    let pageSize;
    let writable = (pde & 2) !== 0;
    let userAllowed = (pde & 4) !== 0;

    if (large) {
      pageSize = 0x400000n;
      physicalBase = BigInt(pde & 0xffc00000);
      // A large mapping may extend beyond installed RAM; validate the actual
      // translated byte below, as a hardware bus model may map holes/devices.
    } else {
      const tableBase = BigInt(pde & 0xfffff000);
      if (tableBase + 4096n > BigInt(this.memory.byteLength)) {
        throw new PageFault(linear, { present: true, write, user, reserved: true, instruction: execute });
      }
      pteAddress = tableBase + BigInt(tableIndex * 4);
      pte = this.#read32(pteAddress);
      if ((pte & 1) === 0) throw new PageFault(linear, { write, user, instruction: execute });
      writable &&= (pte & 2) !== 0;
      userAllowed &&= (pte & 4) !== 0;
      physicalBase = BigInt(pte & 0xfffff000);
      pageSize = 0x1000n;
    }

    const denied = (user && !userAllowed) || (write && !writable && (user || this.writeProtect));
    if (denied) throw new PageFault(linear, { present: true, write, user, instruction: execute });

    // Hardware sets Accessed on every traversed entry and Dirty on a written leaf.
    if ((pde & 0x20) === 0) { pde |= 0x20; this.#write32(pdeAddress, pde); }
    if (pte !== null) {
      if ((pte & 0x20) === 0) pte |= 0x20;
      if (write && (pte & 0x40) === 0) pte |= 0x40;
      this.#write32(pteAddress, pte);
    } else if (write && (pde & 0x40) === 0) {
      pde |= 0x40;
      this.#write32(pdeAddress, pde);
    }

    const physical = physicalBase | (linear & (pageSize - 1n));
    if (physical >= BigInt(this.memory.byteLength)) {
      throw new PageFault(linear, { present: true, write, user, reserved: true, instruction: execute });
    }
    const pageBase = linear & ~0xfffn;
    this.#tlb.set(pageBase, { physical: physical & ~0xfffn, writable, user: userAllowed, dirtyAddress: large ? pdeAddress : pteAddress, dirty: large ? (pde & 0x40) !== 0 : (pte & 0x40) !== 0 });
    return Number(physical);
  }

  read(linearAddress, length, options = {}) {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid read length");
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const linear = BigInt(linearAddress) + BigInt(offset);
      const physical = this.translate(linear, options);
      const count = Math.min(length - offset, 4096 - Number(linear & 0xfffn));
      output.set(this.memory.read(physical, count), offset);
      offset += count;
    }
    return output;
  }

  write(linearAddress, source, options = {}) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    let offset = 0;
    while (offset < bytes.length) {
      const linear = BigInt(linearAddress) + BigInt(offset);
      const physical = this.translate(linear, { ...options, write: true });
      const count = Math.min(bytes.length - offset, 4096 - Number(linear & 0xfffn));
      this.memory.write(physical, bytes.subarray(offset, offset + count));
      offset += count;
    }
  }

  fetch(linearAddress, length, options = {}) {
    return this.read(linearAddress, length, { ...options, execute: true });
  }
}
