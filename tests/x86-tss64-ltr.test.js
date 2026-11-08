import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86Cpu } from "../packages/x86-core/src/index.js";

test("LTR loads and marks a 64-bit available TSS descriptor busy", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const cpu = new X86Cpu({ memory, mode: 64, instructionPointer: 0x600 });
  const gdtBase = 0x100;
  const descriptor = Uint8Array.from([
    0x67, 0x00, 0x00, 0x03, 0x00, 0x89, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ]);
  memory.write(gdtBase + 5 * 8, descriptor);
  cpu.systemTables.loadGdtr(gdtBase, 0x7f);
  cpu.gdt.setRegister(gdtBase, 0x7f);
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  cpu.setRegister(0, 0x28n, 64);
  memory.write(0x600, Uint8Array.of(0x0f, 0x00, 0xd8)); // LTR AX
  cpu.step();
  assert.equal(cpu.systemTables.task.selector, 0x28);
  assert.equal(cpu.systemTables.task.base, 0x300n);
  assert.equal(cpu.systemTables.task.limit, 0x67);
  assert.equal(memory.read(gdtBase + 5 * 8 + 5, 1)[0] & 0x0f, 0x0b);
});

test("LTR rejects a long-mode TSS descriptor with reserved upper bits", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const cpu = new X86Cpu({ memory, mode: 64, instructionPointer: 0x600 });
  const gdtBase = 0x100;
  const descriptor = Uint8Array.from([
    0x67, 0x00, 0x00, 0x03, 0x00, 0x89, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00
  ]);
  memory.write(gdtBase + 5 * 8, descriptor);
  cpu.systemTables.loadGdtr(gdtBase, 0x7f);
  cpu.gdt.setRegister(gdtBase, 0x7f);
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  cpu.setRegister(0, 0x28n, 64);
  memory.write(0x600, Uint8Array.of(0x0f, 0x00, 0xd8));
  assert.throws(() => cpu.step(), /reserved long-mode TSS/i);
  assert.equal(cpu.systemTables.task.usable, false);
});

test("LTR accepts a present available TSS descriptor regardless of its DPL/RPL fields", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const cpu = new X86Cpu({ memory, mode: 64, instructionPointer: 0x600 });
  const gdtBase = 0x100;
  const descriptor = Uint8Array.from([
    0x67, 0x00, 0x00, 0x03, 0x00, 0xe9, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ]);
  memory.write(gdtBase + 5 * 8, descriptor);
  cpu.systemTables.loadGdtr(gdtBase, 0x7f);
  cpu.gdt.setRegister(gdtBase, 0x7f);
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  cpu.setRegister(0, 0x2bn, 64); // RPL=3; LTR itself remains CPL0-only
  memory.write(0x600, Uint8Array.of(0x0f, 0x00, 0xd8));
  cpu.step();
  assert.equal(cpu.systemTables.task.selector, 0x2b);
  assert.equal(memory.read(gdtBase + 5 * 8 + 5, 1)[0], 0xeb);
});

test("LTR rejects busy and not-present TSS descriptors without changing TR", () => {
  for (const access of [0x8b, 0x0b]) {
    const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
    const cpu = new X86Cpu({ memory, mode: 64, instructionPointer: 0x600 });
    const gdtBase = 0x100;
    memory.write(gdtBase + 5 * 8, Uint8Array.from([
      0x67, 0x00, 0x00, 0x03, 0x00, access, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]));
    cpu.systemTables.loadGdtr(gdtBase, 0x7f);
    cpu.gdt.setRegister(gdtBase, 0x7f);
    cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
    cpu.setRegister(0, 0x28n, 64);
    memory.write(0x600, Uint8Array.of(0x0f, 0x00, 0xd8));
    assert.throws(() => cpu.step(), /busy|not present/i);
    assert.equal(cpu.systemTables.task.usable, false);
  }
});

test("LTR rejects a TSS whose limit is shorter than its architectural header", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const cpu = new X86Cpu({ memory, mode: 64, instructionPointer: 0x600 });
  const gdtBase = 0x100;
  memory.write(gdtBase + 5 * 8, Uint8Array.from([
    0x66, 0x00, 0x00, 0x03, 0x00, 0x89, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ]));
  cpu.systemTables.loadGdtr(gdtBase, 0x7f);
  cpu.gdt.setRegister(gdtBase, 0x7f);
  cpu.writeControlRegister(0, cpu.readControlRegister(0) | 1n);
  cpu.setRegister(0, 0x28n, 64);
  memory.write(0x600, Uint8Array.of(0x0f, 0x00, 0xd8));
  assert.throws(() => cpu.step(), /104-byte TSS/);
  assert.equal(cpu.systemTables.task.usable, false);
});
