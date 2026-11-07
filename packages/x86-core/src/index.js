import { GuestMemory } from "../../runtime/src/index.js";

const REG_NAMES = ["rax","rcx","rdx","rbx","rsp","rbp","rsi","rdi","r8","r9","r10","r11","r12","r13","r14","r15"];
const CF = 1n, PF = 1n << 2n, ZF = 1n << 6n, SF = 1n << 7n, OF = 1n << 11n;
const ARITH_FLAGS = CF | PF | ZF | SF | OF;

export class CpuFault extends Error {
  constructor(message, ip) {
    super(`${message} at guest IP 0x${ip.toString(16)}`);
    this.name = "CpuFault";
    this.ip = ip;
  }
}

/**
 * Experimental x86 interpreter, not a complete x86 implementation.
 * Supports a limited integer instruction subset in 32-bit and 64-bit modes.
 * No privilege model, segmentation, paging, interrupts, FPU/SIMD, or devices.
 */
export class X86Cpu {
  constructor({ memory, mode = 64, instructionPointer = 0 } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    if (mode !== 32 && mode !== 64) throw new RangeError("mode must be 32 or 64");
    if (!Number.isSafeInteger(instructionPointer) || instructionPointer < 0 || instructionPointer >= memory.byteLength) {
      throw new RangeError("instructionPointer is outside guest memory");
    }
    this.memory = memory;
    this.mode = mode;
    this.ip = instructionPointer;
    this.registers = Array.from({ length: 16 }, () => 0n);
    this.flags = 2n;
    this.halted = false;
    this.instructionsExecuted = 0;
  }

