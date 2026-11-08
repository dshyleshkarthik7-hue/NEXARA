import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, identifyMachine, parseMachineManifest, validateMachineManifest } from "../packages/machine-format/src/index.js";
import { DeterministicEventLog } from "../packages/machine-format/src/event-log.js";

const digest = "a".repeat(64);
const manifest = {
  schemaVersion: 1,
  cpu: { model: "nexara-reference-v1", mode: 64, architecture: "x86" },
  memoryMiB: 128,
  devices: [{ type: "serial", id: "serial0" }],
  diskLayers: [{ format: "raw", sizeBytes: 0, digest }],
  kernel: null,
  policy: { network: "deny", deterministic: true }
};

test("NMF canonical JSON sorts nested keys independent of insertion order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test("NMF validates and identifies the same machine independent of key order", async () => {
  const first = await identifyMachine(manifest);
  const reordered = await identifyMachine({
    policy: manifest.policy, kernel: null, diskLayers: manifest.diskLayers,
    devices: manifest.devices, memoryMiB: 128,
    cpu: { architecture: "x86", model: "nexara-reference-v1", mode: 64 },
    schemaVersion: 1
  });
  assert.equal(first.digest.length, 64);
  assert.equal(first.digest, reordered.digest);
  assert.equal(first.uri, `nmf:sha256:${first.digest}`);
  assert.deepEqual(parseMachineManifest(first.canonical), first.manifest);
});

test("NMF rejects invalid architecture, mode, digests, and undefined fields", () => {
  assert.throws(() => validateMachineManifest({ ...manifest, cpu: { ...manifest.cpu, architecture: "arm64" } }), /architecture/);
  assert.throws(() => validateMachineManifest({ ...manifest, cpu: { ...manifest.cpu, mode: 16 } }), /mode/);
  assert.throws(() => validateMachineManifest({ ...manifest, diskLayers: [{ ...manifest.diskLayers[0], digest: "bad" }] }), /SHA-256/);
  assert.throws(() => canonicalJson({ bad: undefined }), /Undefined/);
});

test("deterministic event log chains events and advances virtual time", async () => {
  const log = new DeterministicEventLog();
  await log.append("program.load", { bytes: [0x90, 0xf4] });
  log.advance(2);
  await log.append("input", { bytes: [65] });
  const bundle = log.export();
  assert.equal(bundle.events.length, 2);
  assert.equal(bundle.tick, 2);
  assert.equal(bundle.events[1].previousHash, bundle.events[0].hash);
  const restored = await DeterministicEventLog.import(bundle);
  assert.equal(restored.head, log.head);
  assert.equal(restored.tick, 2);
});

test("event log replay verifies chain before invoking deterministic handlers", async () => {
  const log = new DeterministicEventLog();
  await log.append("marker", { label: "boot" });
  log.advance(5);
  await log.append("interrupt", { vector: 32 });
  const seen = [];
  const result = await log.replay({ marker: event => seen.push(event.payload.label), interrupt: event => seen.push(event.payload.vector) });
  assert.deepEqual(seen, ["boot", 32]);
  assert.deepEqual(result, { eventsReplayed: 2, tick: 5, head: log.head });
});

test("event log rejects tampering, reordering, invalid event types, and backward time", async () => {
  const log = new DeterministicEventLog();
  await log.append("marker", { value: 1 });
  const bundle = log.export();
  const tampered = structuredClone(bundle);
  tampered.events[0].payload.value = 2;
  await assert.rejects(DeterministicEventLog.import(tampered), /hash mismatch/);
  await assert.rejects(log.append("wall-clock", { now: Date.now() }), /Unsupported/);
  log.advance(3);
  await assert.rejects(log.append("marker", {}, { tick: 1 }), /backwards/);
});
