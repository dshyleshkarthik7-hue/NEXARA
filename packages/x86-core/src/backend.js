import { ExecutionBackend, GuestMemory } from "../../runtime/src/index.js";
import { X86Cpu } from "./index.js";

export class X86InterpreterMachine {
  constructor({ mode, memory, entryPoint = 0 }) {
    this.mode = mode;
    this.memory = memory;
    this.cpu = new X86Cpu({ memory, mode, instructionPointer: entryPoint });
    const stackTop = memory.byteLength - 16;
    this.cpu.setRegister(4, BigInt(stackTop), mode);
  }

  loadProgram(bytes, { address = 0, entryPoint = address } = {}) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Program must be a Uint8Array");
    if (!Number.isSafeInteger(address) || address < 0 || address + bytes.byteLength > this.memory.byteLength) {
      throw new RangeError("Program does not fit in guest memory");
    }
    if (!Number.isSafeInteger(entryPoint) || entryPoint < 0 || entryPoint >= this.memory.byteLength) {
      throw new RangeError("Entry point is outside guest memory");
    }
    this.memory.write(address, bytes);
    this.cpu.ip = entryPoint;
    this.cpu.halted = false;
    return { address, byteLength: bytes.byteLength, entryPoint };
  }

  step() { return this.cpu.step(); }
  run(options) { return this.cpu.run(options); }
  getRegister(index, width = this.mode) { return this.cpu.getRegister(index, width); }
  setRegister(index, value, width = this.mode) { return this.cpu.setRegister(index, value, width); }
  readMemory(address, length) { return this.memory.read(address, length); }
  writeMemory(address, bytes) { return this.memory.write(address, bytes); }
  saveState() { return this.cpu.saveState(); }
  loadState(state) { return this.cpu.loadState(state); }
  get state() {
    return Object.freeze({
      mode: this.mode,
      instructionPointer: this.cpu.ip,
      halted: this.cpu.halted,
      instructionsExecuted: this.cpu.instructionsExecuted,
      registers: this.cpu.registerSnapshot()
    });
  }
}

/** Browser-compatible interpreter backend for the explicitly implemented x86 subset. */
export class X86InterpreterBackend extends ExecutionBackend {
  constructor() { super("x86-interpreter"); }

  getCapabilities() {
    return Object.freeze({
      id: this.id,
      execution: "javascript-interpreter",
      modes: Object.freeze([32, 64]),
      guestMemory: true,
      saveState: true,
      linuxBoot: false,
      completeX86Compatibility: false
    });
  }

  async createMachine(configuration = {}) {
    const mode = configuration.mode ?? 64;
    const memoryPages = configuration.memoryPages ?? 4;
    const maximumPages = configuration.maximumPages ?? Math.max(memoryPages, 256);
    const entryPoint = configuration.entryPoint ?? 0;
    if (mode !== 32 && mode !== 64) throw new RangeError("mode must be 32 or 64");
    const memory = new GuestMemory({ initialPages: memoryPages, maximumPages });
    return new X86InterpreterMachine({ mode, memory, entryPoint });
  }
}