  #mask(width) { return (1n << BigInt(width)) - 1n; }
  #reg(index) {
    if (!Number.isInteger(index) || index < 0 || index >= (this.mode === 64 ? 16 : 8)) {
      throw new CpuFault("Invalid general-purpose register", this.ip);
    }
  }

  getRegister(index, width = this.mode) {
    this.#reg(index);
    if (![16, 32, 64].includes(width) || (width === 64 && this.mode !== 64)) throw new RangeError("Invalid register width");
    return this.registers[index] & this.#mask(width);
  }

  setRegister(index, value, width = this.mode) {
    this.#reg(index);
    if (![16, 32, 64].includes(width) || (width === 64 && this.mode !== 64)) throw new RangeError("Invalid register width");
    const mask = this.#mask(width);
    const v = BigInt(value) & mask;
    if (width === 32 || width === 64) this.registers[index] = v;
    else this.registers[index] = (this.registers[index] & ~mask) | v;
  }

  #fetch8() {
    if (this.ip >= this.memory.byteLength) throw new CpuFault("Instruction fetch outside memory", this.ip);
    return this.memory.read(this.ip++, 1)[0];
  }
  #fetchUnsigned(bytes) {
    let value = 0n;
    for (let i = 0; i < bytes; i++) value |= BigInt(this.#fetch8()) << BigInt(i * 8);
    return value;
  }
  #fetchSigned(bytes) {
    const bits = BigInt(bytes * 8);
    const value = this.#fetchUnsigned(bytes);
    const sign = 1n << (bits - 1n);
    return value & sign ? value - (1n << bits) : value;
  }

  #address(value, addressWidth) {
    const normalized = BigInt(value) & this.#mask(addressWidth);
    if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) throw new CpuFault("Address exceeds host safe integer range", this.ip);
    return Number(normalized);
  }

  #decodeModRM(rex, addressWidth) {
    const byte = this.#fetch8();
    const mod = byte >> 6;
    const reg = ((byte >> 3) & 7) | ((rex & 4) ? 8 : 0);
    const rmLow = byte & 7;
    const rm = rmLow | ((rex & 1) ? 8 : 0);
    this.#reg(reg);
    if (mod === 3) {
      this.#reg(rm);
      return { reg, operand: { kind: "register", index: rm } };
    }

    let base = 0n;
    let index = 0n;
    let scale = 1n;
    let ripRelative = false;
    if (rmLow === 4) {
      const sib = this.#fetch8();
      const scaleBits = sib >> 6;
      const indexLow = (sib >> 3) & 7;
      const baseLow = sib & 7;
      const indexReg = indexLow | ((rex & 2) ? 8 : 0);
      const baseReg = baseLow | ((rex & 1) ? 8 : 0);
      scale = 1n << BigInt(scaleBits);
      if (indexLow !== 4 || (rex & 2)) {
        this.#reg(indexReg);
        index = this.getRegister(indexReg, addressWidth) * scale;
      }
      if (mod === 0 && baseLow === 5) base = this.#fetchSigned(4);
      else {
        this.#reg(baseReg);
        base = this.getRegister(baseReg, addressWidth);
      }
    } else if (mod === 0 && rmLow === 5) {
      if (this.mode === 64 && addressWidth === 64) ripRelative = true;
      else base = 0n;
      if (!ripRelative) base = this.#fetchSigned(4);
    } else {
      this.#reg(rm);
      base = this.getRegister(rm, addressWidth);
    }

    let displacement = 0n;
    if (mod === 1) displacement = this.#fetchSigned(1);
    if (mod === 2 || (mod === 0 && rmLow === 5 && !ripRelative)) displacement = mod === 2 ? this.#fetchSigned(4) : displacement;
    if (mod === 0 && rmLow === 5 && ripRelative) displacement = this.#fetchSigned(4);
    if (ripRelative) base = BigInt(this.ip);

    const address = this.#address(base + index + displacement, addressWidth);
    return { reg, operand: { kind: "memory", address } };
  }

  #readOperand(operand, width) {
    if (operand.kind === "register") return this.getRegister(operand.index, width);
    const bytes = width / 8;
    const data = this.memory.read(operand.address, bytes);
    let value = 0n;
    for (let i = 0; i < bytes; i++) value |= BigInt(data[i]) << BigInt(i * 8);
    return value;
  }

  #writeOperand(operand, value, width) {
    if (operand.kind === "register") return this.setRegister(operand.index, value, width);
    const bytes = width / 8;
    const v = BigInt(value) & this.#mask(width);
    const data = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) data[i] = Number((v >> BigInt(i * 8)) & 0xffn);
    this.memory.write(operand.address, data);
  }

  #setArithmeticFlags(result, a, b, width, operation) {
    const mask = this.#mask(width);
    const sign = 1n << BigInt(width - 1);
    const r = result & mask;
    this.flags &= ~ARITH_FLAGS;
    if (r === 0n) this.flags |= ZF;
    let parity = Number(r & 0xffn), ones = 0;
    while (parity) { ones ^= 1; parity &= parity - 1; }
    if (ones === 0) this.flags |= PF;
    if (r & sign) this.flags |= SF;
    if (operation === "add") {
      if (a + b > mask) this.flags |= CF;
      if ((~(a ^ b) & (a ^ r) & sign) !== 0n) this.flags |= OF;
    } else if (operation === "sub") {
      if (a < b) this.flags |= CF;
      if (((a ^ b) & (a ^ r) & sign) !== 0n) this.flags |= OF;
    }
  }

  #alu(operation, left, right, width) {
    const a = left & this.#mask(width);
    const b = right & this.#mask(width);
    const result = operation === "add" ? a + b : operation === "sub" || operation === "cmp" ? a - b : a ^ b;
    this.#setArithmeticFlags(result, a, b, width, operation === "cmp" ? "sub" : operation);
    return result & this.#mask(width);
  }

  #condition(code) {
    const cf = (this.flags & CF) !== 0n;
    const zf = (this.flags & ZF) !== 0n;
    const sf = (this.flags & SF) !== 0n;
    const of = (this.flags & OF) !== 0n;
    const pf = (this.flags & PF) !== 0n;
    switch (code & 15) {
      case 0: return of;
      case 1: return !of;
      case 2: return cf;
      case 3: return !cf;
      case 4: return zf;
      case 5: return !zf;
      case 6: return cf || zf;
      case 7: return !cf && !zf;
      case 8: return sf;
      case 9: return !sf;
      case 10: return pf;
      case 11: return !pf;
      case 12: return sf !== of;
      case 13: return sf === of;
      case 14: return zf || sf !== of;
      case 15: return !zf && sf === of;
      default: return false;
    }
  }

  #branch(displacement, start) {
    const target = this.ip + Number(displacement);
    if (!Number.isSafeInteger(target) || target < 0 || target >= this.memory.byteLength) {
      throw new CpuFault("Branch target outside memory", start);
    }
    this.ip = target;
  }

  #stackWidth(operandWidth) { return this.mode === 64 ? 64 : operandWidth; }
  #push(value, width) {
    const bytes = width / 8;
    const stackReg = 4;
    const next = this.getRegister(stackReg, this.mode) - BigInt(bytes);
    const address = this.#address(next, this.mode);
    this.#writeOperand({ kind: "memory", address }, value, width);
    this.setRegister(stackReg, next, this.mode);
  }
  #pop(width) {
    const stackReg = 4;
    const address = this.#address(this.getRegister(stackReg, this.mode), this.mode);
    const value = this.#readOperand({ kind: "memory", address }, width);
    this.setRegister(stackReg, this.getRegister(stackReg, this.mode) + BigInt(width / 8), this.mode);
    return value;
  }

  step() {
    if (this.halted) return { state: "halted", ip: this.ip };
    const start = this.ip;
    let operand16 = false;
    let address32 = false;
    let rex = 0;
    let opcode = this.#fetch8();
    if (opcode === 0x66) { operand16 = true; opcode = this.#fetch8(); }
    if (opcode === 0x67) { address32 = true; opcode = this.#fetch8(); }
    if (this.mode === 64 && opcode >= 0x40 && opcode <= 0x4f) { rex = opcode & 15; opcode = this.#fetch8(); }
    const width = (rex & 8) ? 64 : (operand16 ? 16 : 32);
    const addressWidth = this.mode === 64 && !address32 ? 64 : 32;

    if (opcode === 0x90) {
      // NOP
    } else if (opcode === 0xf4) {
      this.halted = true;
    } else if (opcode >= 0xb8 && opcode <= 0xbf) {
      const index = (opcode - 0xb8) | ((rex & 1) ? 8 : 0);
      this.#reg(index);
      this.setRegister(index, this.#fetchUnsigned(width === 64 ? 8 : width / 8), width);
    } else if (opcode >= 0x50 && opcode <= 0x57) {
      const index = (opcode - 0x50) | ((rex & 1) ? 8 : 0);
      this.#reg(index);
      this.#push(this.getRegister(index, this.#stackWidth(width)), this.#stackWidth(width));
    } else if (opcode >= 0x58 && opcode <= 0x5f) {
      const index = (opcode - 0x58) | ((rex & 1) ? 8 : 0);
      this.#reg(index);
      this.setRegister(index, this.#pop(this.#stackWidth(width)), this.#stackWidth(width));
    } else if (opcode === 0x68 || opcode === 0x6a) {
      const immediate = opcode === 0x6a ? this.#fetchSigned(1) : this.#fetchSigned(width === 16 ? 2 : 4);
      this.#push(immediate, this.#stackWidth(width));
    } else if ([0x89,0x8b,0x01,0x03,0x29,0x2b,0x31,0x33,0x39,0x3b].includes(opcode)) {
      const { reg, operand } = this.#decodeModRM(rex, addressWidth);
      const regValue = this.getRegister(reg, width);
      const operandValue = this.#readOperand(operand, width);
      if (opcode === 0x89) this.#writeOperand(operand, regValue, width);
      if (opcode === 0x8b) this.setRegister(reg, operandValue, width);
      if (opcode === 0x01 || opcode === 0x03) {
        const result = this.#alu("add", opcode === 0x01 ? operandValue : regValue, opcode === 0x01 ? regValue : operandValue, width);
        if (opcode === 0x01) this.#writeOperand(operand, result, width); else this.setRegister(reg, result, width);
      }
      if (opcode === 0x29 || opcode === 0x2b || opcode === 0x39 || opcode === 0x3b) {
        const reverse = opcode === 0x2b || opcode === 0x3b;
        const result = this.#alu("sub", reverse ? regValue : operandValue, reverse ? operandValue : regValue, width);
        if (opcode === 0x29) this.#writeOperand(operand, result, width);
        if (opcode === 0x2b) this.setRegister(reg, result, width);
      }
      if (opcode === 0x31 || opcode === 0x33) {
        const result = this.#alu("xor", opcode === 0x31 ? operandValue : regValue, opcode === 0x31 ? regValue : operandValue, width);
        if (opcode === 0x31) this.#writeOperand(operand, result, width); else this.setRegister(reg, result, width);
      }
    } else if (opcode === 0x8d) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      if (decoded.operand.kind !== "memory") throw new CpuFault("LEA requires a memory addressing form", start);
      this.setRegister(decoded.reg, BigInt(decoded.operand.address), width);
    } else if (opcode === 0xc7) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      if (((decoded.reg & 7) !== 0)) throw new CpuFault("Unsupported C7 extension", start);
      const immediateBytes = width === 16 ? 2 : 4;
      let immediate = this.#fetchUnsigned(immediateBytes);
      if (width === 64 && (immediate & 0x80000000n)) immediate |= 0xffffffff00000000n;
      this.#writeOperand(decoded.operand, immediate, width);
    } else if (opcode === 0x81 || opcode === 0x83) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      const extension = decoded.reg & 7;
      if (![0, 5, 6, 7].includes(extension)) throw new CpuFault("Unsupported integer group-1 extension", start);
      const immediateBytes = opcode === 0x83 ? 1 : (width === 16 ? 2 : 4);
      let immediate = opcode === 0x83 ? this.#fetchSigned(1) : this.#fetchUnsigned(immediateBytes);
      if (opcode === 0x81 && width === 64 && (immediate & 0x80000000n)) immediate |= 0xffffffff00000000n;
      const operation = extension === 0 ? "add" : extension === 5 ? "sub" : extension === 6 ? "xor" : "cmp";
      const left = this.#readOperand(decoded.operand, width);
      const result = this.#alu(operation, left, immediate, width);
      if (operation !== "cmp") this.#writeOperand(decoded.operand, result, width);
    } else if ([0x05,0x2d,0x35,0x3d].includes(opcode)) {
      const bytes = width === 64 ? 4 : width / 8;
      let immediate = this.#fetchUnsigned(bytes);
      if (width === 64 && (immediate & 0x80000000n)) immediate |= 0xffffffff00000000n;
      const operation = opcode === 0x05 ? "add" : opcode === 0x2d ? "sub" : opcode === 0x35 ? "xor" : "cmp";
      const result = this.#alu(operation, this.getRegister(0, width), immediate, width);
      if (operation !== "cmp") this.setRegister(0, result, width);
    } else if (opcode === 0xeb || opcode === 0xe9 || opcode === 0xe8) {
      const displacement = this.#fetchSigned(opcode === 0xeb ? 1 : 4);
      if (opcode === 0xe8) this.#push(BigInt(this.ip), this.#stackWidth(width));
      this.#branch(displacement, start);
    } else if (opcode === 0xc3) {
      const target = this.#pop(this.#stackWidth(width));
      const normalized = target & this.#mask(this.mode);
      if (normalized >= BigInt(this.memory.byteLength)) throw new CpuFault("Return target outside memory", start);
      this.ip = Number(normalized);
    } else if (opcode >= 0x70 && opcode <= 0x7f) {
      const displacement = this.#fetchSigned(1);
      if (this.#condition(opcode & 15)) this.#branch(displacement, start);
    } else if (opcode === 0x0f) {
      const second = this.#fetch8();
      if (second >= 0x80 && second <= 0x8f) {
        const displacement = this.#fetchSigned(4);
        if (this.#condition(second & 15)) this.#branch(displacement, start);
      } else throw new CpuFault(`Unsupported 0F opcode 0x${second.toString(16)}`, start);
    } else {
      throw new CpuFault(`Unsupported opcode 0x${opcode.toString(16).padStart(2, "0")}`, start);
    }

    this.instructionsExecuted++;
    return { state: this.halted ? "halted" : "running", ip: this.ip, instructionPointer: start };
  }

  run({ maxInstructions = 100000 } = {}) {
    if (!Number.isInteger(maxInstructions) || maxInstructions < 1) throw new RangeError("maxInstructions must be positive");
    let executed = 0;
    while (!this.halted && executed < maxInstructions) { this.step(); executed++; }
    return { state: this.halted ? "halted" : "limit", instructionsExecuted: executed, ip: this.ip };
  }

  registerSnapshot() {
    return Object.fromEntries(REG_NAMES.slice(0, this.mode === 64 ? 16 : 8).map((name, i) => [name, this.registers[i].toString()]));
  }
}
