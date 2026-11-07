import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86Tss64 } from "../packages/x86-core/src/task-state.js";

test("models 64-bit TSS RSP0-2 and IST1-7 fields", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const tss = new X86Tss64(memory, { base: 0x200, limit: 0x67 });
  assert.equal(tss.setRsp(0, 0xffff800000001000n), 0xffff800000001000n);
  assert.equal(tss.setRsp(1, 0xffff800000002000n), 0xffff800000002000n);
  assert.equal(tss.setRsp(2, 0xffff800000003000n), 0xffff800000003000n);
  for (let index = 1; index <= 7; index++) {
    assert.equal(tss.setIst(index, BigInt(index) * 0x1000n), BigInt(index) * 0x1000n);
    assert.equal(tss.getIst(index), BigInt(index) * 0x1000n);
  }
  assert.deepEqual(tss.snapshot().rsp, [
    "18446603336221200384", "18446603336221204480", "18446603336221208576"
  ]);
});

test("rejects invalid RSP and IST indices and out-of-bounds TSS regions", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  const tss = new X86Tss64(memory, { base: 0x100, limit: 0x67 });
  assert.throws(() => tss.getRsp(3), /ring/);
  assert.throws(() => tss.getIst(0), /IST/);
  assert.throws(() => tss.setRsp(0, -1n), /unsigned/);
  assert.throws(() => new X86Tss64(memory, { base: 0xff0, limit: 0x67 }), /guest physical memory/);
});
