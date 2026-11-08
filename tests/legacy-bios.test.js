import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory, MemoryBlockDevice, LegacyBootSectorLoader } from "../packages/runtime/src/index.js";
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

test("legacy boot sector loads and transfers control to a second stage through INT 13h", () => {
  const disk = new MemoryBlockDevice({ sectors: 16 });
  const boot = new Uint8Array(512);
  boot.set([
    0xbb,0x00,0x7e,       // MOV BX,7E00h
    0xb8,0x01,0x02,       // MOV AX,0201h (read one sector)
    0xb9,0x02,0x00,       // MOV CX,0002h (cylinder 0, sector 2)
    0xba,0x80,0x00,       // MOV DX,0080h (head 0, drive 80h)
    0xcd,0x13,            // INT 13h
    0xe9,0xef,0x01         // JMP to 7E00h
  ]);
  boot[510] = 0x55;
  boot[511] = 0xaa;
  const stage2 = new Uint8Array(512);
  stage2.set([0xb8,0xef,0xbe,0xf4]); // MOV AX,BEEFh; HLT
  disk.writeSectors(0, boot);
  disk.writeSectors(1, stage2);

  const memory = new GuestMemory({ initialPages: 8, maximumPages: 8 });
  const handoff = new LegacyBootSectorLoader({ disk, memory }).prepare();
  const bios = new LegacyBios({ disk });
  const cpu = new X86RealModeCpu({
    memory, cs: handoff.cs, ip: handoff.ip,
    interruptHandler: bios.handleInterrupt.bind(bios)
  });
  const result = cpu.run({ maxInstructions: 32 });
  assert.equal(result.state, "halted");
  assert.equal(cpu.ax, 0xbeef);
  assert.equal(cpu.ip, 0x7e04);
  assert.deepEqual(memory.read(0x7e00, 4), Uint8Array.of(0xb8,0xef,0xbe,0xf4));
});

test("INT 13h EDD check and AH=42 extended LBA read use the disk-address packet", () => {
  const disk = new MemoryBlockDevice({ sectors: 32 });
  const sector = new Uint8Array(512).fill(0x6d);
  disk.writeSectors(5, sector);
  const { memory, cpu } = makeBiosCpu({ disk });

  cpu.ax = 0x4100;
  cpu.bx = 0x55aa;
  cpu.dx = 0x0080;
  cpu.step();
  assert.equal(cpu.ax, 0x3000);
  assert.equal(cpu.bx, 0xaa55);
  assert.equal(cpu.cx & 1, 1);
  assert.equal(cpu.flags & 1, 0);

  const dap = new Uint8Array(16);
  dap[0] = 0x10;
  dap[2] = 1;
  dap[4] = 0x00;
  dap[5] = 0x06; // offset 0600h
  dap[6] = 0;
  dap[7] = 0;
  dap[8] = 5; // 64-bit LBA 5
  memory.write(0x0500, dap);
  cpu.ip = 0x7c00;
  cpu.ax = 0x4200;
  cpu.dx = 0x0080;
  cpu.ds = 0;
  cpu.si = 0x0500;
  cpu.step();
  assert.equal(cpu.ax, 1);
  assert.equal(cpu.flags & 1, 0);
  assert.deepEqual(memory.read(0x600, 512), sector);
});

test("INT 16h keyboard services poll, peek and consume queued key words", () => {
  const disk = new MemoryBlockDevice({ sectors: 1 });
  const { cpu, bios } = makeBiosCpu({ disk });
  cpu.ax = 0x0100;
  cpu.step();
  assert.equal(cpu.flags & 0x40, 0x40);

  bios.enqueueKey(0x1e61); // scan code 1Eh, ASCII 'a'
  cpu.ip = 0x7c00;
  cpu.ax = 0x0100;
  cpu.step();
  assert.equal(cpu.ax, 0x1e61);
  assert.equal(cpu.flags & 0x40, 0);

  cpu.ip = 0x7c00;
  cpu.ax = 0x0000;
  cpu.step();
  assert.equal(cpu.ax, 0x1e61);
  cpu.ip = 0x7c00;
  cpu.ax = 0x0000;
  cpu.step();
  assert.equal(cpu.flags & 0x40, 0x40);
});

test("INT 1Ah returns deterministic BIOS ticks and reports midnight rollover", () => {
  const disk = new MemoryBlockDevice({ sectors: 1 });
  const { cpu, bios } = makeBiosCpu({ disk });
  bios.advanceTicks(0x1800af - 100);
  cpu.ax = 0x0000;
  cpu.step();
  assert.equal((cpu.cx << 16) | cpu.dx, 0x1800af - 100);
  assert.equal(cpu.ax & 0xff, 0);

  bios.advanceTicks(101);
  cpu.ip = 0x7c00;
  cpu.ax = 0;
  cpu.step();
  assert.equal((cpu.cx << 16) | cpu.dx, 1);
  assert.equal(cpu.ax & 0xff, 1);
  cpu.ip = 0x7c00;
  cpu.step();
  assert.equal(cpu.ax & 0xff, 0);
});
