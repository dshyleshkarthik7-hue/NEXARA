# NEXARA

**Native Execution & Exchange Architecture** — a unified browser-and-server computing workspace.

NEXARA combines a lightweight editor, browser terminal client, server session gateway, and a runtime boundary for multiple execution backends. The browser is the control surface; server sessions currently use host operating-system processes through a PTY.

## Current implementation

- Browser workspace with a lightweight editor, multi-file navigation, IndexedDB autosave, text-file import/export, keyboard save/open shortcuts, and a local x86 bytecode runner for the implemented instruction subset.
- IndexedDB-backed browser file storage with bounded text files, normalized paths, per-file revisions, and stale-write conflict detection.
- Server-side PTY sessions over WebSocket.
- Per-session random credentials, constant-time credential comparison, WebSocket origin allowlisting, bounded input, and a configurable session ceiling.
- Reduced environment inheritance for spawned shells.
- PTY session registry with per-client active-session quotas, session-creation rate limits, constant-time per-session credential checks, idle expiry, and shutdown cleanup.
- Shared client/server protocol, bounded guest-memory primitive with snapshots, and a 48-bit virtual address space with software mappings and an optional four-level x86-64 page-table walker, permission checks, cross-page access, CR3 root selection, and x86-style page-fault error codes.
- Experimental x86 interpreter with a limited 32/64-bit integer instruction subset, including byte arithmetic and multiply/divide groups, byte/word sign- and zero-extension, common shifts, signed IMUL, and bounded DIV/IDIV, conservative CPUID feature/vendor reporting, deterministic RDTSC, bounded execution, and validated CPU-plus-memory save-state restoration.
- Automated protocol, memory-boundary, CPU-subset, save-state, and workspace-storage tests.

## Requirements and run

- Node.js 20+
- npm 10+
- A supported native build environment for `node-pty`.

```sh
npm install
npm run dev
```

Open http://localhost:5173. The API listens on http://localhost:8787.

Production build and server:

```sh
npm run build
npm start
```

Create a source distribution ZIP (includes the production browser build):

```sh
npm run package
```

The ZIP is written to `dist/NEXARA-package.zip`. On a fresh machine, extract it, install Node.js 20+ and the native build prerequisites for `node-pty`, then run `npm install` followed by `npm run dev`. This is a source distribution, not a self-contained native executable; the PTY dependency is compiled for the target operating system during installation.

## Architecture

- `apps/web`: browser workspace and terminal client.
- `apps/server`: HTTP API and authenticated PTY/WebSocket session host with bounded session lifecycle controls.
- `packages/protocol`: versioned and validated client/server messages.
- `packages/runtime`: execution-backend contract and guest-memory primitives.
- `packages/x86-core`: bounded x86 interpreter and browser-compatible execution-backend adapter.
- `packages/workspace`: IndexedDB persistence and an in-memory test adapter.
- `tests`: protocol, memory, CPU-subset, workspace persistence, and session lifecycle tests.

## Compatibility status

NEXARA does **not** yet provide full x86 32-bit or x86-64 machine compatibility. The optional MMU mode routes CPU instruction fetches, memory operands, and stack accesses through translation. It supports both direct software mappings and a four-level 48-bit x86-64 page-table walk using guest-physical page-table entries, a configurable CR3 root, present/read-write/user/NX checks, and 4 KiB, 2 MiB, and 1 GiB page leaves. Large-page alignment and reserved-address-bit violations produce reserved-bit page-fault metadata. This remains a partial model: CR0, CR3, CR4 and EFER have validated host-side configuration interfaces, but guest instructions cannot yet execute privileged MOV-to/from-control-register or RDMSR/WRMSR operations. It does not implement PCID, hardware TLB behavior, privilege transitions, or hardware exception delivery. Full compatibility requires instruction execution, privilege and exception semantics, virtual memory, interrupt/timer behavior, firmware and device models, storage, networking, boot support, and Linux ABI conformance. Server PTY sessions execute programs supported by the host OS; they are not virtual machines.

Compatibility and performance claims will be made only against reproducible conformance suites and benchmarks.

## Security boundary

The server defaults to loopback binding. Browser origins are allowlisted, and each PTY session has a separate random secret. These controls are useful hardening but are **not** a complete multi-user security boundary. PTY processes still run with the server process user's OS privileges. Before exposing the service to untrusted networks, add user authentication, per-user authorization, process/container or VM isolation, resource quotas, TLS, audit logging, and deployment-specific threat review. Do not run the service as root.

## Configuration

- `HOST`: bind address (default `127.0.0.1`).
- `PORT`: HTTP/WebSocket port (default `8787`).
- `ALLOWED_ORIGINS`: comma-separated browser origins (default `http://localhost:5173`).
- `NEXARA_MAX_SESSIONS`: maximum concurrent PTY sessions (default `4`).
- `NEXARA_MAX_SESSIONS_PER_CLIENT`: active sessions per client IP (default `2`).
- `NEXARA_SESSION_CREATE_LIMIT`: session creation attempts per client per minute (default `8`).
- `NEXARA_SESSION_IDLE_MS`: idle PTY lifetime in milliseconds (default `1800000`, minimum `60000`).
- `NEXARA_SHELL`: shell executable override.
- `NEXARA_WORKDIR`: initial working directory.

## License

No license has been selected yet. All rights reserved by default; do not assume this repository grants reuse rights.

### x86 execution core status

The repository contains an experimental, deliberately bounded instruction interpreter and runtime adapter in `packages/x86-core`. The adapter creates 32-bit or 64-bit guest machines, loads bounded bytecode programs, runs them under an instruction budget, and saves/restores CPU plus memory state. Set `virtualMemory: true` when creating a machine to enable the integrated software address-space mapper; the initial mapping is identity-mapped and grants read/write/execute/user access. Its tested subset includes NOP, HLT, selected register/immediate MOV operations, MOVSX/MOVZX byte and word extensions, 64-bit MOVSXD, selected base-register memory operands, LEA, FF-group INC/DEC and indirect CALL/JMP/PUSH, ADD/SUB/AND/OR/XOR/CMP/TEST forms, immediate group-1 arithmetic, byte F6 and word/dword/qword F7 integer groups, stack push/pop, direct and indirect CALL/RET, relative and indirect jumps, selected conditional branches, and CPU-plus-memory save-state restoration. It uses the shared guest-memory primitive and an instruction budget. The optional MMU provides software mappings and four-level guest page-table walking for 4 KiB, 2 MiB and 1 GiB pages, with permission checks, CR3 root selection, and NX enforcement gated by EFER.NXE. The CPU exposes validated CR0/CR3/CR4 and EFER configuration and save-state support. A limited guest instruction subset now includes MOV to/from CR0/CR3/CR4 and RDMSR/WRMSR for EFER; these operations have no CPL/ring privilege checks because a privilege model is not implemented. The interpreter does not implement the complete x86 ISA or addressing forms, byte-register encoding rules, segmentation, privilege levels, interrupt delivery, descriptor tables, floating point/SIMD, firmware, devices, or Linux boot. It must not be described as full x86 compatibility.
