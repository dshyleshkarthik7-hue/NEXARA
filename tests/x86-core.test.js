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

test("supports memory-indirect MOV using a base register", () => {
  const cpu = cpuFor([0x89,0x08, 0x8b,0x18, 0xf4], 32);
  cpu.setRegister(0, 128n, 32);
  cpu.setRegister(1, 0xdecafbadn, 32);
  cpu.run();
  assert.equal(cpu.getRegister(3, 32), 0xdecafbadn);
  assert.deepEqual([...cpu.memory.read(128, 4)], [0xad,0xfb,0xca,0xde]);
});

test("supports push and pop with a bounded guest stack", () => {
  const cpu = cpuFor([0xb8,0x78,0x56,0x34,0x12, 0x50, 0x5b, 0xf4], 32);
  cpu.setRegister(4, 512n, 32);
  cpu.run();
  assert.equal(cpu.getRegister(3, 32), 0x12345678n);
  assert.equal(cpu.getRegister(4, 32), 512n);
});

test("supports compare and conditional jump", () => {
  const cpu = cpuFor([0xb8,1,0,0,0, 0x3d,1,0,0,0, 0x74,0x01, 0xf4, 0xf4], 32);
  cpu.run();
  assert.equal(cpu.halted, true);
  assert.equal(cpu.ip, 14);
});

test("rejects invalid memory accesses and unsupported opcodes", () => {
  const cpu = cpuFor([0x8b,0x00], 32);
  cpu.setRegister(0, 4095n, 32);
  assert.throws(() => cpu.step(), RangeError);
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

test("CALL and RET transfer control through an absolute return address", () => {
  const cpu = cpuFor([
    0xe8,0x02,0x00,0x00,0x00, // call +2 -> address 7
    0xf4,                   // halt after return
    0x90,                   // padding
    0xb8,0x2a,0,0,0,        // mov eax,42
    0xc3                    // ret
  ], 32);
  cpu.setRegister(4, 512n, 32);
  const result = cpu.run();
  assert.equal(result.state, "halted");
  assert.equal(cpu.getRegister(0, 32), 42n);
  assert.equal(cpu.getRegister(4, 32), 512n);
  assert.equal(cpu.ip, 6);
});

test("conditional parity branches use the low-byte parity flag", () => {
  const cpu = cpuFor([
    0xb8,0x03,0,0,0, // mov eax,3 (two set bits, even parity)
    0x3d,0x03,0,0,0, // cmp eax,3
    0x7a,0x01,       // jp +1
    0xf4,            // skipped
    0xf4             // halt
  ], 32);
  cpu.run();
  assert.equal(cpu.halted, true);
  assert.equal(cpu.ip, 14);
});

test("failed push leaves stack pointer unchanged", () => {
  const cpu = cpuFor([0x50], 32);
  cpu.setRegister(4, 2n, 32);
  assert.throws(() => cpu.step(), RangeError);
  assert.equal(cpu.getRegister(4, 32), 2n);
});
