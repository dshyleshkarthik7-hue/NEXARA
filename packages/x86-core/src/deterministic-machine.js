import { DeterministicEventLog } from "../../machine-format/src/event-log.js";
import { X86InterpreterBackend } from "./backend.js";

function fingerprint(machine) {
  return {
    mode: machine.state.mode,
    instructionPointer: machine.state.instructionPointer,
    halted: machine.state.halted,
    instructionsExecuted: machine.state.instructionsExecuted,
    registers: machine.state.registers
  };
}

function cloneState(state) {
  return {
    ...state,
    registers: [...state.registers],
    pendingInterrupts: [...state.pendingInterrupts],
    controlRegisters: { ...state.controlRegisters },
    systemTables: structuredClone(state.systemTables),
    segments: structuredClone(state.segments),
    memory: state.memory.slice(),
    addressSpace: state.addressSpace === null ? null : structuredClone(state.addressSpace),
    legacyPaging32: state.legacyPaging32 === null ? null : structuredClone(state.legacyPaging32)
  };
}

/**
 * Explicit async deterministic facade around the reference interpreter.
 * Every guest instruction is re-executed and checked during replay.
 */
export class DeterministicX86Machine {
  constructor(machine, configuration, eventLog = new DeterministicEventLog()) {
    this.machine = machine;
    this.configuration = Object.freeze({ ...configuration });
    this.eventLog = eventLog;
  }

  static async create(configuration = {}, backend = new X86InterpreterBackend()) {
    const machine = await backend.createMachine(configuration);
    return new DeterministicX86Machine(machine, configuration);
  }

  get state() { return this.machine.state; }

  async loadProgram(bytes, options = {}) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Program must be a Uint8Array");
    const result = this.machine.loadProgram(bytes, options);
    await this.eventLog.append("program.load", {
      bytes: Array.from(bytes),
      address: options.address ?? 0,
      entryPoint: options.entryPoint ?? options.address ?? 0
    });
    return result;
  }

  async step() {
    if (this.machine.cpu.halted) return Object.freeze({ state: "halted", ...fingerprint(this.machine) });
    const result = this.machine.step();
    this.eventLog.advance(1);
    await this.eventLog.append("marker", { kind: "cpu.step", state: fingerprint(this.machine) });
    return result;
  }

  async run({ maxInstructions = 100000 } = {}) {
    if (!Number.isSafeInteger(maxInstructions) || maxInstructions < 1) throw new RangeError("maxInstructions must be a positive safe integer");
    let executed = 0;
    while (!this.machine.cpu.halted && executed < maxInstructions) {
      await this.step();
      executed++;
    }
    return Object.freeze({
      state: this.machine.cpu.halted ? "halted" : "limit",
      instructionsExecuted: executed,
      machine: fingerprint(this.machine),
      eventLogHead: this.eventLog.head
    });
  }

  exportRecording() { return this.eventLog.export(); }

  snapshot() {
    return Object.freeze({
      format: "nexara-deterministic-snapshot-v1",
      configuration: { ...this.configuration },
      state: cloneState(this.machine.saveState()),
      eventLog: this.eventLog.export()
    });
  }

  static async restore(snapshot, backend = new X86InterpreterBackend()) {
    if (!snapshot || snapshot.format !== "nexara-deterministic-snapshot-v1"
      || !snapshot.configuration || !snapshot.state || !snapshot.eventLog) {
      throw new TypeError("Invalid deterministic machine snapshot");
    }
    const machine = await backend.createMachine(snapshot.configuration);
    machine.loadState(cloneState(snapshot.state));
    const eventLog = await DeterministicEventLog.import(snapshot.eventLog);
    return new DeterministicX86Machine(machine, snapshot.configuration, eventLog);
  }

  static async fork(snapshot, backend = new X86InterpreterBackend()) {
    return DeterministicX86Machine.restore(snapshot, backend);
  }

  static async replay(bundle, configuration = {}, backend = new X86InterpreterBackend()) {
    const verifiedLog = await DeterministicEventLog.import(bundle);
    const machine = await backend.createMachine(configuration);
    const replayed = [];
    await verifiedLog.replay({
      "program.load": async event => {
        const { bytes, address, entryPoint } = event.payload;
        if (!Array.isArray(bytes) || !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
          throw new Error("Recording contains invalid program bytes");
        }
        machine.loadProgram(Uint8Array.from(bytes), { address, entryPoint });
        replayed.push(event.sequence);
      },
      marker: async event => {
        if (event.payload?.kind !== "cpu.step") return;
        machine.step();
        const actual = fingerprint(machine);
        if (canonicalFingerprint(actual) !== canonicalFingerprint(event.payload.state)) {
          throw new Error(`Deterministic replay diverged at event ${event.sequence}`);
        }
        replayed.push(event.sequence);
      }
    });
    return Object.freeze({
      machine,
      eventsReplayed: replayed.length,
      eventLogHead: verifiedLog.head,
      state: fingerprint(machine)
    });
  }
}

function canonicalFingerprint(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}
