import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86RealModeCpu } from "../packages/x86-core/src/index.js";

function cpuFor(bytes, options = {}) {
  const memory = new GuestMemory({ initialPages: 257, maximumPages: 257 });
  memory.write(0x7c00, Uint8Array.from(bytes));
  return { memory, cpu: new X86RealModeCpu({ memory, ...options }) };
}

test("16-bit real-mode interpreter executes a small boot-sector instruction sequence", () => {
  const { memory, cpu } = cpuFor([
    0xb8,0x34,0x12,       // MOV AX,1234h
    0x40,                 // INC AX
    0xa3,0x00,0x05,       // MOV [0500h],AX
    0xa1,0x00,0x05,       // MOV AX,[0500h]
    0xf4                  // HLT
  ]);
  const result = cpu.run({ maxInstructions: 16 });
  assert.equal(result.state, "halted");
  assert.equal(result.instructionsExecuted, 5);
  assert.equal(cpu.ax, 0x1235);
  assert.deepEqual(memory.read(0x500, 2), Uint8Array.of(0x35, 0x12));
  assert.equal(cpu.ip, 0x7c0b);
});

test("real-mode byte registers and 16-bit XOR update the register and flags", () => {
  const { cpu } = cpuFor([
    0xb4,0x7f, // MOV AH,7Fh
    0xb0,0x01, // MOV AL,01h
    0x31,0xc0, // XOR AX,AX
    0xf4
  ]);
  const result = cpu.run({ maxInstructions: 8 });
  assert.equal(result.state, "halted");
  assert.equal(cpu.ax, 0);
  assert.equal(cpu.flags & 0x40, 0x40);
  assert.equal(cpu.flags & 0x04, 0x04);
});

test("real-mode stack and near control transfers preserve 16-bit return offsets", () => {
  const { cpu } = cpuFor([
    0xb8,0x78,0x56, // MOV AX,5678h
    0x50,           // PUSH AX
    0xb8,0,0,       // MOV AX,0
    0x5b,           // POP BX
    0xe8,0x02,0x00, // CALL +2 to RET
    0xeb,0x01,       // JMP over RET
    0xc3,            // RET
    0xf4             // HLT
  ]);
  const result = cpu.run({ maxInstructions: 16 });
  assert.equal(result.state, "halted");
  assert.equal(cpu.bx, 0x5678);
  assert.equal(cpu.sp, 0x7c00);
});

test("real-mode A20 gate wraps data addresses until enabled", () => {
  const { memory } = cpuFor([0xa1,0x10,0x00,0xf4]);
  memory.write(0, Uint8Array.of(0x11,0x11));
  memory.write(0x100000, Uint8Array.of(0x22,0x22));
  const wrapped = new X86RealModeCpu({ memory, ds: 0xffff, a20Enabled: false });
  const enabled = new X86RealModeCpu({ memory, ds: 0xffff, a20Enabled: true });
  wrapped.step();
  enabled.step();
  assert.equal(wrapped.ax, 0x1111);
  assert.equal(enabled.ax, 0x2222);
});

test("unsupported real-mode opcode faults without consuming its byte", () => {
  const { cpu } = cpuFor([0x0f]);
  assert.throws(() => cpu.step(), /Unsupported real-mode opcode 0x0f/);
  assert.equal(cpu.ip, 0x7c00);
  assert.equal(cpu.instructionsExecuted, 0);
});

test("real-mode INC and DEC preserve carry and set auxiliary/overflow flags", () => {
  const { cpu: increment } = cpuFor([0xb8,0xff,0x7f,0x40,0xf4]);
  increment.flags |= 1;
  increment.run({ maxInstructions: 2 });
  assert.equal(increment.ax, 0x8000);
  assert.equal(increment.flags & 1, 1);
  assert.equal(increment.flags & 0x800, 0x800);
  assert.equal(increment.flags & 0x10, 0x10);
  assert.equal(increment.flags & 0x80, 0x80);

  const { cpu: decrement } = cpuFor([0xb8,0x00,0x80,0x48,0xf4]);
  decrement.run({ maxInstructions: 2 });
  assert.equal(decrement.ax, 0x7fff);
  assert.equal(decrement.flags & 0x800, 0x800);
  assert.equal(decrement.flags & 0x10, 0x10);
});

test("real-mode INT and IRET use the IVT and restore FLAGS, CS, IP and SP", () => {
  const { memory, cpu } = cpuFor([0xcd,0x30,0xf4]);
  memory.write(0x30 * 4, Uint8Array.of(0x00,0x80,0x00,0x00));
  memory.write(0x8000, Uint8Array.of(0xb8,0xef,0xbe,0xcf)); // MOV AX,BEEFh; IRET
  cpu.flags |= 0x300;
  const result = cpu.run({ maxInstructions: 8 });
  assert.equal(result.state, "halted");
  assert.equal(result.instructionsExecuted, 4);
  assert.equal(cpu.ax, 0xbeef);
  assert.equal(cpu.cs, 0);
  assert.equal(cpu.ip, 0x7c03);
  assert.equal(cpu.sp, 0x7c00);
  assert.equal(cpu.flags & 0x300, 0x300);
});
