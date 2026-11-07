import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory, MEMORY_PAGE_SIZE } from "../packages/runtime/src/index.js";
import { GuestAddressSpace, PageFault } from "../packages/runtime/src/mmu.js";

const page = BigInt(MEMORY_PAGE_SIZE);

test("address space maps and translates virtual pages into guest physical memory", () => {
  const memory = new GuestMemory({ initialPages: 4, maximumPages: 4 });
  const mmu = new GuestAddressSpace(memory);
  mmu.map(0x4000n, 0x2000n, { read: true, write: true, execute: true, user: true });
  memory.write(0x2007, Uint8Array.of(0x4e, 0x45, 0x58));
  assert.equal(mmu.translate(0x4007n), 0x2007);
  assert.deepEqual([...mmu.read(0x4007n, 3)], [0x4e, 0x45, 0x58]);
  assert.deepEqual([...mmu.fetch(0x4007n, 3)], [0x4e, 0x45, 0x58]);
});

test("address space reads and writes across adjacent mapped pages", () => {
  const memory = new GuestMemory({ initialPages: 3, maximumPages: 3 });
  const mmu = new GuestAddressSpace(memory);
  mmu.map(0x1000n, 0n, { write: true });
  mmu.map(0x2000n, page, { write: true });
  mmu.write(0x1ffen, Uint8Array.of(1, 2, 3, 4));
  assert.deepEqual([...memory.read(MEMORY_PAGE_SIZE - 2, 2)], [1, 2]);
  assert.deepEqual([...memory.read(MEMORY_PAGE_SIZE, 2)], [3, 4]);
  assert.deepEqual([...mmu.read(0x1ffen, 4)], [1, 2, 3, 4]);
});

test("unmapped and permission faults expose x86-style error bits", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const mmu = new GuestAddressSpace(memory);
  assert.throws(() => mmu.read(0x8000n, 1), error => error instanceof PageFault && error.errorCode === 0);
  mmu.map(0x1000n, 0n, { read: true, user: false });
  assert.throws(() => mmu.write(0x1000n, Uint8Array.of(1)), error => error instanceof PageFault && error.errorCode === 3);
  assert.throws(() => mmu.read(0x1000n, 1, { user: true }), error => error instanceof PageFault && error.errorCode === 5);
  assert.throws(() => mmu.fetch(0x1000n, 1), error => error instanceof PageFault && error.errorCode === 17);
});

test("protect and unmap invalidate cached translations", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const mmu = new GuestAddressSpace(memory);
  mmu.map(0x3000n, 0n, { write: true });
  assert.equal(mmu.translate(0x3000n), 0);
  mmu.protect(0x3000n, { write: false });
  assert.throws(() => mmu.write(0x3000n, Uint8Array.of(1)), PageFault);
  assert.equal(mmu.unmap(0x3000n), true);
  assert.throws(() => mmu.translate(0x3000n), PageFault);
  assert.equal(mmu.mappingCount, 0);
});

test("address space rejects unaligned, out-of-range and non-canonical mappings", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  const mmu = new GuestAddressSpace(memory);
  assert.throws(() => mmu.map(1n, 0n), RangeError);
  assert.throws(() => mmu.map(0n, page), RangeError);
  assert.throws(() => mmu.translate(0x0000800000000000n), RangeError);
  assert.throws(() => mmu.map(0n, 0n, { read: false, write: true }), RangeError);
});

test("address space supports canonical high-half virtual addresses", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  const mmu = new GuestAddressSpace(memory);
  mmu.map(0xffff800000001000n, 0n, { read: true });
  assert.equal(mmu.translate(0xffff80000000100an), 10);
});


test("address space enforces read-only and execute-only page permissions", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const mmu = new GuestAddressSpace(memory);
  mmu.map(0x5000n, 0n, { read: false, execute: true });
  assert.throws(() => mmu.read(0x5000n, 1), error => error instanceof PageFault && error.present);
  assert.deepEqual([...mmu.fetch(0x5000n, 1)], [0]);
  assert.throws(() => mmu.write(0x5000n, Uint8Array.of(1)), PageFault);
});


