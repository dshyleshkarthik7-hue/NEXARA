import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86LegacyPaging32 } from "../packages/runtime/src/mmu.js";
import { X86Cpu } from "../packages/x86-core/src/index.js";

function setup({ ring0Stack = 0x1800, kernelStackSelector = 0x10, absentKernelCode = false, paged = false } = {}) {
  const memory = new GuestMemory({ initialPages: paged ? 5 : 2, maximumPages: paged ? 5 : 2 });
  const paging = paged ? new X86LegacyPaging32(memory) : null;
  const cpu = new X86Cpu({ memory, mode: 32, instructionPointer: 0x600, legacyPaging32: paging });
  const gdtBase = 0x100;
  const idtBase = 0x900;
  const putDescriptor = (index, { base = 0, limit = 0xfffff, access, flags = 0xc } = {}) => {
    const bytes = new Uint8Array(8);
    bytes[0] = limit & 0xff; bytes[1] = (limit >>> 8) & 0xff;
    bytes[2] = base & 0xff; bytes[3] = (base >>> 8) & 0xff; bytes[4] = (base >>> 16) & 0xff;
    bytes[5] = access; bytes[6] = ((limit >>> 16) & 0x0f) | (flags << 4); bytes[7] = (base >>> 24) & 0xff;
    memory.write(gdtBase + index * 8, bytes);
  };
  putDescriptor(1, { access: absentKernelCode ? 0x1a : 0x9a }); // ring 0 code
  putDescriptor(2, { access: 0x92 }); // ring 0 data
  putDescriptor(3, { access: 0xfa }); // ring 3 code
  putDescriptor(4, { access: 0xf2 }); // ring 3 data
  putDescriptor(5, { base: 0x500, limit: 0x67, access: 0x89, flags: 0 });
  cpu.systemTables.loadGdtr(gdtBase, 0x2f);
  cpu.systemTables.loadIdtr(idtBase, 0x7ff);
  cpu.gdt.setRegister(gdtBase, 0x2f);
  cpu.idt.setRegister(idtBase, 0x7ff);
  const gate = new Uint8Array(8);
  gate[0] = 0x00; gate[1] = 0x07; // handler offset 0x700
  gate[2] = 0x08; gate[3] = 0x00;
  gate[5] = 0xee; // present, DPL3, 32-bit interrupt gate
  memory.write(idtBase + 0x80 * 8, gate);
  memory.write(0x600, Uint8Array.of(0xcd, 0x80, 0x90));
  memory.write(0x700, Uint8Array.of(0xcf)); // IRET
  cpu.systemTables.loadTaskRegister({ selector: 0x28, base: 0x500, limit: 0x67, present: true, busy: true, usable: true });
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  memory.write(0x504, Uint8Array.of(ring0Stack & 0xff, (ring0Stack >>> 8) & 0xff, 0, 0));
  memory.write(0x508, Uint8Array.of(kernelStackSelector & 0xff, (kernelStackSelector >>> 8) & 0xff));
  cpu.segments.setCpl(3);
  cpu.segments.loadStack(0x23);
  cpu.segments.installCodeSegment(0x1b);
  cpu.setRegister(4, 0x1f00, 32);
  cpu.flags = 0x202n;
  if (paged) {
    // Linear 0x0000-0x1fff are user pages; 0x2000-0x2fff is supervisor-only.
    // Page directory and page table live above the mapped test region.
    const put32 = (address, value) => memory.write(address, Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255));
    put32(0x3000, 0x4007);
    put32(0x4000, 0x0007);
    put32(0x4004, 0x1007);
    put32(0x4008, 0x2003);
    cpu.writeControlRegister(3, 0x3000n);
    cpu.writeControlRegister(0, cpu.readControlRegister(0) | 0x80000000n);
  }
  return { cpu, memory };
}

test("INT switches from ring 3 to the TSS ring-0 stack and builds the privilege frame", () => {
  const { cpu, memory } = setup();
  cpu.step();
  assert.equal(cpu.segments.cpl, 0);
  assert.equal(cpu.segments.registers.cs.selector, 0x08);
  assert.equal(cpu.segments.registers.ss.selector, 0x10);
  assert.equal(cpu.getRegister(4, 32), 0x1800n - 20n);
  assert.equal(cpu.ip, 0x700);
  const frame = new DataView(memory.read(0x1800 - 20, 20).buffer);
  assert.equal(frame.getUint32(0, true), 0x602);
  assert.equal(frame.getUint32(4, true), 0x1b);
  assert.equal(frame.getUint32(12, true), 0x1f00);
  assert.equal(frame.getUint32(16, true), 0x23);
});

