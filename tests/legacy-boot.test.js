import test from "node:test";
import assert from "node:assert/strict";
import {
  GuestMemory, MemoryBlockDevice, BLOCK_SECTOR_SIZE,
  LegacyBootSectorLoader, LEGACY_BOOT_ADDRESS
} from "../packages/runtime/src/index.js";
import { X86RealModeCpu } from "../packages/x86-core/src/index.js";

function makeBootDisk() {
  const disk = new MemoryBlockDevice({ sectors: 4 });
  const sector = new Uint8Array(BLOCK_SECTOR_SIZE);
  sector[0] = 0xfa; // CLI — preserved as data; not executed by this loader.
  sector[1] = 0xf4; // HLT — preserved as data; not executed by this loader.
  sector[510] = 0x55;
  sector[511] = 0xaa;
  disk.writeSectors(0, sector);
  return { disk, sector };
}

test("legacy boot loader stages a signed sector at physical 0x7c00", () => {
  const { disk, sector } = makeBootDisk();
  const memory = new GuestMemory({ initialPages: 8, maximumPages: 8 });
  const loader = new LegacyBootSectorLoader({ disk, memory });
  const handoff = loader.prepare({ drive: 0x81 });

  assert.deepEqual(memory.read(LEGACY_BOOT_ADDRESS, BLOCK_SECTOR_SIZE), sector);
  assert.deepEqual(handoff, {
    architecture: "x86-real-mode-handoff",
    drive: 0x81,
    bootLba: 0,
    loadAddress: 0x7c00,
    bytesLoaded: 512,
    cs: 0,
    ip: 0x7c00,
    driveRegister: 0x81
  });
});

test("legacy boot loader rejects missing signature without modifying guest memory", () => {
  const disk = new MemoryBlockDevice({ sectors: 1 });
  const memory = new GuestMemory({ initialPages: 8, maximumPages: 8 });
  memory.write(LEGACY_BOOT_ADDRESS, new Uint8Array(512).fill(0x33));
  const before = memory.read(LEGACY_BOOT_ADDRESS, 512);
  const loader = new LegacyBootSectorLoader({ disk, memory });
  assert.throws(() => loader.prepare(), /0x55AA/);
  assert.deepEqual(memory.read(LEGACY_BOOT_ADDRESS, 512), before);
});

test("legacy boot loader validates disk LBA, BIOS drive and guest memory window", () => {
  const { disk } = makeBootDisk();
  assert.throws(() => new LegacyBootSectorLoader({
    disk, memory: new GuestMemory({ initialPages: 1 })
  }).prepare(), /0x7c00 boot-sector window/);

  const loader = new LegacyBootSectorLoader({
    disk, memory: new GuestMemory({ initialPages: 8 })
  });
  assert.throws(() => loader.prepare({ lba: 4 }), /outside the disk/);
  assert.throws(() => loader.prepare({ drive: 256 }), /one byte/);
});

test("staged legacy boot sector executes through the 16-bit real-mode interpreter", () => {
  const disk = new MemoryBlockDevice({ sectors: 1 });
  const sector = new Uint8Array(512);
  sector.set([0xb8, 0x34, 0x12, 0xf4]); // MOV AX,1234h; HLT
  sector[510] = 0x55;
  sector[511] = 0xaa;
  disk.writeSectors(0, sector);
  const memory = new GuestMemory({ initialPages: 8, maximumPages: 8 });
  const handoff = new LegacyBootSectorLoader({ disk, memory }).prepare();
  const cpu = new X86RealModeCpu({ memory, cs: handoff.cs, ip: handoff.ip });
  const result = cpu.run({ maxInstructions: 8 });
  assert.equal(result.state, "halted");
  assert.equal(cpu.ax, 0x1234);
  assert.equal(result.instructionsExecuted, 2);
});
