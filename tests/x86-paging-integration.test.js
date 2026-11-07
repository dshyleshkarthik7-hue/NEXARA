import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86LegacyPaging32, PageFault } from "../packages/runtime/src/mmu.js";
import { X86Cpu } from "../packages/x86-core/src/index.js";

function put32(memory, address, value) {
  memory.write(address, Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255));
}

test("32-bit CPU fetches instructions through legacy page tables after enabling CR0.PG", () => {
  const memory = new GuestMemory({ initialPages: 8, maximumPages: 8 });
  put32(memory, 0x0000, 0x1007);
  put32(memory, 0x1000, 0x3007);
  memory.write(0x3000, Uint8Array.of(0x90, 0xf4));
  const paging = new X86LegacyPaging32(memory);
  const cpu = new X86Cpu({ memory, mode: 32, legacyPaging32: paging });
  cpu.writeControlRegister(3, 0n);
  cpu.writeControlRegister(0, 0x80000011n);
  assert.equal(cpu.step().ip, 1);
  assert.equal(cpu.step().state, "halted");
});

test("32-bit CPU instruction fetch reports a legacy page fault for a non-present mapping", () => {
  const memory = new GuestMemory({ initialPages: 4, maximumPages: 4 });
  put32(memory, 0x0000, 0x1007);
  const paging = new X86LegacyPaging32(memory);
  const cpu = new X86Cpu({ memory, mode: 32, legacyPaging32: paging });
  cpu.writeControlRegister(3, 0n);
  cpu.writeControlRegister(0, 0x80000011n);
  assert.throws(() => cpu.step(), error => error instanceof PageFault && error.instruction);
});
