# NEXARA microVM host startup

`createMicroVmHost()` is the host bootstrap boundary for Firecracker-backed VMs. It constructs the persistent VM registry, durable disk-recovery journal, Firecracker driver, and VM supervisor as one lifecycle unit.

## Required boot order

Always await host construction before binding an API listener or admitting workloads:

```js
import { createMicroVmHost } from "../../packages/security/src/microvm-host.js";
import { VmLeaseAuthority } from "../../packages/security/src/lease.js";

const host = await createMicroVmHost({
  authority: new VmLeaseAuthority(process.env.NEXARA_VM_LEASE_SECRET),
  provider,                 // trusted LinuxJailerProvider instance
  resolveImage,             // signed/verified immutable image manifest resolver
  resolveBaseDevice,        // trusted resolver keyed by immutable SHA-256 digest
  stateDirectory: "/var/lib/nexara",
  overlayDirectory: "/var/lib/nexara/overlays"
});

// Only now expose host.supervisor to authenticated API handlers and listen.
await server.listen({ host: "127.0.0.1", port: 8788 });

server.addHook("onClose", async () => host.close());
```

The provider and both resolvers are host-trusted dependencies. In particular, `resolveBaseDevice(digest)` must return a read-only block device whose bytes hash to that digest; it must not accept guest-supplied paths. `authorizeVmRequest({ identity, request })` must enforce tenant quotas, image allowlists, capability grants, egress policy, and lease duration, returning the server-approved policy. The API never signs privileges directly from client input.

## Persistent state layout

- `stateDirectory/vm-registry/<vm-uuid>.json`: host-owned VM identity, sector geometry, immutable base digest, and overlay filename.
- `overlayDirectory/<vm-uuid>.overlay`: persistent copy-on-write guest disk.
- `stateDirectory/disk-recovery/<record-uuid>.raw` and `.json`: staged guest disks awaiting write-back.

The registry reopens overlays only after validating private file metadata, geometry, and the immutable base digest. Recovery records are digest-checked and replayed through the registry's trusted VM-ID resolver. If any replay fails, `createMicroVmHost()` rejects and startup remains closed.

## Operational requirements

- Put both storage roots on persistent host filesystems, outside Firecracker jails.
- Provision them with owner-only permissions and restrict access to the host service account.
- Keep image manifests and base-device resolution stable across host restarts.
- Configure the Linux jailer, cgroup-v2 parent, seccomp, network namespace/TAP and default-deny firewall separately.
- Close the returned host during graceful shutdown.
- Exercise this on a Linux host with KVM, Firecracker, jailer and the configured network provider before production use.

The existing terminal/PTY server is a separate backend and does not automatically become a Firecracker API. A deployment that exposes VM operations must await this bootstrap in its own host-service entrypoint and add its own authenticated API layer.
