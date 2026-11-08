import { GuestMemory } from "../../runtime/src/index.js";

const CF = 1, PF = 4, AF = 16, ZF = 64, SF = 128, TF = 256, IF = 512, DF = 1024, OF = 2048;
const MASK16 = 0xffff;

/**
 * Small 8086-style real-mode interpreter for boot-path experiments.
 * Implements only the documented opcode subset below; optional host-trapped
 * interrupts are injected by the caller. This is not firmware, DMA, or full
 * 8086 compatibility.
 */
export class X86RealModeCpu {
  constructor({ memory, cs = 0, ip = 0x7c00, ds = 0, es = 0, ss = 0, sp = 0x7c00, a20Enabled = false, interruptHandler = null } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    for (const [name, value] of Object.entries({ cs, ip, ds, es, ss, sp })) {
      if (!Number.isInteger(value) || value < 0 || value > MASK16) throw new RangeError(name + " must be a 16-bit unsigned value");
    }
    this.memory = memory;
    this.cs = cs; this.ip = ip; this.ds = ds; this.es = es; this.ss = ss; this.sp = sp;
    this.ax = 0; this.cx = 0; this.dx = 0; this.bx = 0;
    this.bp = 0; this.si = 0; this.di = 0;
    this.flags = 2;
    if (interruptHandler !== null && typeof interruptHandler !== "function") throw new TypeError("interruptHandler must be a function");
    this.a20Enabled = Boolean(a20Enabled);
    this.interruptHandler = interruptHandler;
    this.segmentOverride = null;
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
  #setAddFlags(left, right, bits = 16) {
    const mask = bits === 8 ? 0xff : MASK16;
    const sign = bits === 8 ? 0x80 : 0x8000;
    const a = left & mask, b = right & mask;
    const wide = a + b, result = wide & mask;
    this.flags = (this.flags & ~(CF | PF | AF | ZF | SF | OF)) |
      (wide > mask ? CF : 0) |
      (((a ^ b ^ result) & 0x10) ? AF : 0) |
      (result === 0 ? ZF : 0) | (result & sign ? SF : 0) |
      (([0,1,2,3,4,5,6,7].filter(bit => (result >>> bit) & 1).length % 2 === 0) ? PF : 0) |
      ((~(a ^ b) & (a ^ result) & sign) ? OF : 0) | 2;
    return result;
  }

