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
  authority,
  driver,
  recoveryJournal: journal,
  resolveRecoveryDevice: vmId => storage.resolveForRecovery(vmId),
  rootDiskFactory: ({ id, quotas, imageDigest }) => storage.createDevice({
    vmId: id,
    sectors: Math.floor(quotas.diskMiB * 1024 * 1024 / 512),
    baseDigest: trustedImageStore.baseDigestFor(imageDigest)
  }),
  releaseRootDisk: async vmId => {
    // Close/release only after driver stop and journal recovery policy permit it.
    await storage.remove(vmId);
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
