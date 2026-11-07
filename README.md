# NEXARA

**Native Execution & Exchange Architecture** — a unified browser-and-server computing workspace.

NEXARA combines a lightweight native editor, an interactive terminal, a secure session gateway, and a runtime boundary designed to host multiple execution backends. The browser is the control surface; server sessions use real operating-system processes and a PTY.

## Current implementation

- Browser workspace with a lightweight editor and terminal client.
- Server-side PTY sessions over WebSocket.
- Session lifecycle, bounded input, resize handling, and origin checks.
- Shared protocol definitions and runtime-backend contract.
- Automated tests for protocol validation and server routes.

## Requirements

- Node.js 20+
- npm 10+
- Linux/macOS for the PTY-backed server (Windows requires a compatible PTY environment).

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173. The API listens on http://localhost:8787.

For a production build:

```sh
npm run build
npm start
```

## Architecture

- `apps/web`: browser workspace, editor, terminal view.
- `apps/server`: HTTP API and PTY/WebSocket session host.
- `packages/protocol`: versioned client/server messages.
- `packages/runtime`: execution-backend interface and capability model.

## Compatibility status

NEXARA does **not** yet claim full x86 32-bit or x86-64 machine compatibility. The runtime package defines the integration boundary; a complete CPU/device/firmware/ABI implementation and its conformance suite remain engineering work. Server PTY sessions execute programs supported by the host OS; they are not virtual machines.

Performance and compatibility claims will be published only with reproducible benchmarks and conformance results.

## Security notes

Bind the server to a trusted interface, configure allowed browser origins, and put it behind authenticated access before exposing it to an untrusted network. PTY sessions execute with the server process user's privileges. Do not run this service as root or expose it publicly without adding user authentication, isolation, quotas, and transport security.

## License

No license has been selected yet. All rights reserved by default; do not assume this repository grants reuse rights.
