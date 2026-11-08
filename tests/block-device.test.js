import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBlockDevice, BLOCK_SECTOR_SIZE } from "../packages/runtime/src/index.js";

test("memory block device reads and writes bounded whole sectors", () => {
  const disk = new MemoryBlockDevice({ sectors: 4 });
  const sector = new Uint8Array(BLOCK_SECTOR_SIZE).fill(0x5a);
  disk.writeSectors(2, sector);
  assert.deepEqual(disk.readSectors(2), sector);
  assert.equal(disk.readSectors(0, 4).byteLength, 4 * BLOCK_SECTOR_SIZE);
});

test("memory block device rejects partial sectors and out-of-range LBAs", () => {
  const disk = new MemoryBlockDevice({ sectors: 2 });
  assert.throws(() => disk.readSectors(-1), RangeError);
  assert.throws(() => disk.readSectors(2), RangeError);
  assert.throws(() => disk.readSectors(0, 3), RangeError);
  assert.throws(() => disk.writeSectors(0, new Uint8Array(511)), /whole 512-byte sectors/);
  assert.throws(() => disk.writeSectors(0, new Uint8Array(1024)), RangeError);
});

test("read-only block devices reject writes", () => {
  const disk = new MemoryBlockDevice({ sectors: 2, readOnly: true });
  assert.throws(() => disk.writeSectors(0, new Uint8Array(BLOCK_SECTOR_SIZE)), /read-only/);
});

test("block-device snapshots are independent and restore only matching geometry", () => {
  const disk = new MemoryBlockDevice({ sectors: 2 });
  disk.writeSectors(1, new Uint8Array(BLOCK_SECTOR_SIZE).fill(0xa5));
  const snapshot = disk.snapshot();
  disk.writeSectors(1, new Uint8Array(BLOCK_SECTOR_SIZE).fill(0x11));
  disk.restore(snapshot);
  assert.equal(disk.readSectors(1)[0], 0xa5);
  snapshot.bytes[BLOCK_SECTOR_SIZE] = 0;
  assert.equal(disk.readSectors(1)[0], 0xa5);
  assert.throws(() => disk.restore({ ...snapshot, sectors: 3 }), /Invalid block device snapshot/);
});

test("block device validates configured capacity", () => {
  assert.throws(() => new MemoryBlockDevice({ sectors: 0 }), RangeError);
  assert.throws(() => new MemoryBlockDevice({ sectors: 2 ** 21 }), RangeError);
});
