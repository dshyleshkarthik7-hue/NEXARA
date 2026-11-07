import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory } from "../packages/runtime/src/index.js";
import { X86Cpu } from "../packages/x86-core/src/index.js";

test("CPU queues validated external interrupt vectors", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const cpu = new X86Cpu({ memory, mode: 32 });
  cpu.requestInterrupt(32);
  cpu.requestInterrupt(32);
  assert.deepEqual(cpu.saveState().pendingInterrupts, [32]);
  assert.throws(() => cpu.requestInterrupt(-1), RangeError);
  assert.throws(() => cpu.requestInterrupt(256), RangeError);
});

test("CPU snapshots preserve pending external interrupts", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const cpu = new X86Cpu({ memory, mode: 32 });
  cpu.requestInterrupt(32);
  cpu.requestInterrupt(46);
  const state = cpu.saveState();
  const restoredMemory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const restored = new X86Cpu({ memory: restoredMemory, mode: 32 });
  restored.loadState(state);
  assert.deepEqual(restored.saveState().pendingInterrupts, [32, 46]);
  state.pendingInterrupts = [999];
  assert.throws(() => restored.loadState(state), /incompatible x86 CPU state/i);
});

test("CPU retains an external interrupt when IDT delivery cannot be completed", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  const cpu = new X86Cpu({ memory, mode: 32 });
  cpu.flags |= 1n << 9n;
  cpu.requestInterrupt(32);
  assert.throws(() => cpu.step(), /interrupt|descriptor|gate|IDT/i);
  assert.deepEqual(cpu.saveState().pendingInterrupts, [32]);
});
