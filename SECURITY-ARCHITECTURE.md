# NEXARA security architecture and product differentiators

**Status: target architecture and engineering requirements, not a claim that these controls are all implemented.**

## Security objective

Treat every guest kernel, guest process, imported disk image, browser tab and browser-originated command as untrusted. A guest must not obtain host filesystem, process, network, device or credential access except through narrowly scoped brokered capabilities.

The browser is a control plane and presentation layer. It is not a host security boundary. Host isolation must be enforced by a separate privileged supervisor and the host kernel/hypervisor.

## Threat model

Protect the host and other tenants against:
- Malicious guest kernel code and hostile disk images.
- Guest-to-host escape attempts through emulation, device models, parsers and protocol handlers.
- Cross-tenant memory, storage, network and timing leakage.
- Browser-origin compromise, CSRF, stolen session tokens and malicious extensions.
- Resource exhaustion through CPU loops, memory pressure, disk growth, network floods and output floods.
- Snapshot rollback, image substitution and unauthorized device attachment.

Out of scope for the initial design: protection against a fully compromised host kernel/hypervisor, physical attacks, firmware supply-chain compromise of the operator's hardware, and all side channels. Those require separate mitigations and residual-risk review.

## Required isolation architecture

1. **Unprivileged control plane.** The web/API service authenticates users, validates requests and issues short-lived VM leases. It must never run guest instructions or parse guest disk formats with host privileges.
2. **Isolated execution workers.** Run each VM in a dedicated microVM or equivalent hardened VM boundary. A container alone is not a sufficient boundary for hostile guest kernels. Use a minimal read-only worker image, dedicated UID, namespaces/cgroups/seccomp as defense in depth, no host device passthrough by default, and a separate supervisor.
3. **Capability-based device broker.** Devices are unavailable until a VM lease grants a specific device, operation set, quota and expiry. No guest-controlled host paths, arbitrary file descriptors or unrestricted host sockets. Validate every request at the broker boundary.
4. **Ephemeral per-VM storage.** Immutable, content-addressed base images; copy-on-write overlays; encrypted tenant keys; quota enforcement; explicit discard or retention policy. Never mount the host home directory into a guest.
5. **Default-deny networking.** Each VM receives an isolated virtual interface and policy-controlled egress. Deny host, link-local, metadata-service and private management ranges unless an administrator explicitly grants access. Apply DNS and destination policy in the host-side broker, not only in the guest.
6. **Auditable lifecycle.** Record authenticated lease issuance, image digest, worker identity, device grants, network policy changes, snapshot lineage and shutdown. Do not log guest secrets or raw terminal contents by default.
7. **Resource containment.** Enforce CPU time, memory, disk, process count, I/O, network bandwidth, wall-clock lifetime and output quotas outside the guest. Kill/recycle workers on policy violation.
8. **Safe image intake.** Treat firmware, kernels, bootloaders and disk images as hostile. Verify signatures/digests, scan in disposable workers, parse formats with bounded libraries, and never auto-mount imported files on the host.
9. **Browser defense.** Use strict CSP, Trusted Types where supported, origin allowlists, secure HttpOnly SameSite cookies for browser sessions, CSRF protection, short-lived scoped tokens, WebSocket origin checks, output encoding and no direct browser access to host files.
10. **Recovery and reproducibility.** Snapshots must be versioned, authenticated and bound to VM configuration, device state and image digests. Restoring a snapshot must not silently broaden capabilities or network access.

## Five NEXARA product differentiators (proposed)

These are engineering differentiators to validate, not claims that no competitor can reproduce them.

1. **Capability-sealed VM sessions.** Every VM receives a signed, expiring lease that binds tenant, image digest, CPU/memory quotas, device capabilities, network policy and storage scope. A snapshot restore cannot elevate the lease.
2. **Deterministic checkpoint and replay timeline.** Capture versioned virtual-device events and guest-visible nondeterminism alongside snapshots, enabling reproducible debugging and rollback. This requires deterministic device models and careful handling of time, randomness and asynchronous I/O; full determinism is not guaranteed until measured.
3. **Zero-trust device broker.** Serial, keyboard, display, storage, clipboard, file import/export and networking are separate brokered capabilities. Each has independent policy, quotas, audit events and revocation rather than a broad "VM can access host" permission.
4. **Disposable browser-to-microVM workspaces.** A browser workspace can request an isolated VM lease, transfer only explicitly selected files through a scanning gateway, and destroy the worker plus ephemeral overlay at session end. The browser never receives host filesystem access.
5. **Verifiable VM provenance.** A reproducible manifest binds guest image digests, firmware, device model versions, CPU feature profile, isolation policy and snapshot lineage. Operators can compare the manifest and audit events to detect drift; this is provenance, not proof that a guest is safe.

## Current repository reality

