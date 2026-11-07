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


test("F7 NOT and NEG operate on register operands with correct flag behavior", () => {
  const notCpu = cpuFor([0xf7,0xd0], 32);
  notCpu.setRegister(0, 0x0fn, 32);
  const beforeFlags = notCpu.saveState().flags;
  notCpu.step();
  assert.equal(notCpu.getRegister(0,32), 0xfffffff0n);
  assert.equal(notCpu.saveState().flags, beforeFlags);

  const negCpu = cpuFor([0xf7,0xd8], 32);
  negCpu.setRegister(0, 5n, 32);
  negCpu.step();
  assert.equal(negCpu.getRegister(0,32), 0xfffffffBn);
  const flags = BigInt(negCpu.saveState().flags);
  assert.equal((flags & 1n) !== 0n, true);
  assert.equal((flags & (1n << 11n)) !== 0n, false);
});

test("F7 unsigned MUL returns low and high halves and sets overflow flags", () => {
  const cpu = cpuFor([0xf7,0xe3], 32);
  cpu.setRegister(0, 0xffffffffn, 32);
  cpu.setRegister(3, 2n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(0,32), 0xfffffffen);
  assert.equal(cpu.getRegister(2,32), 1n);
  const flags = BigInt(cpu.saveState().flags);
  assert.equal((flags & 1n) !== 0n, true);
  assert.equal((flags & (1n << 11n)) !== 0n, true);
});

test("F7 signed IMUL handles negative products and signed overflow", () => {
  const cpu = cpuFor([0xf7,0xeb], 32);
  cpu.setRegister(0, 0xfffffffdn, 32);
  cpu.setRegister(3, 7n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(0,32), 0xffffffebn);
  assert.equal(cpu.getRegister(2,32), 0xffffffffn);
  const flags = BigInt(cpu.saveState().flags);
  assert.equal((flags & 1n) !== 0n, false);
  assert.equal((flags & (1n << 11n)) !== 0n, false);
});


test("IMUL immediate forms sign-extend imm8 and compute signed products", () => {
  const cpu = cpuFor([0x6b,0xc8,0xf9], 32);
  cpu.setRegister(0, 6n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(1,32), 0xffffffd6n);
  const wide = cpuFor([0x69,0xc8,0x00,0x00,0x00,0x40], 32);
  wide.setRegister(0, 2n, 32);
  wide.step();
  assert.equal(wide.getRegister(1,32), 0x80000000n);
  const flags = BigInt(wide.saveState().flags);
  assert.equal((flags & 1n) !== 0n, true);
  assert.equal((flags & (1n << 11n)) !== 0n, true);
});


test("64-bit immediate IMUL sign-extends its 32-bit immediate", () => {
  const cpu = cpuFor([0x48,0x69,0xc8,0xff,0xff,0xff,0xff], 64);
  cpu.setRegister(0, 3n, 64);
  cpu.step();
  assert.equal(cpu.getRegister(1,64), 0xfffffffffffffffdn);
});


test("F7 unsigned DIV writes quotient and remainder", () => {
  const cpu = cpuFor([0xf7,0xf3], 32);
  cpu.setRegister(0, 100n, 32);
  cpu.setRegister(2, 0n, 32);
  cpu.setRegister(3, 7n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(0,32), 14n);
  assert.equal(cpu.getRegister(2,32), 2n);
});

test("F7 signed IDIV truncates toward zero and preserves signed remainder", () => {
  const cpu = cpuFor([0xf7,0xfb], 32);
  cpu.setRegister(0, 0xffffff9cn, 32);
  cpu.setRegister(2, 0xffffffffn, 32);
  cpu.setRegister(3, 7n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(0,32), 0xfffffff2n);
  assert.equal(cpu.getRegister(2,32), 0xfffffffen);
});

test("F7 DIV faults on zero divisor and quotient overflow", () => {
  const zero = cpuFor([0xf7,0xf3], 32);
  zero.setRegister(0, 10n, 32);
  zero.setRegister(3, 0n, 32);
  assert.throws(() => zero.step(), /divide by zero/i);

  const overflow = cpuFor([0xf7,0xf3], 32);
  overflow.setRegister(0, 0n, 32);
  overflow.setRegister(2, 1n, 32);
  overflow.setRegister(3, 1n, 32);
  assert.throws(() => overflow.step(), /quotient overflow/i);
});


