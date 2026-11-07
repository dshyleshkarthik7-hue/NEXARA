import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory, MEMORY_PAGE_SIZE } from "../packages/runtime/src/index.js";

test("guest memory reads and writes bytes and little-endian u32 values", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 2 });
  memory.write(0, Uint8Array.from([0x4e, 0x45, 0x58]));
  assert.deepEqual([...memory.read(0, 3)], [0x4e, 0x45, 0x58]);
  memory.writeU32(16, 0x12345678);
  assert.equal(memory.readU32(16), 0x12345678);
});

test("guest memory grows within its configured ceiling", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 2 });
  assert.equal(memory.grow(1), 1);
  assert.equal(memory.pageCount, 2);
  assert.throws(() => memory.grow(1), RangeError);
});

test("guest memory rejects invalid and out-of-bounds accesses", () => {
  const memory = new GuestMemory();
  assert.throws(() => memory.read(-1, 1), RangeError);
  assert.throws(() => memory.read(MEMORY_PAGE_SIZE - 1, 2), RangeError);
  assert.throws(() => memory.writeU32(0, -1), RangeError);
});

test("snapshots are independent copies and can be restored", () => {
  const memory = new GuestMemory();
  memory.writeU32(0, 99);
  const snapshot = memory.snapshot();
  memory.writeU32(0, 100);
  memory.restore(snapshot);
  assert.equal(memory.readU32(0), 99);
  snapshot[0] = 0;
  assert.equal(memory.readU32(0), 99);
  assert.throws(() => memory.restore(new Uint8Array([1, 2])), TypeError);
});
