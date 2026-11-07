import { GuestMemory } from "../../runtime/src/index.js";

const U64_MASK = 0xffffffffffffffffn;

function asU64(value, name) {
  let result;
  try { result = BigInt(value); } catch { throw new TypeError(`${name} must be an integer`); }
  if (result < 0n || result > U64_MASK) throw new RangeError(`${name} is outside the 64-bit range`);
  return result;
}

/**
 * Bounds-checked x86 descriptor-table reader.
 * It decodes GDT/LDT segment descriptors and 64-bit IDT gates; it does not
 * perform privilege transitions or deliver interrupts.
 */
export class X86DescriptorTable {
  constructor(memory, { base = 0n, limit = 0xffff, kind = "gdt", longMode = true } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    if (!["gdt", "ldt", "idt"].includes(kind)) throw new RangeError("kind must be gdt, ldt, or idt");
    this.memory = memory;
    this.kind = kind;
    this.longMode = Boolean(longMode);
    this.setRegister(base, limit);
  }

  setRegister(base, limit) {
    const nextBase = asU64(base, "Descriptor-table base");
    if (!Number.isInteger(limit) || limit < 0 || limit > 0xffff) {
      throw new RangeError("Descriptor-table limit must be a 16-bit unsigned integer");
    }
    if (nextBase + BigInt(limit) >= BigInt(this.memory.byteLength)) {
      throw new RangeError("Descriptor table exceeds guest physical memory");
    }
    this.base = nextBase;
    this.limit = limit;
    return Object.freeze({ base: this.base, limit: this.limit });
  }

