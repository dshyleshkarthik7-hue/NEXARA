import test from "node:test";
import assert from "node:assert/strict";
import { DeterministicX86Machine } from "../packages/x86-core/src/deterministic-machine.js";

const program = Uint8Array.from([0xb8, 42, 0, 0, 0, 0xf4]);

test("deterministic x86 wrapper records each instruction and replays identical state", async () => {
  const machine = await DeterministicX86Machine.create({ mode: 32, memoryPages: 2, maximumPages: 2 });
  await machine.loadProgram(program);
  const result = await machine.run();
  assert.equal(result.state, "halted");
  assert.equal(result.instructionsExecuted, 2);
  const recording = machine.exportRecording();
  assert.equal(recording.tick, 2);
  const replay = await DeterministicX86Machine.replay(recording, { mode: 32, memoryPages: 2, maximumPages: 2 });
  assert.equal(replay.instructionsReplayed, 2);
  assert.deepEqual(replay.state, result.machine);
  assert.equal(replay.eventLogHead, recording.head);
});

test("deterministic machine snapshots restore and fork independent execution branches", async () => {
  const machine = await DeterministicX86Machine.create({ mode: 32, memoryPages: 2, maximumPages: 2 });
  await machine.loadProgram(program);
  await machine.step();
  const snapshot = machine.snapshot();
  const restored = await DeterministicX86Machine.restore(snapshot);
  const fork = await DeterministicX86Machine.fork(snapshot);
  assert.deepEqual(restored.state, machine.state);
  await restored.step();
  assert.equal(restored.state.halted, true);
  assert.equal(fork.state.halted, false);
  await fork.step();
  assert.equal(fork.state.halted, true);
  assert.equal(restored.eventLog.head, fork.eventLog.head);
});

test("deterministic replay rejects altered expected CPU state", async () => {
  const machine = await DeterministicX86Machine.create({ mode: 32, memoryPages: 2, maximumPages: 2 });
  await machine.loadProgram(program);
  await machine.step();
  const recording = machine.exportRecording();
  const altered = structuredClone(recording);
  altered.events[1].payload.state.registers.eax = "999";
  // Re-hashing is intentionally not possible without changing the chain; the verifier rejects tampering first.
  await assert.rejects(DeterministicX86Machine.replay(altered, { mode: 32, memoryPages: 2, maximumPages: 2 }), /hash mismatch/);
});

test("deterministic wrapper preserves MMU mappings across snapshots", async () => {
  const machine = await DeterministicX86Machine.create({ mode: 32, memoryPages: 2, maximumPages: 2, virtualMemory: true });
  await machine.loadProgram(Uint8Array.from([0xf4]));
  machine.machine.addressSpace.protect(0x1000n, { read: false, write: false });
  const snapshot = machine.snapshot();
  const restored = await DeterministicX86Machine.restore(snapshot);
  assert.throws(() => restored.machine.readMemory(0x1000, 1), error => error.name === "PageFault");
});
