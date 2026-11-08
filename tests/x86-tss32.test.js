import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86LegacyPaging32 } from "../packages/runtime/src/mmu.js";
import { X86Tss32 } from "../packages/x86-core/src/task-state.js";
import { X86Cpu } from "../packages/x86-core/src/index.js";

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

function setupTaskCpu() {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const cpu = new X86Cpu({ memory, mode: 32, instructionPointer: 0x600 });
  const gdtBase = 0x100;
  const putDescriptor = (index, access) => memory.write(gdtBase + index * 8,
    Uint8Array.from([0xff, 0xff, 0, 0, 0, access, 0xcf, 0]));
  putDescriptor(1, 0x9a); // ring-0 code
  putDescriptor(2, 0x92); // ring-0 data
  putDescriptor(3, 0xfa); // ring-3 code
  putDescriptor(4, 0xf2); // ring-3 data
  cpu.systemTables.loadGdtr(gdtBase, 0x27);
  cpu.gdt.setRegister(gdtBase, 0x27);
  cpu.systemTables.loadTaskRegister({ selector: 0x28, base: 0x500, limit: 0x67, present: true, busy: true, usable: true });
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  return { cpu, memory, tss: new X86Tss32(memory, { base: 0x500, limit: 0x67 }) };
}

test("CPU saves its live 32-bit register and segment context into the active TSS", () => {
  const { cpu, tss } = setupTaskCpu();
  cpu.segments.setCpl(3);
  cpu.segments.installCodeSegment(0x1b);
  cpu.segments.loadStack(0x23);
  cpu.segments.loadData("ds", 0x23);
  cpu.setRegister(0, 0x11, 32);
  cpu.setRegister(1, 0x22, 32);
  cpu.setRegister(4, 0x1f00, 32);
  cpu.ip = 0x650;
  cpu.flags = 0x202n;
  cpu.saveTaskStateToTss();
  const state = tss.getTaskState();
  assert.equal(state.eip, 0x650);
  assert.equal(state.eflags, 0x202);
  assert.equal(state.registers.eax, 0x11);
  assert.equal(state.registers.ecx, 0x22);
  assert.equal(state.registers.esp, 0x1f00);
  assert.deepEqual(state.segments, { es: 0, cs: 0x1b, ss: 0x23, ds: 0x23, fs: 0, gs: 0, ldt: 0 });
});

test("CPU restores a TSS image only after validating all segment selectors", () => {
  const { cpu, tss } = setupTaskCpu();
  tss.setTaskState({
    eip: 0x650, eflags: 0x202,
    registers: { eax: 0x11, ecx: 0x22, edx: 3, ebx: 4, esp: 0x1f00, ebp: 6, esi: 7, edi: 8 },
    segments: { es: 0x23, cs: 0x1b, ss: 0x23, ds: 0x23, fs: 0, gs: 0, ldt: 0 }
  });
  const result = cpu.loadTaskStateFromTss();
  assert.equal(result.ip, 0x650);
  assert.equal(cpu.segments.cpl, 3);
  assert.equal(cpu.segments.registers.cs.selector, 0x1b);
  assert.equal(cpu.segments.registers.ss.selector, 0x23);
  assert.equal(cpu.getRegister(0, 32), 0x11n);
  assert.equal(cpu.getRegister(4, 32), 0x1f00n);
  const before = { ip: cpu.ip, eax: cpu.getRegister(0, 32), cpl: cpu.segments.cpl };
  tss.setTaskState({
    eip: 0x650, eflags: 0x202,
    registers: { eax: 0x99, ecx: 0, edx: 0, ebx: 0, esp: 0x1f00, ebp: 0, esi: 0, edi: 0 },
    segments: { es: 0x23, cs: 0x23, ss: 0x23, ds: 0x23, fs: 0, gs: 0, ldt: 0 }
  });
  assert.throws(() => cpu.loadTaskStateFromTss(), /CS requires a code segment/);
  assert.equal(cpu.ip, before.ip);
  assert.equal(cpu.getRegister(0, 32), before.eax);
  assert.equal(cpu.segments.cpl, before.cpl);
});

test("CPU task-state save and restore refuse paging until TSS linear accesses are implemented", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const paging = new X86LegacyPaging32(memory);
  const cpu = new X86Cpu({ memory, mode: 32, legacyPaging32: paging, instructionPointer: 0x600 });
  cpu.systemTables.loadTaskRegister({ selector: 0x28, base: 0x500, limit: 0x67, present: true, busy: true, usable: true });
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  const put32 = (address, value) => memory.write(address, Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255));
  put32(0x1000, 0x1803); // page directory entry
  put32(0x1800, 0x0003); // page table entry
  cpu.writeControlRegister(3, 0x1000n);
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 0x80000000n);
  assert.throws(() => cpu.saveTaskStateToTss(), /paging enabled/);
  assert.throws(() => cpu.loadTaskStateFromTss(), /paging enabled/);
});
