import { GuestMemory } from "../../runtime/src/index.js";

const U32_MAX = 0xffffffffn;

/**
 * Bounds-checked 32-bit TSS view for privilege-stack and I/O-bitmap state.
 * This is a data model only: CPU task-register loading, privilege transitions,
 * and IRET integration are deliberately not implied by this class.
 */
export class X86Tss32 {
  constructor(memory, { base = 0n, limit = 0x67 } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    this.memory = memory;
    this.setRegion(base, limit);
    if (limit < 0x67) throw new RangeError("32-bit TSS limit must include the fixed 104-byte header");
  }

  setRegion(base, limit) {
    let address;
    try { address = BigInt(base); } catch { throw new TypeError("TSS base must be an integer"); }
    if (address < 0n || address > U32_MAX) throw new RangeError("TSS base must be a 32-bit address");
    if (!Number.isInteger(limit) || limit < 0x67 || limit > 0xffff) {
      throw new RangeError("TSS limit must cover the 104-byte header and fit 16 bits");
    }
    if (address + BigInt(limit) >= BigInt(this.memory.byteLength)) {
      throw new RangeError("TSS region exceeds guest physical memory");
    }
    this.base = address;
    this.limit = limit;
  }

  #offset(offset, length = 1) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1
      || offset + length - 1 > this.limit) throw new RangeError("TSS access exceeds descriptor limit");
    const address = this.base + BigInt(offset);
    if (address + BigInt(length) > BigInt(this.memory.byteLength)) throw new RangeError("TSS access exceeds guest memory");
    return Number(address);
  }

  #read16(offset) {
    const b = this.memory.read(this.#offset(offset, 2), 2);
    return b[0] | (b[1] << 8);
  }
  #write16(offset, value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError("TSS selector must be 16-bit");
    this.memory.write(this.#offset(offset, 2), Uint8Array.of(value & 0xff, value >>> 8));
  }
  #read32(offset) {
    const b = this.memory.read(this.#offset(offset, 4), 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  #write32(offset, value) {
    let v;
    try { v = BigInt(value); } catch { throw new TypeError("TSS stack pointer must be an integer"); }
    if (v < 0n || v > U32_MAX) throw new RangeError("TSS stack pointer must be 32-bit");
    const n = Number(v);
    this.memory.write(this.#offset(offset, 4), Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff));
  }

  getRingStack(ring) {
    if (!Number.isInteger(ring) || ring < 0 || ring > 2) throw new RangeError("TSS privilege ring must be 0, 1, or 2");
    const offset = 4 + ring * 8;
    return Object.freeze({ esp: this.#read32(offset), ss: this.#read16(offset + 4) });
  }

  setRingStack(ring, { esp, ss }) {
    if (!Number.isInteger(ring) || ring < 0 || ring > 2) throw new RangeError("TSS privilege ring must be 0, 1, or 2");
    const offset = 4 + ring * 8;
    this.#write32(offset, esp);
    this.#write16(offset + 4, ss);
    return this.getRingStack(ring);
  }

  get ioMapBase() { return this.#read16(102); }
  set ioMapBase(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError("I/O map base must be 16-bit");
    this.#write16(102, value);
  }

  /** Returns true only when every port bit in the requested range is clear. */
  allowsIo(port, widthBits = 8) {
    if (!Number.isInteger(port) || port < 0 || port > 0xffff
      || ![8, 16, 32].includes(widthBits) || port + widthBits / 8 > 0x10000) {
      throw new RangeError("Invalid TSS I/O permission range");
    }
    const mapBase = this.ioMapBase;
    if (mapBase > this.limit) return false;
    const firstBit = port;
    const lastBit = port + widthBits / 8 - 1;
    for (let p = firstBit; p <= lastBit; p++) {
      const byteOffset = mapBase + (p >>> 3);
      if (byteOffset > this.limit) return false;
      const byte = this.memory.read(this.#offset(byteOffset), 1)[0];
      if ((byte & (1 << (p & 7))) !== 0) return false;
    }
    return true;
  }

  snapshot() {
    return Object.freeze({ format: "nexara-x86-tss32-v1", base: this.base.toString(), limit: this.limit,
      ringStacks: [0, 1, 2].map(ring => this.getRingStack(ring)), ioMapBase: this.ioMapBase });
  }
}