  #setSubFlags(left, right, bits = 16) {
    const mask = bits === 8 ? 0xff : MASK16;
    const sign = bits === 8 ? 0x80 : 0x8000;
    const a = left & mask, b = right & mask;
    const result = (a - b) & mask;
    this.flags = (this.flags & ~(CF | PF | AF | ZF | SF | OF)) |
      (a < b ? CF : 0) |
      (((a ^ b ^ result) & 0x10) ? AF : 0) |
      (result === 0 ? ZF : 0) |
      (result & sign ? SF : 0) |
      (([0,1,2,3,4,5,6,7].filter(bit => (result >>> bit) & 1).length % 2 === 0) ? PF : 0) |
      (((a ^ b) & (a ^ result) & sign) ? OF : 0) | 2;
  }

  #condition(code) {
    const cf = Boolean(this.flags & CF), pf = Boolean(this.flags & PF);
    const zf = Boolean(this.flags & ZF), sf = Boolean(this.flags & SF);
    const of = Boolean(this.flags & OF);
    switch (code & 0x0f) {
      case 0x0: return of;
      case 0x1: return !of;
      case 0x2: return cf;
      case 0x3: return !cf;
      case 0x4: return zf;
      case 0x5: return !zf;
      case 0x6: return cf || zf;
      case 0x7: return !cf && !zf;
      case 0x8: return sf;
      case 0x9: return !sf;
      case 0xa: return pf;
      case 0xb: return !pf;
      case 0xc: return sf !== of;
      case 0xd: return sf === of;
      case 0xe: return zf || (sf !== of);
      case 0xf: return !zf && (sf === of);
      default: return false;
    }
  }


  #decodeRm(modrm, width = 16) {
    const mod = modrm >>> 6, reg = (modrm >>> 3) & 7, rm = modrm & 7;
    if (mod === 3) {
      return {
        reg,
        read: () => width === 8 ? this.#reg8(rm) : this.#reg16(rm),
        write: value => width === 8 ? this.#setReg8(rm, value) : this.#setReg16(rm, value)
      };
    }
    const bases = [
      [this.bx, this.si], [this.bx, this.di], [this.bp, this.si], [this.bp, this.di],
      [this.si], [this.di], [this.bp], [this.bx]
    ];
    let displacement = 0;
    if (mod === 0 && rm === 6) displacement = this.#fetch16();
    else if (mod === 1) {
      const raw = this.#fetch8();
      displacement = raw & 0x80 ? raw - 0x100 : raw;
    } else if (mod === 2) {
      const raw = this.#fetch16();
      displacement = raw & 0x8000 ? raw - 0x10000 : raw;
    }
    const base = mod === 0 && rm === 6 ? 0 : bases[rm].reduce((sum, value) => sum + value, 0);
    const offset = (base + displacement) & MASK16;
    const defaultSegment = rm === 2 || rm === 3 || (rm === 6 && mod !== 0) ? this.ss : this.ds;
    const segment = this.segmentOverride === null ? defaultSegment : this.segmentOverride;
    return {
      reg,
      read: () => width === 8 ? this.#read8(segment, offset) : this.#read16(segment, offset),
      write: value => width === 8 ? this.#write8(segment, offset, value) : this.#write16(segment, offset, value)
    };
  }

  #stringInstruction(opcode, repeat) {
    const width = (opcode & 1) ? 2 : 1;
    const delta = (this.flags & DF) ? -width : width;
    const comparing = opcode === 0xa6 || opcode === 0xa7 || opcode === 0xae || opcode === 0xaf;
    if (![0xa4,0xa5,0xa6,0xa7,0xaa,0xab,0xac,0xad,0xae,0xaf].includes(opcode)) return false;
    let remaining = repeat === null ? 1 : this.cx;
    while (remaining > 0) {
      if (opcode === 0xa4 || opcode === 0xa5) {
        const value = width === 1 ? this.#read8(this.segmentOverride ?? this.ds, this.si) : this.#read16(this.segmentOverride ?? this.ds, this.si);
        if (width === 1) this.#write8(this.es, this.di, value); else this.#write16(this.es, this.di, value);
        this.si = (this.si + delta) & MASK16; this.di = (this.di + delta) & MASK16;
      } else if (opcode === 0xaa || opcode === 0xab) {
        if (width === 1) this.#write8(this.es, this.di, this.ax & 0xff); else this.#write16(this.es, this.di, this.ax);
        this.di = (this.di + delta) & MASK16;
      } else if (opcode === 0xac || opcode === 0xad || opcode === 0xa6 || opcode === 0xa7 || opcode === 0xae || opcode === 0xaf) {
        if (width === 1) this.#setReg8(0, this.#read8(this.segmentOverride ?? this.ds, this.si)); else this.ax = this.#read16(this.segmentOverride ?? this.ds, this.si);
        this.si = (this.si + delta) & MASK16;
      } else if (opcode === 0xa6 || opcode === 0xa7) {
        const left = width === 1 ? this.#read8(this.segmentOverride ?? this.ds, this.si) : this.#read16(this.segmentOverride ?? this.ds, this.si);
        const right = width === 1 ? this.#read8(this.es, this.di) : this.#read16(this.es, this.di);
        this.#setSubFlags(left, right, width * 8);
        this.si = (this.si + delta) & MASK16; this.di = (this.di + delta) & MASK16;
      } else {
        const value = width === 1 ? this.#read8(this.es, this.di) : this.#read16(this.es, this.di);
        this.#setSubFlags(width === 1 ? this.ax & 0xff : this.ax, value, width * 8);
        this.di = (this.di + delta) & MASK16;
      }
      remaining--;
      if (repeat !== null) this.cx = remaining & MASK16;
      if (comparing && repeat !== null) {
        const equal = Boolean(this.flags & ZF);
        if ((repeat === 0xf3 && !equal) || (repeat === 0xf2 && equal)) break;
      }
    }
    return true;
  }

  #push(value) { this.sp = (this.sp - 2) & MASK16; this.#write16(this.ss, this.sp, value); }
  #pop() { const value = this.#read16(this.ss, this.sp); this.sp = (this.sp + 2) & MASK16; return value; }

  step() {
    if (this.halted) return Object.freeze({ state: "halted", ip: this.ip });
    const start = this.ip;
    let opcode = this.#fetch8();
    let repeat = null;
    this.segmentOverride = null;
    while ([0xf2, 0xf3, 0x26, 0x2e, 0x36, 0x3e].includes(opcode)) {
      if (opcode === 0xf2 || opcode === 0xf3) repeat = opcode;
      else this.segmentOverride = ({ 0x26: this.es, 0x2e: this.cs, 0x36: this.ss, 0x3e: this.ds })[opcode];
      opcode = this.#fetch8();
    }
    if (opcode === 0x90) {
      // NOP
    } else if (opcode === 0xf4) {
      this.halted = true;
    } else if (opcode === 0xfa) {
      this.flags &= ~IF;
    } else if (opcode === 0xfb) {
      this.flags |= IF;
    } else if (opcode === 0xfc) {
      this.flags &= ~DF;
    } else if (opcode === 0xfd) {
      this.flags |= DF;
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
    } else if (opcode === 0x31 || opcode === 0x33 || opcode === 0x89 || opcode === 0x8b) {
      const operand = this.#decodeRm(this.#fetch8(), 16);
      const registerValue = this.#reg16(operand.reg);
      const result = opcode === 0x31 || opcode === 0x33 ? operand.read() ^ registerValue : registerValue;
      if (opcode === 0x31 || opcode === 0x89) operand.write(result);
      else this.#setReg16(operand.reg, opcode === 0x33 ? result : operand.read());
      if (opcode === 0x31 || opcode === 0x33) this.#setLogicFlags(result);
    } else if ([0x00,0x01,0x02,0x03,0x28,0x29,0x2a,0x2b,0x38,0x39,0x3a,0x3b].includes(opcode)) {
      const width = (opcode & 1) ? 16 : 8;
      const operand = this.#decodeRm(this.#fetch8(), width);
      const directionToReg = Boolean(opcode & 2);
      const family = opcode & 0x38;
      const left = directionToReg ? (width === 8 ? this.#reg8(operand.reg) : this.#reg16(operand.reg)) : operand.read();
      const right = directionToReg ? operand.read() : (width === 8 ? this.#reg8(operand.reg) : this.#reg16(operand.reg));
      if (family === 0x00) {
        const result = this.#setAddFlags(left, right, width);
        if (directionToReg) width === 8 ? this.#setReg8(operand.reg, result) : this.#setReg16(operand.reg, result);
        else operand.write(result);
      } else if (family === 0x28) {
        const result = (left - right) & (width === 8 ? 0xff : MASK16);
        this.#setSubFlags(left, right, width);
        if (directionToReg) width === 8 ? this.#setReg8(operand.reg, result) : this.#setReg16(operand.reg, result);
        else operand.write(result);
      } else {
        this.#setSubFlags(left, right, width);
      }
    } else if ([0x04,0x05,0x2c,0x2d].includes(opcode)) {
      const width = (opcode & 1) ? 16 : 8;
      const immediate = width === 8 ? this.#fetch8() : this.#fetch16();
      const left = width === 8 ? this.ax & 0xff : this.ax;
      const result = opcode === 0x04 || opcode === 0x05
        ? this.#setAddFlags(left, immediate, width)
        : this.#setSubFlags(left, immediate, width);
      if (opcode === 0x04 || opcode === 0x05) {
        if (width === 8) this.#setReg8(0, result); else this.ax = result;
      } else if (width === 8) this.#setReg8(0, result);
      else this.ax = result;
    } else if (opcode === 0x80 || opcode === 0x81 || opcode === 0x83) {
      const width = opcode === 0x80 ? 8 : 16;
      const operand = this.#decodeRm(this.#fetch8(), width);
      const operation = operand.reg;
      const immediate = opcode === 0x80 ? this.#fetch8() :
        opcode === 0x83 ? ((this.#fetch8() << 24) >> 24) : this.#fetch16();
      if (operation !== 0 && operation !== 5 && operation !== 7) {
        this.segmentOverride = null;
        this.ip = start;
        throw new Error("Unsupported immediate arithmetic group operation /" + operation);
      }
      const left = operand.read();
      if (operation === 0) {
        operand.write(this.#setAddFlags(left, immediate, width));
      } else {
        const result = (left - immediate) & (width === 8 ? 0xff : MASK16);
        this.#setSubFlags(left, immediate, width);
        if (operation === 5) operand.write(result);
      }
    } else if (opcode === 0x8c || opcode === 0x8e) {
      const operand = this.#decodeRm(this.#fetch8(), 16);
      const segmentIndex = operand.reg;
      const segmentNames = ["es","cs","ss","ds"];
      if (segmentIndex > 3 || (opcode === 0x8e && segmentIndex === 1)) {
        this.segmentOverride = null; this.ip = start;
        throw new Error("Invalid segment-register move");
      }
      if (opcode === 0x8c) operand.write(this[segmentNames[segmentIndex]]);
      else this[segmentNames[segmentIndex]] = operand.read();
    } else if (opcode === 0x88 || opcode === 0x8a) {
      const operand = this.#decodeRm(this.#fetch8(), 8);
      if (opcode === 0x88) operand.write(this.#reg8(operand.reg));
      else this.#setReg8(operand.reg, operand.read());
    } else if (opcode === 0xa4 || opcode === 0xa5 || opcode === 0xaa || opcode === 0xab || opcode === 0xac || opcode === 0xad) {
      if (!this.#stringInstruction(opcode, repeat)) throw new Error("Unsupported string operation");
    } else if (opcode === 0x3d) {
      this.#setSubFlags(this.ax, this.#fetch16());
    } else if (opcode === 0x3c) {
      this.#setSubFlags(this.ax & 0xff, this.#fetch8(), 8);
    } else if (opcode >= 0x70 && opcode <= 0x7f) {
      const displacement = this.#fetch8();
      if (this.#condition(opcode & 0x0f)) {
        this.ip = (this.ip + (displacement & 0x80 ? displacement - 0x100 : displacement)) & MASK16;
      }
    } else if (opcode === 0xe2) {
      const displacement = this.#fetch8();
      this.cx = (this.cx - 1) & MASK16;
      if (this.cx !== 0) {
        this.ip = (this.ip + (displacement & 0x80 ? displacement - 0x100 : displacement)) & MASK16;
      }
    } else if (opcode === 0xa1) {
      this.ax = this.#read16(this.segmentOverride ?? this.ds, this.#fetch16());
    } else if (opcode === 0xa3) {
      this.#write16(this.segmentOverride ?? this.ds, this.#fetch16(), this.ax);
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
    } else if (opcode === 0x9a) {
      const offset = this.#fetch16(), segment = this.#fetch16();
      this.#push(this.cs); this.#push(this.ip);
      this.cs = segment; this.ip = offset;
    } else if (opcode === 0xea) {
      this.ip = this.#fetch16(); this.cs = this.#fetch16();
    } else if (opcode === 0xcb) {
      this.ip = this.#pop(); this.cs = this.#pop();
    } else if (opcode === 0xca) {
      const adjustment = this.#fetch16();
      this.ip = this.#pop(); this.cs = this.#pop();
      this.sp = (this.sp + adjustment) & MASK16;
    } else if (opcode === 0xc3) {
      this.ip = this.#pop();
    } else if (opcode === 0x9c) {
      this.#push(this.flags);
    } else if (opcode === 0x9d) {
      this.flags = (this.#pop() | 2) & 0x0fff;
    } else if (opcode === 0xcd) {
      const vector = this.#fetch8();
      const savedInterruptFlags = this.flags & (IF | TF);
      let handled = false;
      if (this.interruptHandler) {
        this.flags &= ~(IF | TF);
        try {
          handled = this.interruptHandler(this, vector) === true;
        } catch (error) {
          this.flags = (this.flags & ~(IF | TF)) | savedInterruptFlags;
          throw error;
        }
        this.flags = (this.flags & ~(IF | TF)) | savedInterruptFlags;
      }
      if (!handled) {
        const vectorAddress = vector * 4;
        this.#push(this.flags);
        this.#push(this.cs);
        this.#push(this.ip);
        this.flags &= ~(IF | TF);
        this.ip = this.#read16(0, vectorAddress);
        this.cs = this.#read16(0, vectorAddress + 2);
      }
    } else if (opcode === 0xcf) {
      this.ip = this.#pop();
      this.cs = this.#pop();
      this.flags = (this.#pop() | 2) & 0x0fff;
    } else {
      this.segmentOverride = null;
      this.ip = start;
      throw new Error("Unsupported real-mode opcode 0x" + opcode.toString(16).padStart(2, "0") + " at 0x" + start.toString(16));
    }
    this.segmentOverride = null;
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
