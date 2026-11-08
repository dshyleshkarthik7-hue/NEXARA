# Persistent VM identity and storage registry

`PersistentVmStorageRegistry` binds a stable VM UUID to a broker-owned COW overlay, its geometry, and the immutable base-image digest. Registry metadata is stored separately from overlays under private host directories.

## Configure

```js
import { PersistentVmStorageRegistry } from "../packages/security/src/persistent-vm-storage-registry.js";
import { DurableRecoveryJournal } from "../packages/security/src/durable-recovery-journal.js";
import { VmSupervisor } from "../packages/security/src/vm-supervisor.js";

const storage = new PersistentVmStorageRegistry({
  directory: "/var/lib/nexara/registry",
  overlayDirectory: "/var/lib/nexara/overlays",
  // Must resolve a digest to a verified, immutable, read-only host image.
  resolveBaseDevice: trustedImageStore.openReadOnlyBase
});

const journal = new DurableRecoveryJournal({
  directory: "/var/lib/nexara/recovery"
});

const supervisor = new VmSupervisor({
  // workloadKey is a host-control-plane identifier, not guest input.
  resolveVmIdentity: ({ workloadKey, subject, imageDigest }) =>
    storage.getOrCreateIdentity({ workloadKey, subject, imageDigest }),
  authority,
  driver,
  recoveryJournal: journal,
  resolveRecoveryDevice: vmId => storage.resolveForRecovery(vmId),
  rootDiskFactory: ({ id, quotas, imageDigest }) => storage.createDevice({
    vmId: id,
    sectors: Math.floor(quotas.diskMiB * 1024 * 1024 / 512),
    baseDigest: trustedImageStore.baseDigestFor(imageDigest)
  }),
  releaseRootDisk: async (vmId, device) => {
    // Close the active COW handle after Firecracker has completed write-back.
    // Keep its registry record and overlay so the next host can reopen it.
    await device.close();
  }
});

// Startup barrier: do not expose the VM API until this resolves.
await supervisor.initialize();
startVmAdmission(supervisor);
```

The example is an integration pattern; adapt the image-store calls and root disk sizing to the deployment's signed lease schema. In particular, production cleanup must close the active COW handle and must not delete an overlay while a durable recovery record references its VM.

## Guarantees and boundaries

- Registry records contain a UUID, fixed overlay filename, sector count and SHA-256 base digest; clients cannot choose filesystem paths.
- Overlay creation requires a trusted, read-only base device whose geometry matches.
- Registry and overlay directories must be private and non-symlink directories.
- Reconstructed devices reopen the existing overlay with `create: false`.
- `resolveForRecovery` supplies a bounded-lifetime import adapter for durable journal replay.
- Journal replay remains a supervisor startup barrier when configured.

The registry does not itself authenticate the image store, encrypt disks, coordinate multi-host distributed locking, or make storage durable against hardware that lies about flushes. The current registry is host-local; shared multi-host scheduling requires a distributed lease/consensus mechanism.


## Stable VM identity

The registry's `getOrCreateIdentity({ workloadKey, subject, imageDigest })` stores a random host-generated UUID under a SHA-256 hash of the host control-plane workload key. The supervisor can use it through `resolveVmIdentity` so a restarted supervisor receives the same VM UUID and therefore reopens the same registered overlay. The workload key must come from an authenticated host control plane; never accept a guest-provided key. A workload key is bound to one tenant subject and image digest; rebinding is rejected.

The supervisor now passes the broker-owned disk handle to `releaseRootDisk(vmId, device)`. Close the handle after the driver has stopped and completed write-back, but retain the registry record and overlay for subsequent restarts. Do not remove the persistent storage record as part of an ordinary VM stop.
