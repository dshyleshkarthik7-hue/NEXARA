# NEXARA

**Native Execution & Exchange Architecture** — a browser-and-server computing workspace with an experimental x86 interpreter.

NEXARA currently combines a browser editor/workspace, a server session gateway, guest-memory and virtual-address-space primitives, and an experimental x86 execution backend. It is not yet a complete virtual machine or a bootable operating system environment.

## Implemented components

- Browser workspace with multi-file navigation, IndexedDB autosave, import/export, and a local x86 bytecode runner for the implemented instruction subset.
- Server HTTP/WebSocket session gateway, authenticated PTY session registry, per-client quotas, rate limits, idle expiry, and origin allowlisting.
- Unsandboxed host PTY execution disabled by default. An explicit trusted-local opt-in is restricted to loopback binding.
- Bounded guest memory, snapshots, software virtual mappings, four-level x86-64 page-table walking, and a legacy non-PAE 32-bit paging path.
- Deterministic host-trapped BIOS keyboard and clock subset: INT 16h key peek/read with an injected 16-bit BIOS key queue, and INT 1Ah tick reads with explicit tick advancement and midnight rollover. Empty keyboard reads are deliberately non-blocking and report ZF rather than waiting on host input; this is not a real-time PIT/RTC or keyboard-controller implementation.
- Host-trapped legacy BIOS service subset: INT 13h disk reset, CHS geometry query, bounded CHS reads, and EDD installation/LBA reads through a validated disk-address packet (including track and 64-KiB DMA-boundary checks), plus INT 10h teletype output. These are synchronous host services, not BIOS ROM code or a firmware/POST implementation.
- Experimental 16-bit real-mode interpreter for a documented instruction subset: 16-bit general registers, immediate MOV, register INC/DEC, ModR/M register and 16-bit memory MOV/XOR/ADD/SUB/CMP forms, accumulator-immediate ADD/SUB/CMP, segment-register MOV, ES/CS/SS/DS overrides for supported operands, conditional branches, LOOP, CLD/STD, direct accumulator memory MOV, MOVS/STOS/LODS/CMPS/SCAS byte/word string operations with REP/REPE/REPNE handling, shift/rotate groups, stack PUSH/POP, near and far CALL/JMP/RET, CLI/STI, software INT/IRET via the IVT, a subset of arithmetic flags, HLT, 20-bit address wrapping with optional A20 enable, and bounded instruction execution. A validated 512-byte disk sector can be staged at 0x7C00 and then executed by this interpreter in an integration test. BIOS service support is host-trapped and limited; this is not full 8086 compatibility, firmware, or a complete boot environment.
- Legacy boot-sector staging primitive validates the 0x55AA signature and disk bounds, then copies one 512-byte sector to physical 0x7C00 and reports conventional CS:IP and BIOS drive handoff metadata. The real-mode CPU can then execute the staged sector; a deterministic test assembles a tiny instruction sequence into a 512-byte image, stages it, executes it, and checks guest memory. This remains a narrow loader-to-interpreter integration path, not BIOS ROM/POST, firmware, or a general-purpose boot implementation.
- Bounded in-memory sector block device with 512-byte sector reads/writes, read-only mode, capacity checks, and snapshot/restore support; experimental primary-channel ATA PIO model integrated into the PC I/O fabric for IDENTIFY and bounded multi-sector LBA28 READ/WRITE commands, with in-flight controller transfer snapshots. This is not a complete ATA/ATAPI or AHCI implementation, and firmware boot is not implemented.
- Experimental 32/64-bit x86 integer interpreter with a limited instruction set, CPU/memory save-state support, selected control-register/MSR operations, and guest I/O bus instructions.
- Bounded GDT/LDT/IDT readers, GDTR/IDTR/LDTR/TR state, selected LGDT/LIDT/LLDT/LTR instructions, 32-bit and 64-bit TSS descriptor validation, 32-bit TSS I/O bitmap enforcement, 64-bit TSS RSP/IST state, long-mode IDT interrupt delivery, and constrained protected-mode privilege-transition paths.
- PC/AT-style PIC/PIT device models and interrupt-fabric integration.
- Signed VM capability leases with per-operation storage/network authorization, lease-bound lifecycle orchestration, persistent per-VM file-backed block devices, sparse sector-level copy-on-write overlays bound to the SHA-256 digest and geometry of a read-only base image, and broker-mediated sector I/O. Overlay metadata persists across reopen; writes allocate sectors in the overlay and reads fall through to the immutable base until changed. These are host-side primitives and a driver interface, not yet a Firecracker-compatible qcow2/raw overlay or production host storage service.
- DNS-pinned egress policy adapter that rejects private, loopback, link-local, reserved, documentation and other non-global addresses (including mixed public/private DNS answer sets); callers must use its pinned lookup callback and re-authorize redirects. This is a policy adapter, not an installed host firewall or virtual NIC.\n- Firecracker API configuration driver plus Linux jailer and network providers: provisions a per-VM Linux network namespace and TAP device, installs default-deny nftables input/output/forward policies, launches the upstream jailer with cgroup-v2 CPU/memory/swap/process limits and an unprivileged UID/GID, verifies guest artifact digests, stages kernel/rootfs files inside the jail with least-privilege permissions, and attaches the per-VM TAP to Firecracker. The network adapter intentionally provides no uplink or egress until separately configured. The host still must provide trusted root-managed binaries, cgroup-v2 delegation, and required Linux capabilities; these adapters have not been validated on a production Linux/KVM host.
- Automated tests for the implemented CPU, memory, paging, descriptor, interrupt, I/O, device, protocol, workspace, and session subsets.

