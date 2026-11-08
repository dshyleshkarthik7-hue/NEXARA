# NEXARA

**Native Execution & Exchange Architecture** — a browser-and-server computing workspace with an experimental x86 interpreter.

NEXARA currently combines a browser editor/workspace, a server session gateway, guest-memory and virtual-address-space primitives, and an experimental x86 execution backend. It is not yet a complete virtual machine or a bootable operating system environment.

## Implemented components

- Browser workspace with multi-file navigation, IndexedDB autosave, import/export, and a local x86 bytecode runner for the implemented instruction subset.
- Server HTTP/WebSocket session gateway, authenticated PTY session registry, per-client quotas, rate limits, idle expiry, and origin allowlisting.
- Unsandboxed host PTY execution disabled by default. An explicit trusted-local opt-in is restricted to loopback binding.
- Bounded guest memory, snapshots, software virtual mappings, four-level x86-64 page-table walking, and a legacy non-PAE 32-bit paging path.
- Experimental 32/64-bit x86 integer interpreter with a limited instruction set, CPU/memory save-state support, selected control-register/MSR operations, and guest I/O bus instructions.
- Bounded GDT/LDT/IDT readers, GDTR/IDTR/LDTR/TR state, selected LGDT/LIDT/LLDT/LTR instructions, 32-bit and 64-bit TSS descriptor validation, 32-bit TSS I/O bitmap enforcement, 64-bit TSS RSP/IST state, long-mode IDT interrupt delivery, and constrained protected-mode privilege-transition paths.
- PC/AT-style PIC/PIT device models and interrupt-fabric integration.
- Signed VM capability-lease policy primitive. It is not yet enforced by a production microVM supervisor or device broker.
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
- `packages/security`: signed capability-lease policy primitive.
- `packages/workspace`: browser workspace persistence.
- `tests`: automated regression suite.

## x86 compatibility status

The x86 core is an **experimental interpreter**, not a hardware-accelerated VM and not a complete x86 implementation. It supports a limited 32/64-bit integer instruction subset. Implemented foundations include guest memory, selected address translation and paging behavior, descriptor-table decoding, segment caches, selected privileged instructions, I/O permission checks using a 32-bit TSS bitmap, PIC/PIT device models, and selected interrupt delivery.

A constrained 32-bit protected-mode interrupt path now supports present IDT interrupt/trap gates, ring-3-to-ring-0 stack switching through a validated busy 32-bit TSS, old SS:ESP frame construction, same-ring frames, IRET restoration to an outer privilege level, and an explicit protected-mode exception-entry API that can push caller-supplied CPU error codes. The transition path validates code/stack selectors before changing segment state and preflights all target pages with supervisor permissions before writing a frame, avoiding partial frame writes when a later page faults. Privilege-changing ring-3-to-ring-0 stack switches are now exercised with the legacy 32-bit paging backend: interrupt frames are written with supervisor permissions to a supervisor-only mapped stack page, while ordinary user-mode accesses retain user permission checks. The CPU also has a bounded 64-bit TSS data model, 16-byte long-mode TSS descriptor decoding, descriptor-backed LTR/LLDT loading with available/present/type and size checks. The 32-bit TSS model exposes the hardware backlink and saved register image, and the CPU provides validated `saveTaskStateToTss()` / `loadTaskStateFromTss()` context primitives. The saved register image is committed with one bounded memory write; restore validates CS, SS and data selectors on temporary segment state before committing CPU registers. These primitives require paging to be disabled and the loaded LDTR to match the TSS image. A bounded 32-bit protected-mode far JMP to an available GDT TSS now performs a hardware task switch: validates the incoming TSS and segment image, saves the outgoing context, updates old/new TSS busy bits, loads CR3 (with paging required to be off), and commits the incoming registers, flags, LDTR, TR and segment state. The bounded path also supports 32-bit far CALL to an available GDT TSS and 32-bit IDT task gates. CALL/task-gate switches set the incoming backlink and NT flag while retaining the outgoing TSS busy bit; task-gate exception error codes are pushed on the incoming task's stack. Incoming CR3 is checked before commit. Task-switch IRET/nested-task return and paging-enabled switches remain unsupported. The CPU also supports 64-bit IDT interrupt/trap gate delivery, RSP0-2 and IST1-7 stack selection, 64-bit interrupt frames, and outer-ring IRET restoration. These long-mode interrupt paths are tested with both direct guest memory and a supervisor-only virtual mapping. Address-space-backed data accesses now carry CPL user/supervisor permissions, and tests verify ring-3 reads and writes cannot access supervisor-only pages. Opt-in automatic page-fault dispatch with CPU error codes and a bounded double-fault/triple-fault fallback is implemented. task-switch IRET/nested-task return, call gates, paging-enabled task switches, complete classification and delivery for every architectural exception, contributory-fault pairing, full descriptor privilege corner cases, complete EFLAGS semantics, and complete x86 segmentation semantics remain unsupported.

The CPU does not yet boot firmware or a disk image, provide a Linux-compatible machine, or run an unmodified guest OS. It does not implement the full x86 ISA, complete APIC/PCI/USB/storage/network device sets, firmware, ACPI, UEFI/BIOS, or Linux ABI. Passing the current regression suite only validates the implemented subset; it is not an x86 conformance or security certification.

## Host security boundary

The browser is not a host security boundary. The PTY backend runs host processes and is not a VM. The server disables unsandboxed PTY sessions by default; the explicit opt-in is only for trusted local development and is rejected on non-loopback binds. The Docker sandbox policy drops capabilities, disables networking, uses a read-only root filesystem, and applies resource limits. gVisor (`runsc`) adds a syscall isolation layer but still relies on the host kernel; Kata runtime is reported separately as a VM-backed kernel boundary. Neither has been integrated into a dedicated, separately privileged supervisor or independently escape-tested.

Before untrusted multi-tenant use, NEXARA still needs a dedicated microVM supervisor, enforceable signed leases, capability-based device and network brokers, per-VM storage isolation, robust image intake, adversarial escape tests, fuzzing, and independent security review. See [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md).

## Current completion estimate

For the broader goal of a **bootable, Linux-capable, securely isolated x86 virtual machine**, the repository is approximately **37% complete**. This is an engineering estimate, not a measured test metric: the workspace, early interpreter, paging-aware 32-bit ring transition, explicit error-code exception frames, opt-in page-fault/double-fault delivery, and 64-bit TSS/LTR/IST interrupt delivery exist, but firmware/boot, broad x86 compatibility, complete hardware task switching, a production microVM supervisor, virtual device stack, Linux guest support, and adversarial security validation are still major unfinished work.

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