  #read(offset, length) {
    if (!Number.isInteger(offset) || offset < 0 || offset + length - 1 > this.limit) {
      throw new RangeError("Descriptor exceeds table limit");
    }
    const address = this.base + BigInt(offset);
    if (address + BigInt(length) > BigInt(this.memory.byteLength)) {
      throw new RangeError("Descriptor exceeds guest physical memory");
    }
    return this.memory.read(Number(address), length);
  }

  #u16(bytes, offset) { return BigInt(bytes[offset] | (bytes[offset + 1] << 8)); }
  #u32(bytes, offset) {
    return BigInt(bytes[offset]) | (BigInt(bytes[offset + 1]) << 8n)
      | (BigInt(bytes[offset + 2]) << 16n) | (BigInt(bytes[offset + 3]) << 24n);
  }

  readSegment(selector, { cpl = 0, requirePresent = true } = {}) {
    if (this.kind === "idt") throw new TypeError("IDT entries are gates, not segment descriptors");
    if (!Number.isInteger(selector) || selector < 0 || selector > 0xffff) throw new RangeError("Invalid segment selector");
    if (!Number.isInteger(cpl) || cpl < 0 || cpl > 3) throw new RangeError("CPL must be between 0 and 3");
    const index = selector >>> 3;
    const rpl = selector & 3;
    if (index === 0) {
      if (selector === 0) return null;
      throw new RangeError("Null descriptor selector is invalid");
    }
    if ((selector & 4) !== 0 && this.kind !== "ldt") {
      throw new RangeError("LDT selector cannot be resolved through this table");
    }
    const bytes = this.#read(index * 8, 8);
    const limitLow = Number(this.#u16(bytes, 0));
    const baseLow = this.#u16(bytes, 2);
    const baseMid = BigInt(bytes[4]);
    const access = bytes[5];
    const flags = bytes[6];
    const limitHigh = flags & 0x0f;
    const baseHigh = BigInt(bytes[7]);
    const type = access & 0x0f;
    const system = (access & 0x10) === 0;
    const dpl = (access >>> 5) & 3;
    const present = (access & 0x80) !== 0;
    if (requirePresent && !present) throw new Error("Segment-not-present fault");
    if (!system) {
      const conforming = (type & 4) !== 0;
      if (conforming ? dpl > cpl : Math.max(cpl, rpl) > dpl) {
        throw new Error("Segment privilege check failed");
      }
    }
    let limit = BigInt(limitLow | (limitHigh << 16));
    if ((flags & 0x80) !== 0) limit = (limit << 12n) | 0xfffn;
    const base = baseLow | (baseMid << 16n) | (baseHigh << 24n);
    const isCode = !system && (type & 8) !== 0;
    const long = (flags & 0x20) !== 0;
    const defaultSize = (flags & 0x40) !== 0;
    if (long && (!isCode || defaultSize)) throw new RangeError("Invalid long-mode code descriptor flags");
    const descriptor = {
      selector, index, rpl, dpl, present, system, type,
      executable: isCode,
      readable: isCode ? (type & 2) !== 0 : true,
      writable: !system && !isCode && (type & 2) !== 0,
      conforming: isCode && (type & 4) !== 0,
      expandDown: !system && !isCode && (type & 4) !== 0,
      accessed: (type & 1) !== 0,
      base, limit,
      granularity: (flags & 0x80) !== 0,
      defaultSize,
      long,
      available: (flags & 0x10) !== 0,
      raw: bytes
    };
    return Object.freeze(descriptor);
  }

  /** Decode a 32-bit protected-mode system descriptor (TSS/LDT). */
  readSystemDescriptor(selector, { allowedTypes = [1, 2, 3, 9, 11], requirePresent = true } = {}) {
    if (this.kind !== "gdt") throw new TypeError("System descriptors must be resolved through the GDT");
    if (!Number.isInteger(selector) || selector <= 0 || selector > 0xffff || (selector & 4) !== 0) {
      throw new RangeError("System descriptor selector must be a non-null GDT selector");
    }
    if (!Array.isArray(allowedTypes) || allowedTypes.some(type => !Number.isInteger(type) || type < 0 || type > 15)) {
      throw new TypeError("allowedTypes must contain descriptor type nibbles");
    }
    const index = selector >>> 3;
    const bytes = this.#read(index * 8, 8);
    const access = bytes[5];
    const type = access & 0x0f;
    const present = (access & 0x80) !== 0;
    if ((access & 0x10) !== 0) throw new Error("Descriptor is a code/data descriptor, not a system descriptor");
    if (!allowedTypes.includes(type)) throw new Error("Unsupported system descriptor type");
    if (requirePresent && !present) throw new Error("System descriptor is not present");
    const limitLow = Number(this.#u16(bytes, 0));
    const baseLow = this.#u16(bytes, 2);
    const base = baseLow | (BigInt(bytes[4]) << 16n) | (BigInt(bytes[7]) << 24n);
    let limit = BigInt(limitLow | ((bytes[6] & 0x0f) << 16));
    if ((bytes[6] & 0x80) !== 0) limit = (limit << 12n) | 0xfffn;
    return Object.freeze({ selector, index, type, present, dpl: (access >>> 5) & 3,
      base, limit, available: (bytes[6] & 0x10) !== 0, raw: bytes });
  }

  readGate(vector, { cpl = 0, software = false } = {}) {
    if (this.kind !== "idt") throw new TypeError("Gate lookup requires an IDT");
    if (!Number.isInteger(vector) || vector < 0 || vector > 255) throw new RangeError("Interrupt vector must be 0..255");
    if (!Number.isInteger(cpl) || cpl < 0 || cpl > 3) throw new RangeError("CPL must be between 0 and 3");
    const offset = vector * (this.longMode ? 16 : 8);
    const bytes = this.#read(offset, this.longMode ? 16 : 8);
    const selector = Number(this.#u16(bytes, 2));
    const ist = this.longMode ? bytes[4] & 7 : 0;
    const attributes = bytes[5];
    const type = attributes & 0x0f;
    const dpl = (attributes >>> 5) & 3;
    const present = (attributes & 0x80) !== 0;
    const validTypes = this.longMode ? [0xe, 0xf] : [0x5, 0x6, 0x7, 0xe, 0xf];
    if (!validTypes.includes(type)) throw new RangeError("Invalid IDT gate type");
    if (this.longMode && ((bytes[4] & 0xf8) !== 0 || bytes[12] !== 0 || bytes[13] !== 0 || bytes[14] !== 0 || bytes[15] !== 0)) {
      throw new RangeError("Reserved 64-bit IDT gate fields must be zero");
    }
    if (!this.longMode && bytes[4] !== 0) throw new RangeError("Reserved 32-bit IDT gate byte must be zero");
    if (software && cpl > dpl) throw new Error("IDT gate privilege check failed");
    if (!present) throw new Error("Gate-not-present fault");
    if (selector === 0) throw new RangeError("IDT gate has a null code selector");
    let target = this.#u16(bytes, 0) | (this.#u16(bytes, 6) << 16n);
    if (this.longMode) target |= this.#u32(bytes, 8) << 32n;
    if (!this.longMode && target > 0xffffffffn) throw new RangeError("32-bit gate offset overflow");
    return Object.freeze({
      vector, selector, offset: target, ist, dpl, present,
      type, interruptGate: type === 0xe || type === 0x6,
      trapGate: type === 0xf || type === 0x7,
      taskGate: type === 0x5,
      width: this.longMode ? 64 : 32,
      raw: bytes
    });
  }

  snapshot() {
    return Object.freeze({ kind: this.kind, base: this.base.toString(), limit: this.limit, longMode: this.longMode });
  }
}
