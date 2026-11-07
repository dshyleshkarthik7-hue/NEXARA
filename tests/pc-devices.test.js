import test from "node:test";
import assert from "node:assert/strict";
import { Pic8259, Pit8253 } from "../packages/runtime/src/index.js";

test("dual 8259 PIC initializes vectors, masks IRQs and acknowledges slave IRQs", () => {
  const pic = new Pic8259();
  // ICW1, ICW2, ICW3, ICW4 for master and slave.
  pic.write(0x20, 0x11); pic.write(0x21, 0x20); pic.write(0x21, 0x04); pic.write(0x21, 0x01);
  pic.write(0xa0, 0x11); pic.write(0xa1, 0x28); pic.write(0xa1, 0x02); pic.write(0xa1, 0x01);
  pic.raise(10);
  assert.deepEqual(pic.acknowledge(), { irq: 10, vector: 0x2a });
  pic.endOfInterrupt(10);
  pic.write(0x21, 1 << 1);
  pic.raise(1);
  assert.equal(pic.acknowledge(), null);
  pic.write(0x21, 0);
  assert.deepEqual(pic.acknowledge(), { irq: 1, vector: 0x21 });
});

test("8259 PIC snapshots validate and preserve pending requests", () => {
  const pic = new Pic8259();
  pic.raise(4);
  const state = pic.snapshot();
  const copy = new Pic8259();
  copy.restore(state);
  assert.equal(copy.acknowledge().irq, 4);
  assert.throws(() => copy.restore({ ...state, master: { ...state.master, imr: 999 } }), /Invalid PIC snapshot/);
});

test("8253 PIT produces deterministic channel-zero periodic IRQs", () => {
  const pit = new Pit8253();
  pit.writeControl(0x34); // channel 0, low/high, mode 2
  pit.writeCounter0(4);
  pit.writeCounter0(0);
  assert.equal(pit.tick(3), 0);
  assert.equal(pit.tick(1), 1);
  assert.equal(pit.consumeIrq(), true);
  assert.equal(pit.consumeIrq(), false);
  const state = pit.snapshot();
  const restored = new Pit8253();
  restored.restore(state);
  assert.equal(restored.counter, pit.counter);
  assert.throws(() => restored.restore({ ...state, counter: 0 }), /Invalid PIT snapshot/);
});