## Requirements and run

- Node.js 20+
- npm 10+
- Native build prerequisites for `node-pty`

```sh
npm install
npm run dev
```

Open http://localhost:5173. The API listens on http://localhost:8787.

```sh
npm run build
npm test
npm start
```

Create a source distribution ZIP (includes the production browser build):

```sh
npm run package
```

The ZIP is written to `dist/NEXARA-package.zip`. This is a source distribution, not a self-contained native executable.

## Repository layout

- `apps/web`: browser workspace and terminal client.
- `apps/server`: HTTP API, authenticated session host, and sandbox policy.
- `packages/protocol`: validated client/server messages.
- `packages/runtime`: guest memory, paging, and PC device models.
- `packages/x86-core`: bounded x86 interpreter, descriptor/segment state, TSS and backend adapter.
- `packages/security`: signed leases, capability broker, VM lifecycle coordinator, DNS-pinned egress policy adapter, Firecracker API driver, Linux jailer provider, per-VM Linux network namespace/TAP/nftables provider, and sparse copy-on-write block-device adapter.
- `packages/workspace`: browser workspace persistence.
- `tests`: automated regression suite.

## x86 compatibility status

The x86 core is an **experimental interpreter**, not a hardware-accelerated VM and not a complete x86 implementation. It supports a limited 32/64-bit integer instruction subset. Implemented foundations include guest memory, selected address translation and paging behavior, descriptor-table decoding, segment caches, selected privileged instructions, I/O permission checks using a 32-bit TSS bitmap, PIC/PIT device models, and selected interrupt delivery.

A constrained 32-bit protected-mode interrupt path now supports present IDT interrupt/trap gates, ring-3-to-ring-0 stack switching through a validated busy 32-bit TSS, old SS:ESP frame construction, same-ring frames, IRET restoration to an outer privilege level, and an explicit protected-mode exception-entry API that can push caller-supplied CPU error codes. The transition path validates code/stack selectors before changing segment state and preflights all target pages with supervisor permissions before writing a frame, avoiding partial frame writes when a later page faults. Privilege-changing ring-3-to-ring-0 stack switches are now exercised with the legacy 32-bit paging backend: interrupt frames are written with supervisor permissions to a supervisor-only mapped stack page, while ordinary user-mode accesses retain user permission checks. The CPU also has a bounded 64-bit TSS data model, 16-byte long-mode TSS descriptor decoding, descriptor-backed LTR/LLDT loading with available/present/type and size checks. The 32-bit TSS model exposes the hardware backlink and saved register image, and the CPU provides validated `saveTaskStateToTss()` / `loadTaskStateFromTss()` context primitives. The saved register image is committed with one bounded memory write; restore validates CS, SS and data selectors on temporary segment state before committing CPU registers. These primitives now access the TSS through the active 32-bit paging backend when paging is enabled; the loaded LDTR must still match the TSS image. A bounded 32-bit protected-mode far JMP to an available GDT TSS now performs a hardware task switch: validates the incoming TSS and segment image, saves the outgoing context, updates old/new TSS busy bits, loads the incoming CR3, and commits the incoming registers, flags, LDTR, TR and segment state. TSS and GDT/LDT descriptor accesses use linear-address translation, and incoming selectors are prevalidated against a temporary view of the incoming CR3 before the live switch. The bounded path also supports 32-bit far CALL to an available GDT TSS and 32-bit IDT task gates. CALL/task-gate switches set the incoming backlink and NT flag while retaining the outgoing TSS busy bit; task-gate exception error codes are pushed on the incoming task's stack. Incoming CR3 is checked before commit. NT-marked 32-bit IRET now returns to the busy TSS named by the current task's backlink, clears the outgoing task's busy bit, preserves the backlink task's busy state, and restores its saved CPU context. Transactional rollback of modeled CPU and guest-memory state on task-switch commit failures is implemented and regression-tested, with partial #PF/#GP metadata preservation; complete architectural fault classification, rollback of external device/host side effects, 16-bit TSS task switching, and the full set of descriptor/exception corner cases remain unsupported. The CPU also supports 64-bit IDT interrupt/trap gate delivery, RSP0-2 and IST1-7 stack selection, 64-bit interrupt frames, and outer-ring IRET restoration. These long-mode interrupt paths are tested with both direct guest memory and a supervisor-only virtual mapping. Address-space-backed data accesses now carry CPL user/supervisor permissions, and tests verify ring-3 reads and writes cannot access supervisor-only pages. Opt-in automatic page-fault dispatch with CPU error codes and a bounded double-fault/triple-fault fallback is implemented. call gates, complete classification and delivery for every architectural exception, contributory-fault pairing, full descriptor privilege corner cases, complete EFLAGS semantics, and complete x86 segmentation semantics remain unsupported.