The current server starts node-pty shells as the server process user. That is not a VM and is not safe for hostile multi-tenant workloads. The server now fails closed by disabling this unsandboxed PTY endpoint unless NEXARA_ALLOW_UNSANDBOXED_HOST_PTY=true is explicitly set. Enabling it is restricted to loopback binds. It is intended only for trusted local development and must not be used as a substitute for isolation.

The x86 interpreter is experimental and incomplete. A signed capability-lease primitive exists in packages/security, but it is not yet enforced by a supervisor. No microVM supervisor, hardware virtualization backend, virtual device broker, firmware implementation, bootable guest image pipeline or Linux shell has been completed.

The CPU now has a narrowly scoped 32-bit protected-mode ring-transition implementation: validated GDT system-descriptor decoding and LTR for an available 32-bit TSS, TSS ring-stack selection, present non-conforming IDT code-target validation, ring-3-to-ring-0 interrupt frames (including old SS:ESP), atomic segment-cache/CPL commit after the frame write, and outer-ring IRET restoration. Regression tests cover the normal transition, IRET, invalid stack selectors, absent target code descriptors, stack underflow and out-of-guest-memory frame writes. This path is not enabled as a security boundary: ring-3-to-ring-0 frame writes now use supervisor permissions through the legacy 32-bit paging backend and are tested against a supervisor-only stack mapping, but complete exception delivery and nested-fault escalation remain incomplete. A bounded 64-bit TSS model, 16-byte long-mode TSS descriptor decoding, and long-mode LTR/LLDT loading have also been added; long-mode interrupt delivery now uses 64-bit IDT gates and TSS RSP/IST stack pointers, with 64-bit IRET restoration tested for both RSP0 and IST. The long-mode path also preflights translated frame pages before writing. Automatic exception classification, double-fault/triple-fault escalation and the full task-switch machinery remain incomplete. The CPU also has an explicit exception-entry API with caller-supplied 32-bit error-code frames and preflight of every target page before any frame bytes are committed. Address-space-backed guest data accesses now propagate CPL user/supervisor permissions; regression tests verify ring-3 cannot read or write supervisor-only pages. An opt-in exception-delivery mode now dispatches page faults with their hardware error code, attempts #DF if #PF entry fails, and reports a triple fault if #DF entry also fails. It does not yet classify all architectural exceptions or implement the full Intel contributory-fault/double-fault matrix. The 32-bit TSS model now exposes the hardware backlink and saved task register image. `X86Cpu.saveTaskStateToTss()` captures the live 32-bit CPU context into the active busy TSS in one bounded memory write; `loadTaskStateFromTss()` validates EFLAGS, CS, SS and data selectors on temporary segment state before committing the live registers. These are explicit state primitives only: they are not task-switch instructions, do not load a new TR, require paging disabled, and require the TSS LDTR selector to match the already-loaded LDTR. A bounded hardware task-switch path now handles 32-bit protected-mode far JMP to an available GDT TSS. It validates the incoming TSS and segment state before mutation, saves the outgoing task image, flips the old/new TSS busy bits, loads CR3 with paging disabled, and commits incoming registers, EFLAGS, LDTR, TR and segment state. It deliberately rejects task-switch CALL, task gates, nested-task IRET, paging-enabled TSS accesses, and unsupported descriptor/fault corner cases; complete task-switch fault rollback is not claimed. The paging-aware transition, descriptor-backed LLDT/LTR validation, 64-bit TSS, long-mode RSP0/IST interrupt delivery, IRET, exception error-code frames, supervisor-only mapping tests, and CPU TSS context save/restore primitives passed GitHub Actions: 190 tests passed, zero failed, and the browser build/package job completed successfully. The suite now includes far-JMP-to-TSS task-switch execution and busy-target rejection tests. The suite includes available/busy/not-present TSS descriptor cases, TSS size bounds, LLDT descriptor loading, automatic page-fault/double-fault tests, CPL access-control tests, and task context save/restore validation.

## Acceptance gates before public/untrusted use

- Demonstrate a guest escape test suite against the selected microVM/hypervisor boundary.
- Verify tenant separation for memory, storage, network and API credentials.
- Verify host filesystem and metadata-service denial from guest networks.
- Verify cgroup/hypervisor quotas under adversarial exhaustion tests.
- Fuzz CPU, firmware, storage, network and image parsers in disposable workers.
- Verify signed image manifests and snapshot anti-tamper/lineage checks.
- Perform external penetration testing and publish a threat model with residual risks.
- Keep unsandboxed host PTY disabled in production builds and deployments.

## Engineering sequence

1. Select a supported host isolation backend and define a versioned supervisor protocol.
2. Implement VM leases, image digests, policy enforcement and lifecycle auditing.
3. Build the virtual device broker and default-deny network path.
4. Add firmware and bootable 32-bit guest support, then expand CPU/OS compatibility.
5. Add deterministic record/replay and provenance verification after device behavior is stable.
6. Run conformance, fuzz, escape, performance and recovery suites before claiming readiness.
