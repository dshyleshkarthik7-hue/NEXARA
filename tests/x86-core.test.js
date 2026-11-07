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

test("LEA computes a base-plus-displacement effective address", () => {
  const cpu = cpuFor([0x8d,0x48,0x04,0xf4], 32);
  cpu.setRegister(0, 120n, 32);
  cpu.run();
  assert.equal(cpu.getRegister(1, 32), 124n);
});

test("C7 writes an immediate to guest memory", () => {
  const cpu = cpuFor([0xc7,0x00,0x78,0x56,0x34,0x12,0xf4], 32);
  cpu.setRegister(0, 256n, 32);
  cpu.run();
  assert.deepEqual([...cpu.memory.read(256, 4)], [0x78,0x56,0x34,0x12]);
});

test("group-1 immediate instructions support ADD SUB XOR and CMP", () => {
  const cpu = cpuFor([
    0xb8,10,0,0,0,
    0x83,0xc0,5,
    0x83,0xe8,3,
    0x83,0xf0,4,
    0x83,0xf8,8,
    0x74,0x01,
    0xf4,0xf4
  ], 32);
  cpu.run();
  assert.equal(cpu.getRegister(0, 32), 8n);
  assert.equal(cpu.halted, true);
});

test("unsupported group-1 extensions fault", () => {
  const cpu = cpuFor([0x83,0xd0,0x01], 32);
  assert.throws(() => cpu.step(), CpuFault);
});

test("register AND OR and TEST update values and zero flag", () => {
  const cpu = cpuFor([
    0xb8,0x0f,0,0,0, // eax=15
    0xbb,0x03,0,0,0, // ebx=3
    0x21,0xd8,       // and eax,ebx -> 3
    0x09,0xd8,       // or eax,ebx -> 3
    0x85,0xd8,       // test eax,ebx -> 3, flags only
    0x3d,0x03,0,0,0, // cmp eax,3
    0x74,0x01,
    0xf4,0xf4
  ], 32);
  cpu.run();
  assert.equal(cpu.getRegister(0, 32), 3n);
  assert.equal(cpu.halted, true);
});

test("accumulator AND and OR immediate operations execute", () => {
  const cpu = cpuFor([
    0xb8,0x0f,0,0,0,
    0x25,0x06,0,0,0,
    0x0d,0x08,0,0,0,
    0xf4
  ], 32);
  cpu.run();
  assert.equal(cpu.getRegister(0, 32), 0x0en);
});

test("group-1 immediate OR and AND variants execute", () => {
  const cpu = cpuFor([
    0xb8,0x0f,0,0,0,
    0x83,0xc8,0x30,
    0x83,0xe0,0x3c,
    0xf4
  ], 32);
  cpu.run();
  assert.equal(cpu.getRegister(0, 32), 0x3cn);
});

test("CPU save state restores registers flags instruction pointer and memory", () => {
  const cpu = cpuFor([0xb8,0x2a,0,0,0,0xf4], 32);
  cpu.setRegister(4, 512n, 32);
  cpu.memory.writeU32(128, 0xdecafbad);
  cpu.step();
  const state = cpu.saveState();
  cpu.setRegister(0, 99n, 32);
  cpu.memory.writeU32(128, 0);
  cpu.step();
  cpu.loadState(state);
  assert.equal(cpu.getRegister(0, 32), 42n);
  assert.equal(cpu.getRegister(4, 32), 512n);
  assert.equal(cpu.ip, 5);
  assert.equal(cpu.halted, false);
  assert.equal(cpu.memory.readU32(128), 0xdecafbad);
});

test("CPU rejects incompatible or malformed save states without changing state", () => {
  const cpu = cpuFor([0xf4], 32);
  const before = cpu.saveState();
  assert.throws(() => cpu.loadState({ ...before, mode: 64 }), TypeError);
  assert.throws(() => cpu.loadState({ ...before, registers: ["not-a-register"] }), TypeError);
  assert.equal(cpu.ip, before.ip);
  assert.equal(cpu.halted, before.halted);
});


