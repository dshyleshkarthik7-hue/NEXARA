import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86Cpu, CpuFault } from "../packages/x86-core/src/index.js";

function cpuFor(bytes, mode = 64) {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  memory.write(0, Uint8Array.from(bytes));
  return new X86Cpu({ memory, mode });
}

test("executes x86-64 mov immediate, add immediate, and halt", () => {
  const cpu = cpuFor([0x48,0xb8,5,0,0,0,0,0,0,0, 0x48,0x05,7,0,0,0, 0xf4]);
  const result = cpu.run();
  assert.equal(result.state, "halted");
  assert.equal(cpu.getRegister(0, 64), 12n);
});

test("32-bit writes zero extend in long mode", () => {
  const cpu = cpuFor([0x48,0xb8,0xff,0xff,0xff,0xff,0,0,0,0, 0xb8,0x34,0x12,0,0, 0xf4]);
  cpu.run();
  assert.equal(cpu.getRegister(0, 64), 0x1234n);
});

test("executes register-direct arithmetic and short branch", () => {
  const cpu = cpuFor([0xb8,2,0,0,0, 0xbb,3,0,0,0, 0x01,0xd8, 0xeb,0x01, 0xf4, 0xf4], 32);
  const result = cpu.run();
  assert.equal(result.state, "halted");
  assert.equal(cpu.getRegister(0, 32), 5n);
});

test("rejects unsupported memory addressing and opcodes", () => {
  const cpu = cpuFor([0x8b,0x00], 32);
  assert.throws(() => cpu.step(), CpuFault);
  const other = cpuFor([0x0f], 32);
  assert.throws(() => other.step(), CpuFault);
});

test("instruction budget prevents unbounded guest loops", () => {
  const cpu = cpuFor([0xeb,0xfe], 32);
  assert.equal(cpu.run({ maxInstructions: 5 }).state, "limit");
  assert.equal(cpu.instructionsExecuted, 5);
});

test("x86-64 accumulator immediate uses sign-extended imm32", () => {
  const cpu = cpuFor([0x48,0xb8,0,0,0,0,0,0,0,0, 0x48,0x05,0xff,0xff,0xff,0xff, 0xf4]);
  cpu.run();
  assert.equal(cpu.getRegister(0, 64), 0xffffffffffffffffn);
});
