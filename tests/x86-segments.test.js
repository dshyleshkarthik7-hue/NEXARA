import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86DescriptorTable } from "../packages/x86-core/src/descriptors.js";
import { X86SegmentState } from "../packages/x86-core/src/segments.js";

function setup() {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const gdt = new X86DescriptorTable(memory, { base: 0x100, limit: 0x7f, kind: "gdt", longMode: false });
  // ring 0 flat code, ring 0 writable data, ring 3 code, ring 3 writable data
  memory.write(0x108, Uint8Array.from([0xff,0xff,0,0,0,0x9a,0xcf,0]));
  memory.write(0x110, Uint8Array.from([0xff,0xff,0,0,0,0x92,0xcf,0]));
  memory.write(0x118, Uint8Array.from([0xff,0xff,0,0,0,0xfa,0xcf,0]));
  memory.write(0x120, Uint8Array.from([0xff,0xff,0,0,0,0xf2,0xcf,0]));
  return { memory, gdt };
}

test("loads readable data segments and permits null DS/ES/FS/GS", () => {
  const { gdt } = setup();
  const state = new X86SegmentState({ gdt, cpl: 0 });
  assert.equal(state.loadData("ds", 0x10).writable, true);
  assert.equal(state.loadData("es", 0).cache, null);
  assert.throws(() => state.loadData("cs", 0x08), /DS, ES, FS or GS/);
});

test("loads SS only when writable data DPL and RPL match CPL", () => {
  const { gdt } = setup();
  const ring0 = new X86SegmentState({ gdt, cpl: 0 });
  assert.equal(ring0.loadStack(0x10).selector, 0x10);
  assert.throws(() => ring0.loadStack(0x20), /privilege/);
  assert.throws(() => ring0.loadStack(0x08), /writable data/);
});

test("installs CS cache only for executable segments with compatible privilege", () => {
  const { gdt } = setup();
  const ring0 = new X86SegmentState({ gdt, cpl: 0 });
  assert.equal(ring0.installCodeSegment(0x08).executable, true);
  assert.throws(() => ring0.installCodeSegment(0x18), /privilege/);
  const ring3 = new X86SegmentState({ gdt, cpl: 3 });
  assert.equal(ring3.installCodeSegment(0x1b).selector, 0x1b);
});

test("rejects invalid LDT selector when no LDT is installed", () => {
  const { gdt } = setup();
  const state = new X86SegmentState({ gdt, cpl: 0 });
  assert.throws(() => state.loadData("ds", 0x0c), /LDTR is unusable/);
});

test("segment snapshots expose cached descriptor attributes and CPL", () => {
  const { gdt } = setup();
  const state = new X86SegmentState({ gdt, cpl: 0 });
  state.loadStack(0x10);
  state.loadData("ds", 0x10);
  const snapshot = state.snapshot();
  assert.equal(snapshot.cpl, 0);
  assert.equal(snapshot.ss.dpl, 0);
  assert.equal(snapshot.ds.writable, true);
});
