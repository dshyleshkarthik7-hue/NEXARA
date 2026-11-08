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

The provider and all adapter callbacks are host-trusted dependencies. In particular, `resolveBaseDevice(digest)` must return a read-only block device whose bytes hash to that digest; it must not accept guest-supplied paths. `authorizeVmRequest({ identity, request })` must enforce tenant quotas, image allowlists, capability grants, egress policy, lease duration, and return a stable `workloadKey` issued by the trusted control plane. The workload key must not come from guest-controlled or arbitrary client fields. It is hashed before persistence and bound to one tenant subject and image digest; rebinding is rejected. The API never signs privileges directly from client input.

## Persistent state layout

- `stateDirectory/vm-registry/<vm-uuid>.json`: host-owned VM storage record (sector geometry, immutable base digest, and overlay filename).
- `stateDirectory/vm-registry/identity-<sha256(workload-key)>.json`: stable host-generated VM UUID bound to the authenticated tenant subject and image digest.
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

The server supports this bootstrap when `NEXARA_EXECUTION_BACKEND=microvm` and exposes authenticated `/api/vms` create/list/stop routes. The separate terminal/PTY API remains a distinct backend and is not silently substituted for Firecracker.


## Real Linux/KVM host validation

A privileged host check is available at `scripts/host-validation.sh`. It verifies Linux root execution, readable/writable `/dev/kvm`, cgroup-v2 CPU/memory/PID controllers, kernel seccomp availability, trusted executable permissions for Firecracker and jailer, and a temporary network namespace whose nftables output-drop counter must increment when an outbound TCP connection is attempted. The probe removes its temporary namespace and veth pair on exit.

Run it only on a disposable or dedicated Linux host configured for NEXARA:

```sh
sudo env FIRECRACKER_BIN=/usr/bin/firecracker JAILER_BIN=/usr/bin/jailer bash scripts/host-validation.sh
```

The manually triggered GitHub Actions workflow `.github/workflows/host-validation.yml` requires a dedicated self-hosted runner labeled `self-hosted, linux, x64, kvm, nexara-host-validation`, with passwordless sudo and repository variables `FIRECRACKER_BIN` and `JAILER_BIN` set to trusted absolute executable paths. Do not attach this label to a shared or untrusted runner. The workflow is intentionally `workflow_dispatch` only; it does not execute privileged host operations for pull requests.

This preflight is not a Firecracker guest boot test. It does not establish that the configured jailer actually installs the expected seccomp filter, cgroup limits, or guest device isolation. Those require a separate disposable KVM host test that launches the configured jailer and Firecracker process, inspects the live process/cgroup/network state, boots a known test guest, performs guest disk writes, and validates persistence after a host restart. Do not infer those results from this preflight passing.


## Stable VM identity and restart path

The production bootstrap wires `PersistentVmRegistry.getOrCreateIdentity()` into `VmSupervisor.resolveVmIdentity`. VM creation therefore requires the trusted control-plane `workloadKey`. The same key, subject and image digest resolve to the same host-generated UUID after restart. The root-disk factory uses `openOrCreate()`: it opens the registered overlay when present and creates it only for a first-time identity. Geometry or base-image changes for an existing UUID fail closed.

The server's `POST /api/vms` route now requires `workloadKey` in the policy returned by the trusted `authorizeVmRequest` adapter and passes it to the supervisor. Existing adapters must be updated to return this key from their authenticated workload mapping. The host calls `supervisor.initialize()` and replays the durable journal before `createMicroVmHost()` resolves; only then should the server listen.

The identity is intentionally not a substitute for a distributed scheduler lock: run one active host owner per VM identity, or add a shared lease/consensus service before multi-host placement.
