import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86Tss64 } from "../packages/x86-core/src/task-state.js";
import { X86Cpu } from "../packages/x86-core/src/index.js";

function setupLongMode({ ist = 0 } = {}) {
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const cpu = new X86Cpu({ memory, mode: 64, instructionPointer: 0x600 });
  const gdtBase = 0x100;
  const idtBase = 0x1000;
  const putSegment = (index, access, flags = 0) => {
    const bytes = new Uint8Array(8);
    bytes[0] = 0xff; bytes[1] = 0xff;
    bytes[5] = access;
    bytes[6] = 0x0f | (flags << 4);
    memory.write(gdtBase + index * 8, bytes);
  };
  putSegment(1, 0x9a, 2); // 64-bit ring-0 code
  putSegment(2, 0x92);    // ring-0 data
  putSegment(3, 0xfa, 2); // 64-bit ring-3 code
  putSegment(4, 0xf2);    // ring-3 data
  const tssDescriptor = Uint8Array.from([
    0x67, 0x00, 0x00, 0x05, 0x00, 0x89, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ]);
  memory.write(gdtBase + 5 * 8, tssDescriptor);
  cpu.systemTables.loadGdtr(gdtBase, 0x37);
  cpu.systemTables.loadIdtr(idtBase, 0x0fff);
  cpu.gdt.setRegister(gdtBase, 0x37);
  cpu.idt.setRegister(idtBase, 0x0fff);
  const gate = new Uint8Array(16);
  gate[0] = 0x00; gate[1] = 0x07;
  gate[2] = 0x08; gate[3] = 0x00;
  gate[4] = ist;
  gate[5] = 0xee; // present, DPL3, 64-bit interrupt gate
  memory.write(idtBase + 0x80 * 16, gate);
  memory.write(0x600, Uint8Array.of(0xcd, 0x80, 0x90));
  memory.write(0x700, Uint8Array.of(0xcf));
  const tss = new X86Tss64(memory, { base: 0x500, limit: 0x67 });
  tss.setRsp(0, 0x3000n);
  tss.setIst(1, 0x4000n);
  cpu.systemTables.loadTaskRegister({ selector: 0x28, base: 0x500, limit: 0x67, present: true, busy: true, usable: true });
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  cpu.segments.setCpl(3);
  cpu.segments.loadStack(0x23);
  cpu.segments.installCodeSegment(0x1b);
  cpu.setRegister(4, 0x4800n, 64);
  cpu.flags = 0x202n;
  return { cpu, memory };
}

test("long-mode interrupt uses TSS RSP0 and IRET restores outer RSP and SS", () => {
  const { cpu, memory } = setupLongMode();
  cpu.step();
  assert.equal(cpu.segments.cpl, 0);
  assert.equal(cpu.segments.registers.cs.selector, 0x08);
  assert.equal(cpu.segments.registers.ss.selector, 0);
  assert.equal(cpu.getRegister(4, 64), 0x3000n - 40n);
  const frame = new DataView(memory.read(0x3000 - 40, 40).buffer);
  assert.equal(frame.getBigUint64(0, true), 0x602n);
  assert.equal(frame.getBigUint64(8, true), 0x1bn);
  assert.equal(frame.getBigUint64(24, true), 0x4800n);
  assert.equal(frame.getBigUint64(32, true), 0x23n);
  cpu.step();
  assert.equal(cpu.segments.cpl, 3);
  assert.equal(cpu.segments.registers.ss.selector, 0x23);
  assert.equal(cpu.getRegister(4, 64), 0x4800n);
  assert.equal(cpu.ip, 0x602);
});

test("long-mode interrupt selects IST1 instead of RSP0 when the gate requests it", () => {
  const { cpu } = setupLongMode({ ist: 1 });
  cpu.step();
  assert.equal(cpu.segments.cpl, 0);
  assert.equal(cpu.getRegister(4, 64), 0x4000n - 40n);
  cpu.step();
  assert.equal(cpu.segments.cpl, 3);
  assert.equal(cpu.segments.registers.ss.selector, 0x23);
  assert.equal(cpu.getRegister(4, 64), 0x4800n);
});

test("long-mode exception entry places a 32-bit error code in an eight-byte frame slot", () => {
  const { cpu, memory } = setupLongMode();
  const result = cpu.deliverException(14, { errorCode: 5, returnIp: 0x650 });
  assert.equal(result.vector, 14);
  assert.equal(cpu.getRegister(4, 64), 0x3000n - 48n);
  const frame = new DataView(memory.read(0x3000 - 48, 48).buffer);
  assert.equal(frame.getBigUint64(0, true), 5n);
  assert.equal(frame.getBigUint64(8, true), 0x650n);
  assert.equal(frame.getBigUint64(16, true), 0x1bn);
  assert.equal(frame.getBigUint64(32, true), 0x4800n);
  assert.equal(frame.getBigUint64(40, true), 0x23n);
});