test("four-level page-table walker translates a 4 KiB guest page", () => {
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const mmu = new GuestAddressSpace(memory);
  const put64 = (address, value) => {
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
    memory.write(address, bytes);
  };
  // PML4 -> PDPT -> PD -> PT. All levels are present, writable and user-accessible.
  put64(0, 0x1000n | 7n);
  put64(0x1000, 0x2000n | 7n);
  put64(0x2000, 0x3000n | 7n);
  put64(0x3000 + 4 * 8, 0x4000n | 7n);
  memory.write(0x400a, Uint8Array.of(0x4e, 0x58));
  mmu.setPageTableRoot(0n);
  assert.equal(mmu.translate(0x400an), 0x400a);
  assert.deepEqual([...mmu.read(0x400an, 2)], [0x4e, 0x58]);
});

test("four-level page-table walker enforces user write and NX permissions", () => {
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const mmu = new GuestAddressSpace(memory);
  const put64 = (address, value) => {
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
    memory.write(address, bytes);
  };
  put64(0, 0x1000n | 7n);
  put64(0x1000, 0x2000n | 3n); // supervisor-only upper-level entry
  put64(0x2000, 0x3000n | 7n);
  put64(0x3000 + 4 * 8, 0x4000n | 5n | (1n << 63n)); // present, read-only, NX
  mmu.setNxEnabled(true);
  mmu.setPageTableRoot(0n);
  assert.equal(mmu.translate(0x4000n), 0x4000);
  assert.throws(() => mmu.translate(0x4000n, { user: true }), error => error instanceof PageFault && error.present && error.user);
  assert.throws(() => mmu.translate(0x4000n, { write: true }), error => error instanceof PageFault && error.present && error.write);
  assert.throws(() => mmu.translate(0x4000n, { execute: true }), error => error instanceof PageFault && error.instruction);
});

test("page-table walker rejects invalid CR3 roots and absent entries", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const mmu = new GuestAddressSpace(memory);
  assert.throws(() => mmu.setPageTableRoot(1n), RangeError);
  assert.throws(() => mmu.setPageTableRoot(0x2000n), RangeError);
  mmu.setPageTableRoot(0n);
  assert.throws(() => mmu.translate(0n), PageFault);
});


test("four-level walker translates 2 MiB large pages", () => {
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const mmu = new GuestAddressSpace(memory);
  const put64 = (address, value) => {
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
    memory.write(address, bytes);
  };
  put64(0, 0x1000n | 7n);
  put64(0x1000, 0x2000n | 7n);
  put64(0x2000 + 1 * 8, 0x1083n); // 2 MiB present, writable, PAT enabled
  memory.write(0x2345, Uint8Array.of(0x2a));
  mmu.setPageTableRoot(0n);
  assert.equal(mmu.translate(0x200000n + 0x2345n), 0x2345);
  assert.deepEqual([...mmu.read(0x200000n + 0x2345n, 1)], [0x2a]);
});

test("four-level walker translates 1 GiB large pages", () => {
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const mmu = new GuestAddressSpace(memory);
  const put64 = (address, value) => {
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
    memory.write(address, bytes);
  };
  put64(0, 0x1000n | 7n);
  put64(0x1000 + 8, 0x83n); // 1 GiB present, writable large-page leaf
  memory.write(0x3456, Uint8Array.of(0x5c));
  mmu.setPageTableRoot(0n);
  assert.equal(mmu.translate(0x40000000n + 0x3456n), 0x3456);
  assert.deepEqual([...mmu.fetch(0x40000000n + 0x3456n, 1)], [0x5c]);
});

test("large-page walker rejects reserved misaligned address bits", () => {
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const mmu = new GuestAddressSpace(memory);
  const put64 = (address, value) => {
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
    memory.write(address, bytes);
  };
  put64(0, 0x1000n | 7n);
  put64(0x1000, 0x2000n | 7n);
  put64(0x2000 + 8, 0x2000n | 0x83n); // reserved address bit in a 2 MiB leaf
  mmu.setPageTableRoot(0n);
  assert.throws(() => mmu.translate(0x200000n), error => error instanceof PageFault && error.reserved && (error.errorCode & 8) !== 0);
});