test("IRET restores outer-ring CS, SS, ESP, CPL and EIP", () => {
  const { cpu } = setup();
  cpu.step();
  cpu.segments.loadData("ds", 0x10);
  cpu.step();
  assert.equal(cpu.segments.cpl, 3);
  assert.equal(cpu.segments.registers.cs.selector, 0x1b);
  assert.equal(cpu.segments.registers.ss.selector, 0x23);
  assert.equal(cpu.segments.registers.ds.selector, 0);
  assert.equal(cpu.getRegister(4, 32), 0x1f00n);
  assert.equal(cpu.ip, 0x602);
});

test("invalid TSS stack selector leaves privilege state and stack unchanged", () => {
  const { cpu } = setup({ kernelStackSelector: 0x18 });
  const before = cpu.getRegister(4, 32);
  assert.throws(() => cpu.step(), /target SS|writable data|privilege/i);
  assert.equal(cpu.segments.cpl, 3);
  assert.equal(cpu.segments.registers.ss.selector, 0x23);
  assert.equal(cpu.getRegister(4, 32), before);
});

test("failed privilege-stack write does not partially switch CS, SS, CPL or ESP", () => {
  const { cpu } = setup({ ring0Stack: 8 });
  const before = cpu.getRegister(4, 32);
  assert.throws(() => cpu.step(), /underflows|stack/i);
  assert.equal(cpu.segments.cpl, 3);
  assert.equal(cpu.segments.registers.cs.selector, 0x1b);
  assert.equal(cpu.segments.registers.ss.selector, 0x23);
  assert.equal(cpu.getRegister(4, 32), before);
});

test("absent ring-3 code descriptors cannot be installed", () => {
  const { cpu } = setup({ absentKernelCode: true });
  assert.throws(() => cpu.step(), /not present|segment|interrupt/i);
});

test("out-of-memory TSS stack frame write leaves privilege state unchanged", () => {
  const { cpu } = setup({ ring0Stack: 0x4004 });
  const before = cpu.getRegister(4, 32);
  assert.throws(() => cpu.step(), /guest memory|stack/i);
  assert.equal(cpu.segments.cpl, 3);
  assert.equal(cpu.segments.registers.cs.selector, 0x1b);
  assert.equal(cpu.segments.registers.ss.selector, 0x23);
  assert.equal(cpu.getRegister(4, 32), before);
});

test("ring-3 interrupt switches to a supervisor-only paged TSS stack", () => {
  const { cpu, memory } = setup({ paged: true, ring0Stack: 0x2800 });
  cpu.step();
  assert.equal(cpu.segments.cpl, 0);
  assert.equal(cpu.getRegister(4, 32), 0x2800n - 20n);
  const frame = new DataView(memory.read(0x2000 + 0x7ec, 20).buffer);
  assert.equal(frame.getUint32(0, true), 0x602);
  assert.equal(frame.getUint32(4, true), 0x1b);
  assert.equal(frame.getUint32(12, true), 0x1f00);
  assert.equal(frame.getUint32(16, true), 0x23);
});

test("explicit exception delivery pushes the CPU error code ahead of the interrupt frame", () => {
  const { cpu, memory } = setup();
  const gate = new Uint8Array(8);
  gate[0] = 0x00; gate[1] = 0x07;
  gate[2] = 0x08; gate[3] = 0x00;
  gate[5] = 0x8e;
  memory.write(0x900 + 14 * 8, gate);
  const result = cpu.deliverException(14, { errorCode: 5, returnIp: 0x650 });
  assert.equal(result.vector, 14);
  assert.equal(cpu.segments.cpl, 0);
  assert.equal(cpu.getRegister(4, 32), 0x1800n - 24n);
  const frame = new DataView(memory.read(0x1800 - 24, 24).buffer);
  assert.equal(frame.getUint32(0, true), 5);
  assert.equal(frame.getUint32(4, true), 0x650);
  assert.equal(frame.getUint32(8, true), 0x1b);
  assert.equal(frame.getUint32(16, true), 0x1f00);
  assert.equal(frame.getUint32(20, true), 0x23);
});