test("MOVZX zero-extends byte and word register operands", () => {
  const byte = cpuFor([0x0f,0xb6,0xc3], 32);
  byte.setRegister(3, 0xabcdef80n, 32);
  byte.step();
  assert.equal(byte.getRegister(0,32), 0x80n);
  const word = cpuFor([0x0f,0xb7,0xc3], 32);
  word.setRegister(3, 0xabcdef80n, 32);
  word.step();
  assert.equal(word.getRegister(0,32), 0xef80n);
});

test("MOVSX sign-extends byte and word operands into 32-bit registers", () => {
  const byte = cpuFor([0x0f,0xbe,0xc3], 32);
  byte.setRegister(3, 0x80n, 32);
  byte.step();
  assert.equal(byte.getRegister(0,32), 0xffffff80n);
  const word = cpuFor([0x0f,0xbf,0xc3], 32);
  word.setRegister(3, 0x8001n, 32);
  word.step();
  assert.equal(word.getRegister(0,32), 0xffff8001n);
});

test("MOVSX and MOVZX support 64-bit destinations", () => {
  const signed = cpuFor([0x48,0x0f,0xbe,0xc3], 64);
  signed.setRegister(3, 0x80n, 32);
  signed.step();
  assert.equal(signed.getRegister(0,64), 0xffffffffffffff80n);
  const unsigned = cpuFor([0x48,0x0f,0xb7,0xc3], 64);
  unsigned.setRegister(3, 0xffff8001n, 32);
  unsigned.step();
  assert.equal(unsigned.getRegister(0,64), 0x8001n);
});


test("MOVSX and MOVZX load byte and word values from guest memory", () => {
  const cpu = cpuFor([0x0f,0xb6,0x03,0x0f,0xbe,0x0b], 32);
  cpu.setRegister(3, 256n, 32);
  cpu.memory.write(256, Uint8Array.of(0x80));
  cpu.step();
  assert.equal(cpu.getRegister(0,32), 0x80n);
  cpu.step();
  assert.equal(cpu.getRegister(1,32), 0xffffff80n);
});

test("MOVSXD sign-extends a 32-bit operand into a 64-bit register", () => {
  const cpu = cpuFor([0x48,0x63,0xc3], 64);
  cpu.setRegister(3, 0x80000001n, 32);
  cpu.step();
  assert.equal(cpu.getRegister(0,64), 0xffffffff80000001n);
});


test("FF group supports INC and DEC while preserving carry", () => {
  const inc = cpuFor([0xff,0xc0], 32);
  inc.setRegister(0, 0x7fffffffn, 32);
  inc.flags |= 1n;
  inc.step();
  assert.equal(inc.getRegister(0,32), 0x80000000n);
  assert.equal((inc.flags & 1n), 1n);
  assert.equal((inc.flags & (1n << 11n)) !== 0n, true);

  const dec = cpuFor([0xff,0xc8], 32);
  dec.setRegister(0, 0n, 32);
  dec.flags |= 1n;
  dec.step();
  assert.equal(dec.getRegister(0,32), 0xffffffffn);
  assert.equal((dec.flags & 1n), 1n);
});

test("FF group supports indirect CALL, JMP and PUSH", () => {
  const call = cpuFor([0xff,0xd0,0xf4,0xf4], 32);
  call.setRegister(0, 3n, 32);
  call.setRegister(4, 512n, 32);
  call.step();
  assert.equal(call.ip, 3);
  assert.equal(call.getRegister(4,32), 508n);
  assert.equal(call.memory.read(508,4)[0], 2);

  const jump = cpuFor([0xff,0xe0,0xf4,0xf4], 32);
  jump.setRegister(0, 3n, 32);
  jump.step();
  assert.equal(jump.ip, 3);

  const push = cpuFor([0xff,0xf0], 32);
  push.setRegister(0, 0x12345678n, 32);
  push.setRegister(4, 512n, 32);
  push.step();
  assert.equal(push.getRegister(4,32), 508n);
  assert.deepEqual([...push.memory.read(508,4)], [0x78,0x56,0x34,0x12]);
});