test("legacy 32-bit paging translates 4 KiB pages and sets accessed/dirty bits", async () => {
  const { X86LegacyPaging32 } = await import("../packages/runtime/src/mmu.js");
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const put32 = (address, value) => memory.write(address, Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255));
  const get32 = address => { const b=memory.read(address,4); return (b[0]|(b[1]<<8)|(b[2]<<16)|(b[3]<<24))>>>0; };
  put32(0, 0x1000 | 7);
  put32(0x1000 + 2*4, 0x3000 | 7);
  const paging = new X86LegacyPaging32(memory);
  paging.loadCr3(0);
  memory.write(0x300a, Uint8Array.of(0x42));
  assert.equal(paging.translate(0x200a), 0x300a);
  assert.deepEqual([...paging.read(0x200a,1)], [0x42]);
  paging.write(0x200a, Uint8Array.of(0x55));
  assert.equal(memory.read(0x300a,1)[0],0x55);
  assert.equal((get32(0)&0x20)!==0,true);
  assert.equal((get32(0x1008)&0x60),0x60);
});

test("legacy 32-bit paging enforces user, write-protect and supervisor override", async () => {
  const { X86LegacyPaging32 } = await import("../packages/runtime/src/mmu.js");
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const put32 = (address, value) => memory.write(address, Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255));
  put32(0, 0x1000 | 1);
  put32(0x1000, 0x2000 | 1); // supervisor, read-only at both levels
  const paging = new X86LegacyPaging32(memory, { writeProtect: true });
  paging.loadCr3(0);
  assert.throws(() => paging.translate(0, { user:true }), error => error instanceof PageFault && error.present && error.user);
  assert.throws(() => paging.translate(0, { write:true }), error => error instanceof PageFault && error.present && error.write);
  paging.setControl({ writeProtect:false });
  assert.equal(paging.translate(0, { write:true }), 0x2000);
});

test("legacy 32-bit paging supports CR4.PSE 4 MiB pages and rejects reserved bits", async () => {
  const { X86LegacyPaging32 } = await import("../packages/runtime/src/mmu.js");
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const put32 = (address, value) => memory.write(address, Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255));
  put32(0, 0x83); // 4 MiB page, present and writable
  memory.write(0x2345, Uint8Array.of(0x6a));
  const paging = new X86LegacyPaging32(memory, { pse:true });
  paging.loadCr3(0);
  assert.equal(paging.translate(0x2345),0x2345);
  assert.equal(paging.read(0x2345,1)[0],0x6a);
  put32(0,0x2083); // reserved alignment bit
  paging.flush();
  assert.throws(() => paging.translate(0x2345), error => error instanceof PageFault && error.reserved);
});


test("legacy paging snapshots preserve CR3 and controls but discard cached translations", async () => {
  const { X86LegacyPaging32 } = await import("../packages/runtime/src/mmu.js");
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const put32 = (address, value) => memory.write(address, Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255));
  put32(0, 0x1007);
  put32(0x1000, 0x2007);
  const original = new X86LegacyPaging32(memory, { pse: true, writeProtect: true });
  original.loadCr3(0);
  assert.equal(original.translate(0), 0x2000);
  const state = original.snapshot();
  const restored = new X86LegacyPaging32(memory);
  restored.restore(state);
  assert.equal(restored.cr3, 0n);
  assert.equal(restored.pse, true);
  assert.equal(restored.writeProtect, true);
  assert.equal(restored.translate(0), 0x2000);
  assert.throws(() => restored.restore({ ...state, cr3: "4096" }), RangeError);
  assert.throws(() => restored.restore({ ...state, writeProtect: "false" }), TypeError);
});

test("legacy 4 MiB page permits the PAT bit but rejects reserved alignment bits", async () => {
  const { X86LegacyPaging32 } = await import("../packages/runtime/src/mmu.js");
  const memory = new GuestMemory({ initialPages: 5, maximumPages: 5 });
  const put32 = (address, value) => memory.write(address, Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255));
  put32(0, 0x1083); // PS=1, PAT(bit 12)=1, physical base remains 0.
  const paging = new X86LegacyPaging32(memory, { pse: true });
  paging.loadCr3(0);
  assert.equal(paging.translate(0x2345), 0x2345);
  put32(0, 0x2083); // bit 13 is reserved in the supported non-PSE-36 model.
  paging.flush();
  assert.throws(() => paging.translate(0x2345), error => error instanceof PageFault && error.reserved);
});
