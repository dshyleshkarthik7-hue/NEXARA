import { GuestMemory } from "../../runtime/src/index.js";

const CF = 1, PF = 4, AF = 16, ZF = 64, SF = 128, TF = 256, IF = 512, DF = 1024, OF = 2048;
const MASK16 = 0xffff;

/**
 * Small 8086-style real-mode interpreter for boot-path experiments.
 * Implements only the documented opcode subset below; no BIOS services,
 * protected-mode transitions, DMA, or complete 8086 compatibility.
 */
export class X86RealModeCpu {
  constructor({ memory, cs = 0, ip = 0x7c00, ds = 0, es = 0, ss = 0, sp = 0x7c00, a20Enabled = false } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    for (const [name, value] of Object.entries({ cs, ip, ds, es, ss, sp })) {
      if (!Number.isInteger(value) || value < 0 || value > MASK16) throw new RangeError(name + " must be a 16-bit unsigned value");
    }
    this.memory = memory;
    this.cs = cs; this.ip = ip; this.ds = ds; this.es = es; this.ss = ss; this.sp = sp;
    this.ax = 0; this.cx = 0; this.dx = 0; this.bx = 0;
    this.bp = 0; this.si = 0; this.di = 0;
    this.flags = 2;
    this.a20Enabled = Boolean(a20Enabled);
    this.halted = false;
    this.instructionsExecuted = 0;
  }

