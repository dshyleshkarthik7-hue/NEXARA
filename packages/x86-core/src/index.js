import { GuestMemory } from "../../runtime/src/index.js";

const REG64 = ["rax","rcx","rdx","rbx","rsp","rbp","rsi","rdi","r8","r9","r10","r11","r12","r13","r14","r15"];
const FLAG_CF = 1n;
const FLAG_ZF = 1n << 6n;
const FLAG_SF = 1n << 7n;
const FLAG_OF = 1n << 11n;

export class CpuFault extends Error {
  constructor(message, ip) {
    super(`${message} at guest IP 0x${ip.toString(16)}`);
    this.name = "CpuFault";
    this.ip = ip;
  }
}

/**
 * Deliberately small, testable x86 execution core.
 * Implemented subset: NOP, HLT, MOV r,imm; register-only MOV/ADD/SUB/XOR;
 * accumulator immediate arithmetic; short/near relative JMP.
 * This is not yet a complete x86 CPU or Linux-capable machine.
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

  getRegister(index, width = this.mode) {
    this.#checkRegister(index);
    if (![16, 32, 64].includes(width) || (width === 64 && this.mode !== 64)) throw new RangeError("Invalid register width");
    return this.registers[index] & this.#mask(width);
  }

  setRegister(index, value, width = this.mode) {
    this.#checkRegister(index);
    if (![16, 32, 64].includes(width) || (width === 64 && this.mode !== 64)) throw new RangeError("Invalid register width");
    const v = BigInt(value) & this.#mask(width);
    if (width === 64 || (width === 32 && this.mode === 32)) this.registers[index] = v;
    else if (width === 32) this.registers[index] = v; // x86-64 32-bit writes zero-extend.
    else this.registers[index] = (this.registers[index] & ~this.#mask(width)) | v;
  }

  #checkRegister(index) {
    if (!Number.isInteger(index) || index < 0 || index >= (this.mode === 64 ? 16 : 8)) throw new RangeError("Invalid general-purpose register");
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

  #decodeModRM(rex) {
    const byte = this.#fetch8();
    const mod = byte >> 6;
    const reg = ((byte >> 3) & 7) | ((rex & 4) ? 8 : 0);
    const rm = (byte & 7) | ((rex & 1) ? 8 : 0);
    if (mod !== 3) throw new CpuFault("Only register-direct ModRM is implemented", this.ip - 1);
    this.#checkRegister(reg);
    this.#checkRegister(rm);
    return { reg, rm };
  }

  #setArithmeticFlags(result, a, b, width, operation) {
    const mask = this.#mask(width);
    const sign = 1n << BigInt(width - 1);
    const r = result & mask;
    this.flags &= ~(FLAG_CF | FLAG_ZF | FLAG_SF | FLAG_OF);
    if (r === 0n) this.flags |= FLAG_ZF;
    if (r & sign) this.flags |= FLAG_SF;
    if (operation === "add") {
      if (a + b > mask) this.flags |= FLAG_CF;
      if ((~(a ^ b) & (a ^ r) & sign) !== 0n) this.flags |= FLAG_OF;
    } else if (operation === "sub") {
      if (a < b) this.flags |= FLAG_CF;
      if (((a ^ b) & (a ^ r) & sign) !== 0n) this.flags |= FLAG_OF;
    }
  }

  #binary(operation, destination, source, width) {
    const a = this.getRegister(destination, width);
    const b = this.getRegister(source, width);
    let result;
    if (operation === "add") result = a + b;
    else if (operation === "sub") result = a - b;
    else result = a ^ b;
    this.setRegister(destination, result, width);
    if (operation === "xor") {
      this.flags &= ~(FLAG_CF | FLAG_OF);
      this.#setArithmeticFlags(result, a, b, width, "logic");
    } else this.#setArithmeticFlags(result, a, b, width, operation);
  }

  step() {
    if (this.halted) return { state: "halted", ip: this.ip };
    const start = this.ip;
    let operand16 = false;
    let rex = 0;
    let opcode = this.#fetch8();

    if (opcode === 0x66) {
      operand16 = true;
      opcode = this.#fetch8();
    }
    if (this.mode === 64 && opcode >= 0x40 && opcode <= 0x4f) {
      rex = opcode & 0x0f;
      opcode = this.#fetch8();
    }
    const width = (rex & 8) ? 64 : (operand16 ? 16 : 32);

    if (opcode === 0x90) {
      // NOP
    } else if (opcode === 0xf4) {
      this.halted = true;
    } else if (opcode >= 0xb8 && opcode <= 0xbf) {
      const index = (opcode - 0xb8) | ((rex & 1) ? 8 : 0);
      this.#checkRegister(index);
      const immediateBytes = width === 64 ? 8 : width / 8;
      this.setRegister(index, this.#fetchUnsigned(immediateBytes), width);
    } else if ([0x89,0x8b,0x01,0x03,0x29,0x2b,0x31,0x33].includes(opcode)) {
      const { reg, rm } = this.#decodeModRM(rex);
      if (opcode === 0x89) this.setRegister(rm, this.getRegister(reg, width), width);
      if (opcode === 0x8b) this.setRegister(reg, this.getRegister(rm, width), width);
      if (opcode === 0x01) this.#binary("add", rm, reg, width);
      if (opcode === 0x03) this.#binary("add", reg, rm, width);
      if (opcode === 0x29) this.#binary("sub", rm, reg, width);
      if (opcode === 0x2b) this.#binary("sub", reg, rm, width);
      if (opcode === 0x31) this.#binary("xor", rm, reg, width);
      if (opcode === 0x33) this.#binary("xor", reg, rm, width);
    } else if ([0x05,0x2d,0x35].includes(opcode)) {
      const bytes = width / 8;
      const immediate = this.#fetchUnsigned(bytes);
      const a = this.getRegister(0, width);
      const operation = opcode === 0x05 ? "add" : opcode === 0x2d ? "sub" : "xor";
      const result = operation === "add" ? a + immediate : operation === "sub" ? a - immediate : a ^ immediate;
      this.setRegister(0, result, width);
      if (operation === "xor") {
        this.flags &= ~(FLAG_CF | FLAG_OF);
        this.#setArithmeticFlags(result, a, immediate, width, "logic");
      } else this.#setArithmeticFlags(result, a, immediate, width, operation);
    } else if (opcode === 0xeb || opcode === 0xe9) {
      const displacement = this.#fetchSigned(opcode === 0xeb ? 1 : 4);
      const target = this.ip + Number(displacement);
      if (!Number.isSafeInteger(target) || target < 0 || target >= this.memory.byteLength) {
        throw new CpuFault("Branch target outside memory", start);
      }
      this.ip = target;
    } else {
      throw new CpuFault(`Unsupported opcode 0x${opcode.toString(16).padStart(2, "0")}`, start);
    }

    this.instructionsExecuted++;
    return { state: this.halted ? "halted" : "running", ip: this.ip, instructionPointer: start };
  }

  run({ maxInstructions = 100000 } = {}) {
    if (!Number.isInteger(maxInstructions) || maxInstructions < 1) throw new RangeError("maxInstructions must be positive");
    let executed = 0;
    while (!this.halted && executed < maxInstructions) {
      this.step();
      executed++;
    }
    return { state: this.halted ? "halted" : "limit", instructionsExecuted: executed, ip: this.ip };
  }

  registerSnapshot() {
    return Object.fromEntries(REG64.slice(0, this.mode === 64 ? 16 : 8).map((name, i) => [name, this.registers[i].toString()]));
  }
}