test("FF indirect control transfers reject out-of-range targets", () => {
  const cpu = cpuFor([0xff,0xe0], 32);
  cpu.setRegister(0, 4096n, 32);
  assert.throws(() => cpu.step(), /target outside memory/i);
});


test("F6 byte NOT and NEG preserve and update expected flags", () => {
  const notCpu = cpuFor([0xf6,0xd3], 32);
  notCpu.setRegister(3, 0x0fn, 8);
  const flags = notCpu.saveState().flags;
  notCpu.step();
  assert.equal(notCpu.getRegister(3,8), 0xf0n);
  assert.equal(notCpu.saveState().flags, flags);

  const negCpu = cpuFor([0xf6,0xdb], 32);
  negCpu.setRegister(3, 1n, 8);
  negCpu.step();
  assert.equal(negCpu.getRegister(3,8), 0xffn);
  assert.equal((negCpu.flags & 1n), 1n);
});

test("F6 byte MUL and IMUL return AX and report overflow", () => {
  const mul = cpuFor([0xf6,0xe3], 32);
  mul.setRegister(0, 20n, 8);
  mul.setRegister(3, 10n, 8);
  mul.step();
  assert.equal(mul.getRegister(0,16), 200n);
  assert.equal((mul.flags & 1n), 0n);

  const imul = cpuFor([0xf6,0xeb], 32);
  imul.setRegister(0, 0x80n, 8);
  imul.setRegister(3, 2n, 8);
  imul.step();
  assert.equal(imul.getRegister(0,16), 0xff00n);
  assert.equal((imul.flags & 1n), 1n);
});

test("F6 byte DIV and IDIV place quotient in AL and remainder in AH", () => {
  const div = cpuFor([0xf6,0xf3], 32);
  div.setRegister(0, 100n, 16);
  div.setRegister(3, 7n, 8);
  div.step();
  assert.equal(div.getRegister(0,8), 14n);
  assert.equal(div.getRegister(0,16) >> 8n, 2n);

  const idiv = cpuFor([0xf6,0xfb], 32);
  idiv.setRegister(0, 0xff9cn, 16);
  idiv.setRegister(3, 7n, 8);
  idiv.step();
  assert.equal(idiv.getRegister(0,8), 0xf2n);
  assert.equal(idiv.getRegister(0,16) >> 8n, 0xfen);
});

test("F6 byte division faults on zero and quotient overflow", () => {
  const zero = cpuFor([0xf6,0xf3], 32);
  zero.setRegister(0, 10n, 16);
  zero.setRegister(3, 0n, 8);
  assert.throws(() => zero.step(), /divide by zero/i);
  const overflow = cpuFor([0xf6,0xf3], 32);
  overflow.setRegister(0, 0x100n, 16);
  overflow.setRegister(3, 1n, 8);
  assert.throws(() => overflow.step(), /quotient overflow/i);
});


test("FF group honors operand-size override for INC and PUSH", () => {
  const inc = cpuFor([0x66,0xff,0xc0], 32);
  inc.setRegister(0, 0x1234ffffn, 32);
  inc.step();
  assert.equal(inc.getRegister(0,32), 0x12340000n);

  const push = cpuFor([0x66,0xff,0xf0], 64);
  push.setRegister(0, 0x1234n, 16);
  push.setRegister(4, 512n, 64);
  push.step();
  assert.equal(push.getRegister(4,64), 510n);
  assert.deepEqual([...push.memory.read(510,2)], [0x34,0x12]);
});


test("F6 and F7 TEST immediate update flags without modifying operands", () => {
  const byte = cpuFor([0xf6,0xc3,0x0f], 32);
  byte.setRegister(3, 0xf0n, 8);
  byte.step();
  assert.equal(byte.getRegister(3,8), 0xf0n);
  assert.equal((byte.flags & (1n << 6n)), 1n << 6n);

  const dword = cpuFor([0xf7,0xc3,0x0f,0x00,0x00,0x00], 32);
  dword.setRegister(3, 0x10n, 32);
  dword.step();
  assert.equal(dword.getRegister(3,32), 0x10n);
  assert.equal((dword.flags & (1n << 6n)), 1n << 6n);

  const qword = cpuFor([0x48,0xf7,0xc3,0x00,0x00,0x00,0x80], 64);
  qword.setRegister(3, 0xffffffff80000000n, 64);
  qword.step();
  assert.equal(qword.getRegister(3,64), 0xffffffff80000000n);
  assert.equal((qword.flags & (1n << 6n)), 0n);
});


