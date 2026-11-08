import test from "node:test";
import assert from "node:assert/strict";
import { AtaPioDevice, MemoryBlockDevice, BLOCK_SECTOR_SIZE } from "../packages/runtime/src/index.js";

function setLba(ata, lba) {
  ata.write(0x1f2, 1);
  ata.write(0x1f3, lba & 0xff);
  ata.write(0x1f4, (lba >>> 8) & 0xff);
  ata.write(0x1f5, (lba >>> 16) & 0xff);
  ata.write(0x1f6, 0xe0 | ((lba >>> 24) & 0x0f));
}

test("ATA IDENTIFY returns a 256-word device identity block", () => {
  const ata = new AtaPioDevice({ disk: new MemoryBlockDevice({ sectors: 4096 }) });
  ata.write(0x1f7, 0xec);
  assert.equal(ata.read(0x1f7), 0x48n);
  assert.equal(ata.read(0x1f0, 16), 0x0040n);
  let last;
  for (let i = 1; i < 256; i++) last = ata.read(0x1f0, 16);
  assert.equal(typeof last, "bigint");
  assert.equal(ata.read(0x1f7), 0x40n);
});

test("ATA PIO writes and reads one LBA28 sector through the data register", () => {
  const disk = new MemoryBlockDevice({ sectors: 4096 });
  const ata = new AtaPioDevice({ disk });
  setLba(ata, 0x123);
  ata.write(0x1f7, 0x30);
  assert.equal(ata.read(0x1f7), 0x48n);
  for (let i = 0; i < 256; i++) ata.write(0x1f0, (i ^ 0xa55a) & 0xffff, 16);
  assert.equal(ata.read(0x1f7), 0x40n);
  const stored = disk.readSectors(0x123);
  assert.equal(stored[0], 0x5a);
  assert.equal(stored[1], 0xa5);

  setLba(ata, 0x123);
  ata.write(0x1f7, 0x20);
  for (let i = 0; i < 256; i++) assert.equal(ata.read(0x1f0, 16), BigInt((i ^ 0xa55a) & 0xffff));
  assert.equal(ata.read(0x1f7), 0x40n);
});

test("ATA PIO rejects unsupported multi-sector, non-LBA and out-of-range commands", () => {
  const ata = new AtaPioDevice({ disk: new MemoryBlockDevice({ sectors: 8 }) });
  ata.write(0x1f2, 2);
  ata.write(0x1f6, 0xe0);
  ata.write(0x1f7, 0x20);
  assert.equal(ata.read(0x1f7), 0x41n);
  assert.equal(ata.read(0x1f1), 0x04n);

  setLba(ata, 99);
  ata.write(0x1f7, 0x20);
  assert.equal(ata.read(0x1f7), 0x41n);
});

test("ATA PIO rejects writes to a read-only backing disk", () => {
  const ata = new AtaPioDevice({ disk: new MemoryBlockDevice({ sectors: 4, readOnly: true }) });
  setLba(ata, 0);
  ata.write(0x1f7, 0x30);
  for (let i = 0; i < 256; i++) ata.write(0x1f0, i, 16);
  assert.equal(ata.read(0x1f7), 0x41n);
});
