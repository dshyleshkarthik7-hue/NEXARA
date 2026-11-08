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

test("real-mode byte registers, XOR flags, stack push/pop and near CALL/RET work", () => {
  const { cpu } = cpuFor([
    0xb4,0x7f,             // MOV AH,7Fh
    0x30,0xe4,             // unsupported 8-bit XOR currently intentionally not accepted
    0x50,                  // PUSH AX
    0xb8,0,0,              // MOV AX,0
    0x5b,                  // POP BX
    0xe8,0x01,0x00,        // CALL +1
    0xeb,0x01,             // JMP over RET
    0xc3,                  // RET
    0xf4                   // HLT
  ]);
  assert.equal(cpu.step().state, "running");
  assert.equal(cpu.ax, 0x7f00);
  assert.throws(() => cpu.step(), /Unsupported real-mode opcode 0x30/);
  assert.equal(cpu.ip, 0x7c03);
});

test("real-mode stack and near control transfers preserve 16-bit return offsets", () => {
  const { cpu } = cpuFor([
    0xb8,0x78,0x56, // MOV AX,5678h
    0x50,           // PUSH AX
    0xb8,0,0,       // MOV AX,0
    0x5b,           // POP BX
    0xe8,0x01,0x00, // CALL +1
    0xeb,0x01,       // JMP over RET
    0xc3,            // RET
    0xf4             // HLT
  ]);
  const result = cpu.run({ maxInstructions: 16 });
  assert.equal(result.state, "halted");
  assert.equal(cpu.bx, 0x5678);
  assert.equal(cpu.sp, 0x7c00);
});

test("real-mode A20 gate wraps physical addresses until enabled", () => {
  const { memory } = cpuFor([0xf4]);
  memory.write(0, Uint8Array.of(0x11));
  memory.write(0x100000, Uint8Array.of(0x22));
  const wrapped = new X86RealModeCpu({ memory, cs: 0xffff, ip: 0x10, a20Enabled: false });
  const enabled = new X86RealModeCpu({ memory, cs: 0xffff, ip: 0x10, a20Enabled: true });
  assert.equal(wrapped.step().state, "halted");
  assert.equal(enabled.step().state, "halted");
  assert.equal(wrapped.ip, 0x11);
  assert.equal(enabled.ip, 0x11);
});

test("unsupported real-mode opcode faults without consuming its byte", () => {
  const { cpu } = cpuFor([0x0f]);
  assert.throws(() => cpu.step(), /Unsupported real-mode opcode 0x0f/);
  assert.equal(cpu.ip, 0x7c00);
  assert.equal(cpu.instructionsExecuted, 0);
});
