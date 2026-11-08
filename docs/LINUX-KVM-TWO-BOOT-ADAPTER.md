# Linux/KVM two-boot host adapter

NEXARA now includes a concrete lifecycle adapter at `packages/security/src/linux-kvm-two-boot-adapter.js`. It joins the two-boot evidence orchestrator to explicit privileged host integration functions.

## Usage

```js
import { executeLinuxKvmTwoBootValidation } from "../packages/security/src/linux-kvm-two-boot-adapter.js";

const report = await executeLinuxKvmTwoBootValidation({
  stateDirectory: "/var/lib/nexara",
  diskId: "stable-broker-disk-id",
  createHost: hostFactory.createFresh,
  resolveDisk: trustedRegistry.resolveDisk,
  bootGuest: firecrackerRunner.bootAndWait,
  readDropCounter: nftables.readPerVmDropCounter
});
```

## Required integration contracts

- `createHost` creates a fresh host stack for each invocation. It must instantiate the real Linux jailer, network namespace provider, Firecracker driver and supervisor, and return a unique host instance ID plus an async `close()`.
- `resolveDisk` resolves the stable disk ID through a trusted persistent VM/storage registry and returns the broker-owned COW device. It must not trust an API-client path or construct a new overlay on boot two.
- `bootGuest` launches the signed kernel/initramfs/root disk, captures the full serial console, waits for guest shutdown, completes driver raw-disk write-back, and returns `serialOutput`, `diskId`, `guestStopped: true`, and `writebackComplete: true`.
- `readDropCounter` reads the actual per-VM nftables rule counter from the relevant namespace/chain, before and after the guest probe.

The adapter closes every host stack in a `finally` path and rejects incomplete shutdown/write-back evidence. The outer orchestrator verifies first-boot write and second-boot persistence markers, disk identity continuity, distinct host instance IDs, and increasing counters on both boots.

## Security and validation boundary

The repository does not yet supply a production `createHost`, trusted persistent registry resolver, Firecracker serial-console runner, or nftables counter reader. These are host-specific privileged integrations and must be implemented with the deployment's actual paths, identity policy and registry format. The included tests use fake functions and prove sequencing/error cleanup only. They do not claim an actual KVM guest boot, successful write-back, power-loss durability or escape resistance.

Do not mark hardware validation complete until the adapter has run on a dedicated KVM host with retained raw serial logs, disk identity evidence, per-VM nftables snapshots, image digests and host/kernel/Firecracker versions.
