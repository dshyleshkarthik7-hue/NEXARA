# Deterministic execution, snapshots, and replay

NEXARA's reference x86 interpreter can be wrapped in an explicit asynchronous deterministic facade:

```js
import { DeterministicX86Machine } from "@nexara/x86-core/deterministic-machine";

const machine = await DeterministicX86Machine.create({
  mode: 32,
  memoryPages: 4,
  maximumPages: 4
});

await machine.loadProgram(Uint8Array.from([0xb8, 42, 0, 0, 0, 0xf4]));
const result = await machine.run();
const recording = machine.exportRecording();

const replay = await DeterministicX86Machine.replay(recording, {
  mode: 32,
  memoryPages: 4,
  maximumPages: 4
});
```

## Guarantees in this implementation

- The facade records program bytes, load address, and entry point.
- Each executed instruction advances an instruction-count virtual clock and appends a state fingerprint to the SHA-256 hash-chained event log.
- Replay verifies the entire event-log chain, re-executes the program on the reference interpreter, and compares each recorded post-instruction CPU fingerprint.
- Snapshots contain the interpreter's CPU/memory/paging save state plus the event log. Restore verifies the log before returning a machine.
- Fork creates an independent machine from a snapshot; identical subsequent operations produce identical event-chain heads.

## Deliberate limits

- This currently records program loading and instruction boundaries; it does not yet intercept every possible host input, device operation, asynchronous event, or nondeterministic source.
- The instruction counter is a logical clock, not wall-clock time or a complete virtual timer/device scheduler.
- Snapshot data currently includes a full guest-memory image. It is not yet Merkle/COW chunked, streamed, or OPFS-backed.
- Replay parity is established only against this JavaScript reference interpreter. It does not establish Rust/Wasm, browser, Firecracker, or KVM parity.
- The recorded CPU fingerprint does not yet include every architectural device or host-side state component.

Use this as an execution/replay foundation, not as a claim of full-system deterministic virtualization.
