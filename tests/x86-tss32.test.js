import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86Tss32 } from "../packages/x86-core/src/task-state.js";

test("reads and writes the ring 0-2 privilege stacks in a bounded TSS", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const tss = new X86Tss32(memory, { base: 0x200, limit: 0x67 });
  assert.deepEqual(tss.setRingStack(0, { esp: 0x1800, ss: 0x10 }), { esp: 0x1800, ss: 0x10 });
  assert.deepEqual(tss.setRingStack(1, { esp: 0x1700, ss: 0x18 }), { esp: 0x1700, ss: 0x18 });
  assert.deepEqual(tss.setRingStack(2, { esp: 0x1600, ss: 0x20 }), { esp: 0x1600, ss: 0x20 });
});

test("enforces the TSS I/O bitmap for every byte of an IN/OUT width", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const tss = new X86Tss32(memory, { base: 0x200, limit: 0x1ff });
  tss.ioMapBase = 104;
  // Bitmap begins at TSS base + 104; a zero bit permits the corresponding port.
  memory.write(0x200 + 104, Uint8Array.of(0, 0b00000100));
  assert.equal(tss.allowsIo(0, 8), true);
  assert.equal(tss.allowsIo(8, 8), true);
  assert.equal(tss.allowsIo(10, 8), false);
  assert.equal(tss.allowsIo(7, 16), true);
  assert.throws(() => tss.allowsIo(0xffff, 16), /Invalid TSS I\/O/);
});

test("treats a missing or truncated I/O bitmap as denying access", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  const tss = new X86Tss32(memory, { base: 0x100, limit: 0x67 });
  tss.ioMapBase = 0x68;
  assert.equal(tss.allowsIo(0x80), false);
  assert.throws(() => new X86Tss32(memory, { base: 0x1fff, limit: 0x67 }), /exceeds/);
  assert.throws(() => new X86Tss32(memory, { base: 0, limit: 0x66 }), /104-byte/);
});

test("rejects invalid privilege rings and out-of-range stack fields", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  const tss = new X86Tss32(memory, { base: 0x100, limit: 0x67 });
  assert.throws(() => tss.getRingStack(3), /ring/);
  assert.throws(() => tss.setRingStack(0, { esp: -1, ss: 0x10 }), /32-bit/);
  assert.throws(() => tss.setRingStack(0, { esp: 0x1000, ss: 0x10000 }), /16-bit/);
});

test("reads and writes the 32-bit hardware task backlink and saved register image", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const tss = new X86Tss32(memory, { base: 0x200, limit: 0x67 });
  tss.backlink = 0x28;
  assert.equal(tss.backlink, 0x28);
  const state = {
    eip: 0x12345678,
    eflags: 0x202,
    registers: { eax: 1, ecx: 2, edx: 3, ebx: 4, esp: 0x1800, ebp: 6, esi: 7, edi: 8 },
    segments: { es: 0x10, cs: 0x08, ss: 0x10, ds: 0x10, fs: 0, gs: 0, ldt: 0 }
  };
  assert.deepEqual(tss.setTaskState(state), state);
  assert.deepEqual(tss.getTaskState(), state);
});

test("validates the entire task register image before modifying TSS memory", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const tss = new X86Tss32(memory, { base: 0x200, limit: 0x67 });
  const before = memory.read(0x200, 104);
  const state = {
    eip: 0x1234, eflags: 2,
    registers: { eax: 1, ecx: 2, edx: 3, ebx: 4, esp: 5, ebp: 6, esi: 7, edi: 8 },
    segments: { es: 0x10, cs: 0x08, ss: 0x10, ds: 0x10, fs: 0, gs: 0, ldt: 0x10000 }
  };
  assert.throws(() => tss.setTaskState(state), /16-bit/);
  assert.deepEqual(memory.read(0x200, 104), before);
  assert.throws(() => tss.setTaskState({ ...state, eip: -1 }), /32-bit/);
});
