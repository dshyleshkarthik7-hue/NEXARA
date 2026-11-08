# Automated two-boot Firecracker validation

NEXARA provides a reusable orchestrator at `packages/security/src/two-boot-validation.js`. It coordinates two sequential boots and validates their evidence. It intentionally does not invent a host provider or assume that the repository's mocked provider is a real Firecracker installation.

## Host adapter contract

A trusted host-side adapter supplies `bootOnce({ bootNumber, stateDirectory, diskId })`. Each invocation must:
1. Construct a **fresh** host instance and supervisor using the same persistent state directory and VM/disk registry.
2. Resolve the same VM identity and COW disk; do not create a new disk for boot two.
3. Launch the configured kernel, initramfs and root disk through the production jailer/provider.
4. Capture the Firecracker serial console output without truncation.
5. Capture the per-VM nftables drop counter immediately before and after the guest's outbound probe.
6. Wait for guest shutdown, complete raw-disk write-back, close the host, and return:
   `{ serialOutput, diskId, hostInstanceId, nftDropCounterBefore, nftDropCounterAfter }`.

The second invocation must reconstruct host state rather than reuse the first supervisor/provider instance. `diskId` must identify the persistent disk resolved from the trusted registry, not a client-supplied label.

## Invoke

```js
import { runTwoBootValidation } from "../packages/security/src/two-boot-validation.js";

const report = await runTwoBootValidation({
  stateDirectory: "/var/lib/nexara",
  diskId: "vm-disk-001",
  bootOnce: trustedKvmHostAdapter.bootOnce
});
```

The orchestrator requires the first boot's write marker and the second boot's persistence marker, guest egress-blocked markers on both boots, increasing per-VM nftables counters on both boots, the same disk identity, and distinct host instance IDs.

## Tests and security boundary

`tests/two-boot-validation.test.js` exercises success and failure cases with a fake adapter. Those tests validate orchestration and evidence rules only. They do not prove Firecracker boot, KVM operation, actual network isolation, disk durability, or power-loss safety.

A real-host adapter must be implemented against the operator's configured jailer, network provider, serial console capture and durable registry. Run only on a dedicated ephemeral KVM runner with trusted image manifests. Retain raw logs, host/kernel/Firecracker versions, image digests, nftables counter snapshots, and registry/disk identifiers. Do not treat this report as an escape-resistance certification.
