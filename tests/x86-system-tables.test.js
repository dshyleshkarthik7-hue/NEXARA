import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86SystemTableState } from "../packages/x86-core/src/system-tables.js";

test("stores bounded GDTR and IDTR bases and limits", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const tables = new X86SystemTableState(memory);
  assert.equal(tables.loadGdtr(0x100, 0x7ff).base, "256");
  assert.equal(tables.loadIdtr(0x800, 0x7ff).limit, 0x7ff);
  assert.throws(() => tables.loadGdtr(0x1fff, 0x100), /exceeds/);
  assert.throws(() => tables.loadIdtr(0, 0x10000), /16-bit/);
});

test("tracks LDTR null state and validates selector form", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const tables = new X86SystemTableState(memory);
  assert.equal(tables.clearLdtr().usable, false);
  assert.throws(() => tables.loadLdtr({ selector: 4, base: 0, limit: 0 }), /GDT selector/);
  assert.equal(tables.loadLdtr({ selector: 8, base: 0x100, limit: 0xff }).usable, true);
});

test("tracks task-register selector, presence and busy state", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const tables = new X86SystemTableState(memory);
  assert.throws(() => tables.loadTaskRegister({ selector: 0, base: 0, limit: 0 }), /non-null/);
  const task = tables.loadTaskRegister({ selector: 0x10, base: 0x200, limit: 0x67, present: true, busy: false });
  assert.equal(task.selector, 0x10);
  assert.equal(task.busy, false);
});

test("round-trips system-table state and rejects incompatible or corrupt snapshots", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const first = new X86SystemTableState(memory);
  first.loadGdtr(0x100, 0x7ff);
  first.loadIdtr(0x800, 0x7ff);
  first.loadLdtr({ selector: 8, base: 0x100, limit: 0xff });
  first.loadTaskRegister({ selector: 0x10, base: 0x200, limit: 0x67 });
  const snapshot = first.snapshot();
  const second = new X86SystemTableState(memory);
  assert.deepEqual(second.restore(snapshot), snapshot);
  assert.throws(() => second.restore({ ...snapshot, longMode: false }), /incompatible/);
  assert.throws(() => second.restore({ ...snapshot, gdtr: { base: "999999", limit: 0xffff } }), /exceeds/);
});

test("reset GDTR and IDTR limits fit small configured guest memory", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  const tables = new X86SystemTableState(memory);
  assert.equal(tables.snapshot().gdtr.limit, memory.byteLength - 1);
  assert.equal(tables.snapshot().idtr.limit, memory.byteLength - 1);
  const restored = new X86SystemTableState(memory);
  assert.deepEqual(restored.restore(tables.snapshot()), tables.snapshot());
});
