import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory, PcAtInterruptFabric, AtaPioDevice, MemoryBlockDevice } from "../packages/runtime/src/index.js";

test("PC/AT fabric routes PIT channel zero through PIC to CPU IRQ queue", () => {
  const fabric = new PcAtInterruptFabric();
  fabric.ioWrite(0x20, 0x11); fabric.ioWrite(0x21, 0x20); fabric.ioWrite(0x21, 0x04); fabric.ioWrite(0x21, 0x01);
  fabric.ioWrite(0xa0, 0x11); fabric.ioWrite(0xa1, 0x28); fabric.ioWrite(0xa1, 0x02); fabric.ioWrite(0xa1, 0x01);
  fabric.ioWrite(0x43, 0x34);
  fabric.ioWrite(0x40, 4); fabric.ioWrite(0x40, 0);
  fabric.advanceTicks(4);
  const queued = [];
  const cpu = { requestInterrupt(vector) { queued.push(vector); } };
  assert.deepEqual(fabric.dispatchOne(cpu), { irq: 0, vector: 0x20 });
  assert.deepEqual(queued, [0x20]);
  fabric.pic.endOfInterrupt(0);
});

test("PC/AT fabric snapshots restore PIC and PIT state", () => {
  const fabric = new PcAtInterruptFabric();
  fabric.ioWrite(0x43, 0x34);
  fabric.ioWrite(0x40, 8); fabric.ioWrite(0x40, 0);
  fabric.advanceTicks(2);
  const snapshot = fabric.snapshot();
  const restored = new PcAtInterruptFabric();
  restored.restore(snapshot);
  assert.equal(restored.pit.counter, fabric.pit.counter);
  assert.deepEqual(restored.pic.snapshot(), fabric.pic.snapshot());
  assert.throws(() => restored.restore({ ...snapshot, format: "invalid" }), /Invalid PC fabric snapshot/);
});

test("PC/AT fabric checkpoint preserves an in-flight ATA PIO transfer", () => {
  const disk = new MemoryBlockDevice({ sectors: 2 });
  disk.writeSectors(0, new Uint8Array(512).fill(0x7c));
  const fabric = new PcAtInterruptFabric({ ata: new AtaPioDevice({ disk }) });
  fabric.ioWrite(0x1f2, 1);
  fabric.ioWrite(0x1f3, 0);
  fabric.ioWrite(0x1f4, 0);
  fabric.ioWrite(0x1f5, 0);
  fabric.ioWrite(0x1f6, 0xe0);
  fabric.ioWrite(0x1f7, 0x20);
  assert.equal(fabric.ioRead(0x1f0, 16), 0x7c7cn);
  const snapshot = fabric.snapshot();
  const expected = fabric.ioRead(0x1f0, 16);
  const restored = new PcAtInterruptFabric({ ata: new AtaPioDevice({ disk }) });
  restored.restore(snapshot);
  assert.equal(restored.ioRead(0x1f0, 16), expected);
  assert.throws(() => new PcAtInterruptFabric().restore(snapshot), /device configuration mismatch/);
});