test("CPUID reports NEXARA vendor identity and only implemented base features", () => {
  const cpu = cpuFor([0x0f,0xa2,0x0f,0xa2,0xf4], 64);
  cpu.setRegister(0, 0n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(0, 32), 1n);
  const vendor = [cpu.getRegister(3,32),cpu.getRegister(2,32),cpu.getRegister(1,32)]
    .map(value => String.fromCharCode(...Array.from({length:4},(_,i)=>Number((value >> BigInt(i*8)) & 255n))))
    .join("");
  assert.equal(vendor, "NEXARA      ");
  cpu.setRegister(0, 1n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(1, 32), 0n);
  assert.equal(cpu.getRegister(2, 32), 1n << 4n);
  assert.equal(cpu.getRegister(3, 32), 0n);
});

test("CPUID advertises long mode only for the 64-bit execution mode", () => {
  const cpu64 = cpuFor([0x0f,0xa2], 64);
  cpu64.setRegister(0, 0x80000001n, 32);
  cpu64.step();
  assert.equal(cpu64.getRegister(2, 32), 1n << 29n);
  const cpu32 = cpuFor([0x0f,0xa2], 32);
  cpu32.setRegister(0, 0x80000001n, 32);
  cpu32.step();
  assert.equal(cpu32.getRegister(2, 32), 0n);
});

test("RDTSC returns the deterministic instruction counter", () => {
  const cpu = cpuFor([0x90,0x0f,0x31,0xf4], 64);
  cpu.step();
  cpu.step();
  assert.equal(cpu.getRegister(0, 32), 1n);
  assert.equal(cpu.getRegister(2, 32), 0n);
});


test("supports immediate SHL and updates carry, overflow and sign flags", () => {
  const cpu = cpuFor([0xc1,0xe0,0x01,0xf4], 32);
  cpu.setRegister(0, 0x40000000n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(0,32), 0x80000000n);
  const flags = BigInt(cpu.saveState().flags);
  assert.equal((flags & (1n << 11n)) !== 0n, true);
  assert.equal((flags & (1n << 7n)) !== 0n, true);
});

test("supports one-bit SHR and SAR with arithmetic sign extension", () => {
  const shr = cpuFor([0xd1,0xe8], 32);
  shr.setRegister(0, 0x80000001n, 32);
  shr.step();
  assert.equal(shr.getRegister(0,32), 0x40000000n);
  assert.equal((BigInt(shr.saveState().flags) & (1n << 0n)) !== 0n, true);

  const sar = cpuFor([0xd1,0xf8], 32);
  sar.setRegister(0, 0x80000000n, 32);
  sar.step();
  assert.equal(sar.getRegister(0,32), 0xc0000000n);
});

test("supports 64-bit immediate shifts and treats a zero count as a no-op", () => {
  const cpu = cpuFor([0x48,0xc1,0xe0,0x01,0xc1,0xe0,0x00], 64);
  cpu.setRegister(0, 0x4000000000000000n, 64);
  cpu.step();
  assert.equal(cpu.getRegister(0,64), 0x8000000000000000n);
  const flags = cpu.saveState().flags;
  cpu.step();
  assert.equal(cpu.getRegister(0,64), 0x8000000000000000n);
  assert.equal(cpu.saveState().flags, flags);
});


test("supports signed two-operand IMUL and negative products", () => {
  const cpu = cpuFor([0x0f,0xaf,0xc8], 32);
  cpu.setRegister(0, 0xfffffffdn, 32);
  cpu.setRegister(1, 7n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(1,32), 0xffffffebn);
  const flags = BigInt(cpu.saveState().flags);
  assert.equal((flags & (1n << 0n)) !== 0n, false);
  assert.equal((flags & (1n << 11n)) !== 0n, false);
});

test("IMUL sets carry and overflow when the signed product is truncated", () => {
  const cpu = cpuFor([0x0f,0xaf,0xc8], 32);
  cpu.setRegister(0, 0x7fffffffn, 32);
  cpu.setRegister(1, 2n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(1,32), 0xfffffffen);
  const flags = BigInt(cpu.saveState().flags);
  assert.equal((flags & (1n << 0n)) !== 0n, true);
  assert.equal((flags & (1n << 11n)) !== 0n, true);
});

test("supports 64-bit signed IMUL with REX.W", () => {
  const cpu = cpuFor([0x48,0x0f,0xaf,0xc8], 64);
  cpu.setRegister(0, 0xfffffffffffffffen, 64);
  cpu.setRegister(1, 7n, 64);
  cpu.step();
  assert.equal(cpu.getRegister(1,64), 0xfffffffffffffff2n);
});