The current loader-plus-interpreter path can stage and execute a minimal boot-sector image, but NEXARA does not yet boot firmware, run a general-purpose bootloader, provide a Linux-compatible machine, or run an unmodified guest OS. It does not implement the full x86 ISA, complete APIC/PCI/USB/storage/network device sets, firmware, ACPI, UEFI/BIOS, or Linux ABI. Passing the current regression suite only validates the implemented subset; it is not an x86 conformance or security certification.

## Host security boundary

The browser is not a host security boundary. The PTY backend runs host processes and is not a VM. The server disables unsandboxed PTY sessions by default; the explicit opt-in is only for trusted local development and is rejected on non-loopback binds. The Docker sandbox policy drops capabilities, disables networking, uses a read-only root filesystem, and applies resource limits. gVisor (`runsc`) adds a syscall isolation layer but still relies on the host kernel; Kata runtime is reported separately as a VM-backed kernel boundary. Neither has been integrated into a dedicated, separately privileged supervisor or independently escape-tested.

Before untrusted multi-tenant use, NEXARA still needs host-enforced virtual networking and firewall rules, broker integration into the actual VM device path, copy-on-write image overlays and robust image intake, firmware and a bootable guest pipeline, a concrete host network/TAP provisioning service, production Linux/KVM validation, adversarial escape tests, fuzzing, and independent security review. The current supervisor is a lifecycle coordinator requiring an externally supplied microVM driver; the egress adapter pins DNS answers but does not itself install host firewall rules. See [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md).

## Release gates and completion status

NEXARA has no single defensible completion percentage: the repository contains several distinct products (browser workspace, experimental x86 interpreter, and a Firecracker-backed microVM host), and passing one subsystem's tests does not establish completion of the others.

The application regression workflow and shell-level validation fixtures are automated. The native host-bundle pipeline is still being brought to a reproducible green build; its previous CI failure was in the BusyBox build configuration and is being corrected. The real-KVM workflow is intentionally gated on a successful bundle build and a separately managed self-hosted Linux runner. A skipped KVM workflow is **not** a successful hardware test.

Before claiming a production-ready Linux-capable microVM, the remaining release gates are:
- A clean CI build of Firecracker, jailer, static BusyBox, kernel, initramfs and persistent ext4 test disk, followed by bundle checksum/format verification.
- A real KVM two-boot run proving the same ext4 disk persists data across Firecracker restarts.
- Live verification of jailer-applied seccomp, NoNewPrivs, non-root identity, namespaces and cgroup limits on the dedicated runner.
- A separately measured host firewall/TAP policy test; no guest egress-blocking claim is made by the current guest image.
- Adversarial lifecycle, image-intake, network-policy and isolation tests, plus independent security review.
- Firmware/bootloader support, broader x86 and virtual-device compatibility, broker integration into the actual VM device path, and an unmodified Linux guest boot remain separate product milestones and are not delivered by the current smoke test.

The current build and KVM workflows provide repeatable gates, not a certification. Do not deploy this repository as an untrusted multi-tenant VM service until the host-level and security release gates above have passed.

## Configuration

- `HOST`: bind address (default `127.0.0.1`).
- `PORT`: HTTP/WebSocket port (default `8787`).
- `ALLOWED_ORIGINS`: comma-separated browser origins.
- `NEXARA_MAX_SESSIONS`: concurrent PTY session ceiling.
- `NEXARA_MAX_SESSIONS_PER_CLIENT`: active sessions per client ceiling.
- `NEXARA_SESSION_CREATE_LIMIT`: session creation attempts per client per minute.
- `NEXARA_SESSION_IDLE_MS`: idle PTY lifetime.
- `NEXARA_SHELL`: shell executable override.
- `NEXARA_ALLOW_UNSANDBOXED_HOST_PTY`: explicit trusted-local-development opt-in only.
- `NEXARA_WORKDIR`: initial working directory.

## License

No license has been selected. All rights reserved by default; do not assume this repository grants reuse rights.
