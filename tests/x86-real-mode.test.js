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

test("real-mode CMP and conditional branches evaluate unsigned and signed flags", () => {
  const { cpu } = cpuFor([
    0xb8,0x34,0x12,       // MOV AX,1234h
    0x3d,0x34,0x12,       // CMP AX,1234h
    0x74,0x03,            // JE over MOV BX,1
    0xbb,0x01,0x00,
    0xf4
  ]);
  cpu.run({ maxInstructions: 8 });
  assert.equal(cpu.bx, 0);
  assert.equal(cpu.flags & 0x40, 0x40);

  const { cpu: unsigned } = cpuFor([
    0xb8,0x00,0x00,       // MOV AX,0
    0x3d,0x01,0x00,       // CMP AX,1 (borrow)
    0x72,0x03,            // JB over MOV BX,1
    0xbb,0x01,0x00,
    0xf4
  ]);
  unsigned.run({ maxInstructions: 8 });
  assert.equal(unsigned.bx, 0);
  assert.equal(unsigned.flags & 1, 1);
});

test("real-mode LOOP decrements CX and repeats a short instruction body", () => {
  const { cpu } = cpuFor([
    0xb9,0x03,0x00, // MOV CX,3
    0x43,           // INC BX
    0xe2,0xfd,      // LOOP back to INC BX
    0xf4
  ]);
  const result = cpu.run({ maxInstructions: 16 });
  assert.equal(result.state, "halted");
  assert.equal(cpu.bx, 3);
  assert.equal(cpu.cx, 0);
  assert.equal(result.instructionsExecuted, 8);
});

test("real-mode CLD and STD update only the direction flag", () => {
  const { cpu } = cpuFor([0xfd,0xfc,0xf4]);
  cpu.step();
  assert.equal(cpu.flags & 0x400, 0x400);
  cpu.step();
  assert.equal(cpu.flags & 0x400, 0);
});

test("real-mode ModRM MOV and XOR support DS and SS effective addresses", () => {
  const { memory, cpu } = cpuFor([
    0xbb,0x00,0x05,       // MOV BX,0500h
    0xbe,0x02,0x00,       // MOV SI,0002h
    0xb8,0x34,0x12,       // MOV AX,1234h
    0x89,0x00,            // MOV [BX+SI],AX
    0x8b,0x08,            // MOV CX,[BX+SI]
    0x31,0x08,            // XOR [BX+SI],CX
    0x8b,0x10,            // MOV DX,[BX+SI]
    0xbd,0x00,0x06,       // MOV BP,0600h
    0x89,0x46,0x02,       // MOV [BP+2],AX (SS default)
    0x8b,0x56,0x02,       // MOV DX,[BP+2]
    0xf4
  ], { ss: 0x6000 });
  const result = cpu.run({ maxInstructions: 16 });
  assert.equal(result.state, "halted");
  assert.equal(cpu.cx, 0x1234);
  assert.equal(cpu.dx, 0x1234);
  assert.deepEqual(memory.read(0x502, 2), Uint8Array.of(0, 0));
  assert.deepEqual(memory.read(0x60602, 2), Uint8Array.of(0x34, 0x12));
});

test("real-mode REP MOVSB and STD direction copy bytes in the requested direction", () => {
  const { memory, cpu } = cpuFor([
    0xbe,0x00,0x06,       // MOV SI,0600h
    0xbf,0x00,0x07,       // MOV DI,0700h
    0xb9,0x03,0x00,       // MOV CX,3
    0xf3,0xa4,            // REP MOVSB
    0xbf,0x02,0x07,       // MOV DI,0702h
    0xbe,0x02,0x06,       // MOV SI,0602h
    0xfd,                 // STD
    0xa4,                 // MOVSB backwards
    0xf4
  ]);
  memory.write(0x600, Uint8Array.of(0x11,0x22,0x33));
  const result = cpu.run({ maxInstructions: 16 });
  assert.equal(result.state, "halted");
  assert.deepEqual(memory.read(0x700, 3), Uint8Array.of(0x11,0x22,0x33));
  assert.equal(cpu.si, 0x601);
  assert.equal(cpu.di, 0x701);
  assert.equal(cpu.cx, 0);
  assert.equal(cpu.flags & 0x400, 0x400);
});

test("real-mode REP STOSW and LODSW transfer words and update indices", () => {
  const { memory, cpu } = cpuFor([
    0xb8,0xcd,0xab,       // MOV AX,ABCDh
    0xbf,0x00,0x08,       // MOV DI,0800h
    0xb9,0x02,0x00,       // MOV CX,2
    0xf3,0xab,            // REP STOSW
    0xbe,0x00,0x08,       // MOV SI,0800h
    0xad,                 // LODSW
    0xf4
  ]);
  const result = cpu.run({ maxInstructions: 16 });
  assert.equal(result.state, "halted");
  assert.deepEqual(memory.read(0x800, 4), Uint8Array.of(0xcd,0xab,0xcd,0xab));
  assert.equal(cpu.ax, 0xabcd);
  assert.equal(cpu.si, 0x802);
  assert.equal(cpu.di, 0x804);
});
