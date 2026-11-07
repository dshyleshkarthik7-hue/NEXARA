import test from "node:test";
import assert from "node:assert/strict";
import { X86InterpreterBackend } from "../packages/x86-core/src/backend.js";

test("x86 backend advertises its real subset and does not claim Linux boot", () => {
  const backend = new X86InterpreterBackend();
  const capabilities = backend.getCapabilities();
  assert.deepEqual(capabilities.modes, [32, 64]);
  assert.equal(capabilities.linuxBoot, false);
  assert.equal(capabilities.completeX86Compatibility, false);
});

test("backend creates a 32-bit machine and executes a guest program", async () => {
  const backend = new X86InterpreterBackend();
  const machine = await backend.createMachine({ mode: 32, memoryPages: 2 });
  machine.loadProgram(Uint8Array.from([0xb8, 42, 0, 0, 0, 0xf4]));
  const result = machine.run();
  assert.equal(result.state, "halted");
  assert.equal(machine.getRegister(0, 32), 42n);
  assert.equal(machine.state.mode, 32);
  assert.equal(machine.state.halted, true);
});

test("backend creates a 64-bit machine and restores saved execution state", async () => {
  const backend = new X86InterpreterBackend();
  const machine = await backend.createMachine({ mode: 64, memoryPages: 1 });
  machine.loadProgram(Uint8Array.from([0x48,0xb8,7,0,0,0,0,0,0,0,0xf4]));
  machine.step();
  const state = machine.saveState();
  machine.setRegister(0, 99n, 64);
  machine.loadState(state);
  assert.equal(machine.getRegister(0, 64), 7n);
  assert.equal(machine.state.instructionPointer, 10);
});

test("backend rejects invalid configurations and out-of-bounds programs", async () => {
  const backend = new X86InterpreterBackend();
  await assert.rejects(backend.createMachine({ mode: 16 }), RangeError);
  const machine = await backend.createMachine({ memoryPages: 1, maximumPages: 1 });
  assert.throws(() => machine.loadProgram(new Uint8Array(4097)), RangeError);
});

import { parseHexProgram } from "../packages/x86-core/src/backend.js";

test("hexadecimal program parser accepts whitespace and comma-separated bytes", () => {
  assert.deepEqual([...parseHexProgram("B8 2A 00 00 00 F4")], [0xb8,0x2a,0,0,0,0xf4]);
  assert.deepEqual([...parseHexProgram("0x48, 0xB8")], [0x48,0xb8]);
});

test("hexadecimal program parser rejects empty and malformed bytes", () => {
  assert.throws(() => parseHexProgram(""), TypeError);
  assert.throws(() => parseHexProgram("B8 2"), TypeError);
  assert.throws(() => parseHexProgram("GG"), TypeError);
});