test("CPU owns protected-mode segment state and restores cached selectors", () => {
  const cpu = cpuFor([0xf4], 32);
  cpu.memory.write(8, Uint8Array.from([0xff,0xff,0,0,0,0x9a,0xcf,0]));
  cpu.memory.write(16, Uint8Array.from([0xff,0xff,0,0,0,0x92,0xcf,0]));
  cpu.segments.installCodeSegment(0x08);
  cpu.segments.loadStack(0x10);
  cpu.segments.loadData("ds", 0x10);
  const snapshot = cpu.saveState();
  assert.equal(snapshot.segments.cs.selector, 0x08);
  assert.equal(snapshot.segments.ss.selector, 0x10);
  const restored = cpuFor([0xf4], 32);
  restored.loadState(snapshot);
  assert.equal(restored.segments.snapshot().cs.selector, 0x08);
  assert.equal(restored.segments.snapshot().ss.selector, 0x10);
  assert.equal(restored.segments.snapshot().ds.writable, true);
});


test("protected-mode MOV Sreg loads a validated data selector", () => {
  const cpu = cpuFor([0xb8,0x10,0,0,0,0x8e,0xd8,0xf4], 32);
  cpu.memory.write(16, Uint8Array.from([0xff,0xff,0,0,0,0x92,0xcf,0]));
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  cpu.run({ maxInstructions: 4 });
  assert.equal(cpu.segments.snapshot().ds.selector, 0x10);
  assert.equal(cpu.segments.snapshot().ds.writable, true);
});

test("LGDT and LIDT load bounded 32-bit pseudo-descriptors", () => {
  const cpu = cpuFor([0x0f,0x01,0x15,0x80,0,0,0,0x0f,0x01,0x1d,0x88,0,0,0,0xf4], 32);
  cpu.memory.write(0x80, Uint8Array.from([0x27,0,0x00,0x01,0,0]));
  cpu.memory.write(0x88, Uint8Array.from([0x1f,0,0x00,0x02,0,0]));
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  cpu.run({ maxInstructions: 3 });
  assert.equal(cpu.systemTables.gdtr.base, 0x100n);
  assert.equal(cpu.systemTables.gdtr.limit, 0x27);
  assert.equal(cpu.systemTables.idtr.base, 0x200n);
  assert.equal(cpu.systemTables.idtr.limit, 0x1f);
});

test("LLDT loads an LDT descriptor and LTR marks an available 32-bit TSS busy", () => {
  const cpu = cpuFor([0x0f,0x01,0x15,0x80,0,0,0,0xb8,0x10,0,0,0,0x0f,0x00,0xd0,0xb8,0x18,0,0,0,0x0f,0x00,0xd8,0xf4], 32);
  cpu.memory.write(0x80, Uint8Array.from([0x27,0,0x00,0x01,0,0]));
  cpu.memory.write(0x108, Uint8Array.from([0x0f,0,0x00,0x03,0,0x82,0,0]));
  cpu.memory.write(0x110, Uint8Array.from([0x67,0,0x00,0x04,0,0x89,0,0]));
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  cpu.run({ maxInstructions: 6 });
  assert.equal(cpu.systemTables.ldtr.selector, 0x10);
  assert.equal(cpu.systemTables.task.selector, 0x18);
  assert.equal(cpu.systemTables.task.busy, true);
  assert.equal(cpu.memory.read(0x115, 1)[0] & 0x0f, 0x0b);
});


test("32-bit protected-mode far JMP loads CS and fetches through its segment cache", () => {
  const cpu = cpuFor([0xea,0x10,0,0,0,0x08,0x00,0xf4], 32);
  cpu.memory.write(8, Uint8Array.from([0xff,0xff,0,0,0,0x9a,0xcf,0]));
  cpu.memory.write(0x10, Uint8Array.of(0xf4));
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  cpu.run({ maxInstructions: 2 });
  assert.equal(cpu.segments.snapshot().cs.selector, 0x08);
  assert.equal(cpu.ip, 0x11);
  assert.equal(cpu.halted, true);
});