  #physical(segment, offset) {
    const linear = ((segment & MASK16) << 4) + (offset & MASK16);
    return this.a20Enabled ? linear : (linear & 0xfffff);
  }
  #read8(segment, offset) { return this.memory.read(this.#physical(segment, offset), 1)[0]; }
  #write8(segment, offset, value) { this.memory.write(this.#physical(segment, offset), Uint8Array.of(value & 0xff)); }
  #read16(segment, offset) {
    return this.#read8(segment, offset) | (this.#read8(segment, (offset + 1) & MASK16) << 8);
  }
  #write16(segment, offset, value) {
    this.#write8(segment, offset, value);
    this.#write8(segment, (offset + 1) & MASK16, value >>> 8);
  }
  #fetch8() { const value = this.#read8(this.cs, this.ip); this.ip = (this.ip + 1) & MASK16; return value; }
  #fetch16() { const low = this.#fetch8(); return low | (this.#fetch8() << 8); }
  #reg16(index) { return [this.ax,this.cx,this.dx,this.bx,this.sp,this.bp,this.si,this.di][index]; }
  #setReg16(index, value) {
    const name = ["ax","cx","dx","bx","sp","bp","si","di"][index];
    this[name] = value & MASK16;
  }
  #reg8(index) {
    const value = this.#reg16(index & 3);
    return index < 4 ? value & 0xff : value >>> 8;
  }
  #setReg8(index, value) {
    const base = index & 3, old = this.#reg16(base);
    this.#setReg16(base, index < 4 ? ((old & 0xff00) | (value & 0xff)) : ((old & 0x00ff) | ((value & 0xff) << 8)));
  }
  #setLogicFlags(value) {
    const result = value & MASK16;
    this.flags = (this.flags & ~(CF | PF | AF | ZF | SF | OF)) |
      (result === 0 ? ZF : 0) | (result & 0x8000 ? SF : 0) |
      (([0,1,2,3,4,5,6,7].filter(bit => (result >>> bit) & 1).length % 2 === 0) ? PF : 0) | 2;
  }
  #push(value) { this.sp = (this.sp - 2) & MASK16; this.#write16(this.ss, this.sp, value); }
  #pop() { const value = this.#read16(this.ss, this.sp); this.sp = (this.sp + 2) & MASK16; return value; }

  step() {
    if (this.halted) return Object.freeze({ state: "halted", ip: this.ip });
    const start = this.ip;
    const opcode = this.#fetch8();
    if (opcode === 0x90) {
      // NOP
    } else if (opcode === 0xf4) {
      this.halted = true;
    } else if (opcode === 0xfa) {
      this.flags &= ~IF;
    } else if (opcode === 0xfb) {
      this.flags |= IF;
    } else if (opcode >= 0xb8 && opcode <= 0xbf) {
      this.#setReg16(opcode - 0xb8, this.#fetch16());
    } else if (opcode >= 0xb0 && opcode <= 0xb7) {
      this.#setReg8(opcode - 0xb0, this.#fetch8());
    } else if (opcode >= 0x50 && opcode <= 0x57) {
      this.#push(this.#reg16(opcode - 0x50));
    } else if (opcode >= 0x58 && opcode <= 0x5f) {
      this.#setReg16(opcode - 0x58, this.#pop());
    } else if (opcode >= 0x40 && opcode <= 0x47) {
      const old = this.#reg16(opcode - 0x40), result = (old + 1) & MASK16;
      const carry = this.flags & CF;
      this.#setReg16(opcode - 0x40, result);
      this.#setLogicFlags(result);
      this.flags = (this.flags & ~CF) | carry
        | ((old & 0x0fff) === 0x0fff ? AF : 0)
        | (old === 0x7fff ? OF : 0);
    } else if (opcode >= 0x48 && opcode <= 0x4f) {
      const old = this.#reg16(opcode - 0x48), result = (old - 1) & MASK16;
      const carry = this.flags & CF;
      this.#setReg16(opcode - 0x48, result);
      this.#setLogicFlags(result);
      this.flags = (this.flags & ~CF) | carry
        | ((old & 0x0fff) === 0 ? AF : 0)
        | (old === 0x8000 ? OF : 0);
    } else if (opcode === 0x31 || opcode === 0x33) {
      const modrm = this.#fetch8();
      if ((modrm & 0xc0) !== 0xc0) throw new Error("Real-mode XOR currently supports register operands only");
      const reg = (modrm >>> 3) & 7, rm = modrm & 7;
      const left = opcode === 0x31 ? this.#reg16(rm) : this.#reg16(reg);
      const right = opcode === 0x31 ? this.#reg16(reg) : this.#reg16(rm);
      this.#setReg16(opcode === 0x31 ? rm : reg, left ^ right);
      this.#setLogicFlags(left ^ right);
    } else if (opcode === 0xa1) {
      this.ax = this.#read16(this.ds, this.#fetch16());
    } else if (opcode === 0xa3) {
      this.#write16(this.ds, this.#fetch16(), this.ax);
    } else if (opcode === 0xeb) {
      const displacement = this.#fetch8();
      this.ip = (this.ip + (displacement & 0x80 ? displacement - 0x100 : displacement)) & MASK16;
    } else if (opcode === 0xe9) {
      const displacement = this.#fetch16();
      this.ip = (this.ip + (displacement & 0x8000 ? displacement - 0x10000 : displacement)) & MASK16;
    } else if (opcode === 0xe8) {
      const displacement = this.#fetch16();
      this.#push(this.ip);
      this.ip = (this.ip + (displacement & 0x8000 ? displacement - 0x10000 : displacement)) & MASK16;
    } else if (opcode === 0xc3) {
      this.ip = this.#pop();
    } else if (opcode === 0x9c) {
      this.#push(this.flags);
    } else if (opcode === 0x9d) {
      this.flags = (this.#pop() | 2) & 0x0fff;
    } else {
      this.ip = start;
      throw new Error("Unsupported real-mode opcode 0x" + opcode.toString(16).padStart(2, "0") + " at 0x" + start.toString(16));
    }
    this.instructionsExecuted++;
    return Object.freeze({ state: this.halted ? "halted" : "running", ip: this.ip, instructionPointer: start });
  }

  run({ maxInstructions = 100000 } = {}) {
    if (!Number.isInteger(maxInstructions) || maxInstructions < 1) throw new RangeError("maxInstructions must be positive");
    let executed = 0;
    while (!this.halted && executed < maxInstructions) { this.step(); executed++; }
    return Object.freeze({ state: this.halted ? "halted" : "limit", instructionsExecuted: executed, ip: this.ip });
  }

  snapshot() {
    return Object.freeze({
      format: "nexara-x86-real-mode-v1", cs: this.cs, ip: this.ip, ds: this.ds, es: this.es, ss: this.ss, sp: this.sp,
      ax: this.ax, cx: this.cx, dx: this.dx, bx: this.bx, bp: this.bp, si: this.si, di: this.di,
      flags: this.flags, a20Enabled: this.a20Enabled, halted: this.halted,
      instructionsExecuted: this.instructionsExecuted
    });
  }
}
