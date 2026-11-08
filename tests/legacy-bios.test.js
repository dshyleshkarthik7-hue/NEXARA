import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory, MemoryBlockDevice } from "../packages/runtime/src/index.js";
import { LegacyBios, X86RealModeCpu } from "../packages/x86-core/src/index.js";

function makeBiosCpu({ disk, code = [0xcd,0x13,0xf4], output = () => {} }) {
  const memory = new GuestMemory({ initialPages: 257, maximumPages: 257 });
  memory.write(0x7c00, Uint8Array.from(code));
  const bios = new LegacyBios({ disk, output });
  const cpu = new X86RealModeCpu({
    memory, interruptHandler: bios.handleInterrupt.bind(bios)
  });
  return { memory, bios, cpu };
}

test("INT 13h reads a CHS sector into the ES:BX guest buffer", () => {
  const disk = new MemoryBlockDevice({ sectors: 128 });
  const sector = new Uint8Array(512).fill(0x5a);
  disk.writeSectors(1, sector);
  const { memory, cpu } = makeBiosCpu({ disk });
  cpu.ax = 0x0201; // AH=read sectors, AL=1
  cpu.cx = 0x0002; // cylinder 0, sector 2
  cpu.dx = 0x0080; // head 0, drive 80h
  cpu.es = 0;
  cpu.bx = 0x0600;
  cpu.flags |= 0x300;
  const result = cpu.run({ maxInstructions: 4 });
  assert.equal(result.state, "halted");
  assert.deepEqual(memory.read(0x600, 512), sector);
  assert.equal(cpu.ax, 1);
  assert.equal(cpu.flags & 1, 0);
  assert.equal(cpu.flags & 0x300, 0x300);
  assert.equal(cpu.sp, 0x7c00);
});

test("INT 13h rejects invalid track spans, DMA boundary crossing and wrong drives", () => {
  const disk = new MemoryBlockDevice({ sectors: 128 });
  const { memory, cpu } = makeBiosCpu({ disk });

  cpu.ax = 0x0202;
  cpu.cx = 0x003f; // sector 63, two sectors would cross a track
  cpu.dx = 0x0080;
  cpu.bx = 0x0600;
  cpu.step();
  assert.equal(cpu.ax >>> 8, 4);
  assert.equal(cpu.flags & 1, 1);

  cpu.ip = 0x7c00;
  cpu.ax = 0x0201;
  cpu.cx = 0x0001;
  cpu.dx = 0x0080;
  cpu.bx = 0xff00;
  cpu.step();
  assert.equal(cpu.ax >>> 8, 9);

  cpu.ip = 0x7c00;
  cpu.ax = 0x0201;
  cpu.cx = 0x0001;
  cpu.dx = 0x0081;
  cpu.bx = 0x0600;
  cpu.step();
  assert.equal(cpu.ax >>> 8, 1);
});

test("INT 13h AH=08 reports the configured drive geometry", () => {
  const disk = new MemoryBlockDevice({ sectors: 128 });
  const { cpu } = makeBiosCpu({ disk });
  cpu.ax = 0x0800;
  cpu.dx = 0x0080;
  cpu.step();
  assert.equal(cpu.ax, 1);
  assert.equal(cpu.cx & 0x3f, 63);
  assert.equal(cpu.dx >>> 8, 15);
  assert.equal(cpu.dx & 0xff, 0x80);
  assert.equal(cpu.flags & 1, 0);
});

test("INT 10h teletype service emits characters through the host output sink", () => {
  const disk = new MemoryBlockDevice({ sectors: 1 });
  const output = [];
  const { cpu } = makeBiosCpu({ disk, code: [0xcd,0x10,0xf4], output: character => output.push(character) });
  cpu.ax = 0x0e41;
  cpu.bx = 0x0007;
  cpu.run({ maxInstructions: 4 });
  assert.deepEqual(output, ["A"]);
});
