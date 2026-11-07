import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86DescriptorTable } from "../packages/x86-core/src/descriptors.js";

function memoryWithTable(base = 0x100) {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  return { memory, table: new X86DescriptorTable(memory, { base, limit: 0x7ff }) };
}

test("decodes a present ring-0 flat code descriptor", () => {
  const { memory, table } = memoryWithTable();
  // base=0, 4 GiB granularity, present ring-0 executable/readable code
  memory.write(0x108, Uint8Array.from([0xff,0xff,0,0,0,0x9a,0xcf,0]));
  const descriptor = table.readSegment(8, { cpl: 0 });
  assert.equal(descriptor.executable, true);
  assert.equal(descriptor.readable, true);
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.dpl, 0);
  assert.equal(descriptor.limit, 0xffffffffn);
});

test("decodes a writable data descriptor and enforces privilege", () => {
  const { memory, table } = memoryWithTable();
  memory.write(0x108, Uint8Array.from([0xff,0xff,0,0,0,0x92,0xcf,0]));
  const descriptor = table.readSegment(8, { cpl: 0 });
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.dpl, 0);
  assert.throws(() => table.readSegment(8, { cpl: 3 }), /privilege/);
});

test("returns null for the null selector and rejects out-of-limit descriptors", () => {
  const { table } = memoryWithTable();
  assert.equal(table.readSegment(0), null);
  assert.throws(() => table.readSegment(0x800), /limit/);
});

test("decodes a 64-bit interrupt gate including high offset and IST", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const idt = new X86DescriptorTable(memory, { base: 0x200, limit: 0x0fff, kind: "idt", longMode: true });
  const entry = new Uint8Array(16);
  entry[0] = 0x78; entry[1] = 0x56;
  entry[2] = 0x08; entry[3] = 0x00;
  entry[4] = 3;
  entry[5] = 0x8e;
  entry[6] = 0x34; entry[7] = 0x12;
  entry[8] = 0xef; entry[9] = 0xcd; entry[10] = 0xab; entry[11] = 0x90;
  memory.write(0x200 + 14 * 16, entry);
  const gate = idt.readGate(14);
  assert.equal(gate.selector, 8);
  assert.equal(gate.offset, 0x90abcdef12345678n);
  assert.equal(gate.ist, 3);
  assert.equal(gate.interruptGate, true);
});

test("IDT software interrupt gate checks DPL and presence", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  const idt = new X86DescriptorTable(memory, { base: 0, limit: 0xfff, kind: "idt" });
  const gate = new Uint8Array(16);
  gate[2] = 8; gate[5] = 0x8e; // present DPL0 interrupt gate
  memory.write(3 * 16, gate);
  assert.equal(idt.readGate(3, { cpl: 0, software: true }).dpl, 0);
  assert.throws(() => idt.readGate(3, { cpl: 3, software: true }), /privilege/);
  gate[5] = 0x0e;
  memory.write(4 * 16, gate);
  assert.throws(() => idt.readGate(4), /not-present/);
});

test("rejects invalid table bounds and selector values", () => {
  const { table } = memoryWithTable();
  assert.throws(() => table.setRegister(0xffffn, 0xffff), /memory/);
  assert.throws(() => table.readSegment(-1), /selector/);
  assert.throws(() => table.readSegment(0x0c), /LDT/);
});

test("rejects reserved fields and task gates in 64-bit IDT entries", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const idt = new X86DescriptorTable(memory, { base: 0, limit: 0x0fff, kind: "idt", longMode: true });
  const reserved = new Uint8Array(16);
  reserved[2] = 8; reserved[5] = 0x8e; reserved[12] = 1;
  memory.write(0, reserved);
  assert.throws(() => idt.readGate(0), /Reserved/);
  reserved[12] = 0; reserved[5] = 0x85;
  memory.write(0, reserved);
  assert.throws(() => idt.readGate(0), /gate type/);
});

test("decodes and validates a present 32-bit TSS system descriptor", () => {
  const { memory, table } = memoryWithTable();
  memory.write(0x108, Uint8Array.from([0x67, 0x00, 0x78, 0x56, 0x34, 0x89, 0x00, 0x12]));
  const descriptor = table.readSystemDescriptor(8, { allowedTypes: [9] });
  assert.equal(descriptor.type, 9);
  assert.equal(descriptor.present, true);
  assert.equal(descriptor.base, 0x12345678n);
  assert.equal(descriptor.limit, 0x67n);
  assert.throws(() => table.readSystemDescriptor(8, { allowedTypes: [2] }), /type/);
});

test("rejects absent, non-system and out-of-limit system descriptors", () => {
  const { memory, table } = memoryWithTable();
  memory.write(0x108, Uint8Array.from([0x67, 0, 0, 0, 0, 0x09, 0, 0]));
  assert.throws(() => table.readSystemDescriptor(8, { allowedTypes: [9] }), /not present/);
  memory.write(0x108, Uint8Array.from([0x67, 0, 0, 0, 0, 0x92, 0, 0]));
  assert.throws(() => table.readSystemDescriptor(8), /code\/data/);
  assert.throws(() => table.readSystemDescriptor(0x800), /limit/);
});

test("decodes the full 64-bit base of a long-mode TSS descriptor", () => {
  const { memory, table } = memoryWithTable();
  memory.write(0x108, Uint8Array.from([
    0x67, 0x00, 0x78, 0x56, 0x34, 0x89, 0x00, 0x12,
    0xf0, 0xde, 0xbc, 0x9a, 0x00, 0x00, 0x00, 0x00
  ]));
  const descriptor = table.readSystemDescriptor(8, { allowedTypes: [9] });
  assert.equal(descriptor.width, 16);
  assert.equal(descriptor.base, 0x9abcdef012345678n);
  assert.equal(descriptor.limit, 0x67n);
});

test("rejects reserved bits in a 64-bit TSS descriptor upper half", () => {
  const { memory, table } = memoryWithTable();
  memory.write(0x108, Uint8Array.from([
    0x67, 0x00, 0x78, 0x56, 0x34, 0x89, 0x00, 0x12,
    0xf0, 0xde, 0xbc, 0x9a, 0x01, 0x00, 0x00, 0x00
  ]));
  assert.throws(() => table.readSystemDescriptor(8, { allowedTypes: [9] }), /Reserved/);
});
