import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86LegacyPaging32 } from "../packages/runtime/src/mmu.js";
import { X86Cpu } from "../packages/x86-core/src/index.js";

function put32(memory, address, value) {
  memory.write(address, Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255));
}

test("CPU snapshots preserve the attached legacy paging backend", () => {
  const memory = new GuestMemory({ initialPages: 8, maximumPages: 8 });
  put32(memory, 0, 0x1007);
  put32(memory, 0x1000, 0x3007);
  memory.write(0x3000, Uint8Array.of(0x90, 0xf4));
  const paging = new X86LegacyPaging32(memory, { pse: true, writeProtect: true });
  const cpu = new X86Cpu({ memory, mode: 32, legacyPaging32: paging });
  cpu.writeControlRegister(3, 0n);
  cpu.writeControlRegister(0, 0x80010011n);
  cpu.step();
  const state = cpu.saveState();
  assert.equal(state.legacyPaging32.format, "nexara-legacy-paging32-v1");
  const restoredMemory = new GuestMemory({ initialPages: 8, maximumPages: 8 });
  const restoredPaging = new X86LegacyPaging32(restoredMemory);
  const restoredCpu = new X86Cpu({ memory: restoredMemory, mode: 32, legacyPaging32: restoredPaging });
  restoredCpu.loadState(state);
  assert.equal(restoredPaging.cr3, 0n);
  assert.equal(restoredPaging.pse, true);
  assert.equal(restoredPaging.writeProtect, true);
  assert.equal(restoredCpu.ip, 1);
  assert.equal(restoredCpu.step().state, "halted");
});

test("CPU rejects paging snapshot state when no legacy paging backend is attached", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const cpu = new X86Cpu({ memory, mode: 32 });
  const state = cpu.saveState();
  state.legacyPaging32 = { format: "nexara-legacy-paging32-v1", cr3: null, pse: false, writeProtect: false };
  assert.throws(() => cpu.loadState(state), /incompatible x86 CPU state/i);
});
