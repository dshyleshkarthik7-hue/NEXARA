import { GuestMemory } from "../../runtime/src/index.js";

const U32_MAX = 0xffffffffn;
const U64_MASK = 0xffffffffffffffffn;

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

  get backlink() { return this.#read16(0); }
  set backlink(value) { this.#write16(0, value); }

  /** Read the saved 32-bit hardware-task register image from the TSS. */
  getTaskState() {
    const registers = {};
    for (const [name, offset] of Object.entries({ eax: 40, ecx: 44, edx: 48, ebx: 52, esp: 56, ebp: 60, esi: 64, edi: 68 })) {
      registers[name] = this.#read32(offset);
    }
    const segments = {};
    for (const [name, offset] of Object.entries({ es: 72, cs: 76, ss: 80, ds: 84, fs: 88, gs: 92, ldt: 96 })) {
      segments[name] = this.#read16(offset);
    }
    return Object.freeze({ eip: this.#read32(32), eflags: this.#read32(36),
      registers: Object.freeze(registers), segments: Object.freeze(segments) });
  }

  /** Save a complete 32-bit task register image after validating every field. */
  setTaskState(state) {
    if (!state || typeof state !== "object" || !state.registers || !state.segments) {
      throw new TypeError("TSS task state requires registers and segment selectors");
    }
    const values32 = { eip: state.eip, eflags: state.eflags, ...state.registers };
    const values16 = state.segments;
    const registerOffsets = { eip: 32, eflags: 36, eax: 40, ecx: 44, edx: 48, ebx: 52, esp: 56, ebp: 60, esi: 64, edi: 68 };
    const segmentOffsets = { es: 72, cs: 76, ss: 80, ds: 84, fs: 88, gs: 92, ldt: 96 };
    this.#offset(32, 66);
    for (const name of Object.keys(registerOffsets)) {
      let value;
      try { value = BigInt(values32[name]); } catch { throw new TypeError("TSS task register " + name + " must be an integer"); }
      if (value < 0n || value > U32_MAX) throw new RangeError("TSS task register " + name + " must be 32-bit");
    }
    for (const name of Object.keys(segmentOffsets)) {
      if (!Number.isInteger(values16[name]) || values16[name] < 0 || values16[name] > 0xffff) {
        throw new RangeError("TSS task selector " + name + " must be 16-bit");
      }
    }
    // The architectural task image from EIP through LDTR is contiguous
    // (offsets 32..97). Commit it with one guest-memory write so a failed
    // memory operation cannot leave a partially updated saved task context.
    const image = new Uint8Array(66);
    const view = new DataView(image.buffer);
    for (const [name, offset] of Object.entries(registerOffsets)) {
      view.setUint32(offset - 32, Number(BigInt(values32[name])), true);
    }
    for (const [name, offset] of Object.entries(segmentOffsets)) {
      view.setUint16(offset - 32, values16[name], true);
    }
    this.memory.write(this.#offset(32, image.length), image);
    return this.getTaskState();
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


/**
 * Bounds-checked 64-bit TSS view. RSP0-2 and IST1-7 are 64-bit stack
 * pointers; the long-mode TSS has no ring stack selectors in these fields.
 * This models architectural TSS memory only; it does not imply CPU delivery.
 */
export class X86Tss64 {
  constructor(memory, { base = 0n, limit = 0x67 } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    this.memory = memory;
    this.setRegion(base, limit);
  }

  setRegion(base, limit) {
    let address;
    try { address = BigInt(base); } catch { throw new TypeError("TSS base must be an integer"); }
    if (address < 0n || address > U64_MASK) throw new RangeError("64-bit TSS base is outside the 64-bit range");
    if (!Number.isInteger(limit) || limit < 0x67 || limit > 0xffff) {
      throw new RangeError("64-bit TSS limit must cover the fixed 104-byte header");
    }
    if (address + BigInt(limit) >= BigInt(this.memory.byteLength)) {
      throw new RangeError("TSS region exceeds guest physical memory");
    }
    this.base = address;
    this.limit = limit;
  }

  #address(offset, length) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1
      || offset + length - 1 > this.limit) throw new RangeError("TSS access exceeds descriptor limit");
    const address = this.base + BigInt(offset);
    if (address + BigInt(length) > BigInt(this.memory.byteLength)) throw new RangeError("TSS access exceeds guest memory");
    return Number(address);
  }

  #read64(offset) {
    const bytes = this.memory.read(this.#address(offset, 8), 8);
    let value = 0n;
    for (let i = 0; i < 8; i++) value |= BigInt(bytes[i]) << BigInt(i * 8);
    return value;
  }

  #write64(offset, value) {
    let next;
    try { next = BigInt(value); } catch { throw new TypeError("TSS stack pointer must be an integer"); }
    if (next < 0n || next > U64_MASK) throw new RangeError("TSS stack pointer must be unsigned 64-bit");
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) bytes[i] = Number((next >> BigInt(i * 8)) & 0xffn);
    this.memory.write(this.#address(offset, 8), bytes);
  }

  getRsp(ring) {
    if (!Number.isInteger(ring) || ring < 0 || ring > 2) throw new RangeError("TSS RSP ring must be 0, 1, or 2");
    return this.#read64(4 + ring * 8);
  }

  setRsp(ring, value) {
    if (!Number.isInteger(ring) || ring < 0 || ring > 2) throw new RangeError("TSS RSP ring must be 0, 1, or 2");
    this.#write64(4 + ring * 8, value);
    return this.getRsp(ring);
  }

  getIst(index) {
    if (!Number.isInteger(index) || index < 1 || index > 7) throw new RangeError("IST index must be 1..7");
    return this.#read64(36 + (index - 1) * 8);
  }

  setIst(index, value) {
    if (!Number.isInteger(index) || index < 1 || index > 7) throw new RangeError("IST index must be 1..7");
    this.#write64(36 + (index - 1) * 8, value);
    return this.getIst(index);
  }

  get ioMapBase() {
    const bytes = this.memory.read(this.#address(102, 2), 2);
    return bytes[0] | (bytes[1] << 8);
  }

  set ioMapBase(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError("I/O map base must be 16-bit");
    this.memory.write(this.#address(102, 2), Uint8Array.of(value & 255, value >>> 8));
  }

  snapshot() {
    return Object.freeze({
      format: "nexara-x86-tss64-v1",
      base: this.base.toString(),
      limit: this.limit,
      rsp: [0, 1, 2].map(ring => this.getRsp(ring).toString()),
      ist: [1, 2, 3, 4, 5, 6, 7].map(index => this.getIst(index).toString()),
      ioMapBase: this.ioMapBase
    });
  }
}
