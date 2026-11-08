import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VmLeaseAuthority } from "../../../packages/security/src/lease.js";
import { createMicroVmHost } from "../../../packages/security/src/microvm-host.js";
import { LinuxJailerProvider } from "../../../packages/security/src/linux-jailer-provider.js";
import { LinuxNetworkProvider } from "../../../packages/security/src/linux-network-provider.js";
import pty from "node-pty";
import { isClientMessage } from "../../../packages/protocol/src/index.js";
import { SessionRegistry } from "./session-registry.js";
import { buildSandboxArgs, sandboxCapabilities } from "./container-policy.js";

const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const allowUnsandboxedHostPty = process.env.NEXARA_ALLOW_UNSANDBOXED_HOST_PTY === "true";
const sandboxImage = process.env.NEXARA_SANDBOX_IMAGE || "";
const sandboxRuntime = process.env.NEXARA_SANDBOX_RUNTIME || "runsc";
const sandboxEnabled = Boolean(sandboxImage);
if (allowUnsandboxedHostPty && !sandboxEnabled && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("Refusing to expose unsandboxed host PTY beyond loopback; deploy an isolated VM backend instead");
}
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "http://localhost:5173").split(",").map(s => s.trim()).filter(Boolean));
const maxSessions = Math.max(1, Number.parseInt(process.env.NEXARA_MAX_SESSIONS || "4", 10) || 4);

const executionBackend = process.env.NEXARA_EXECUTION_BACKEND || "pty";
let microVmHost = null;
let microVmAuth = null;
let microVmAdapter = null;
let vmAuthority = null;
if (executionBackend === "microvm") {
  if (process.platform !== "linux") throw new Error("The microVM backend requires Linux");
  const adapterPath = process.env.NEXARA_MICROVM_ADAPTER;
  const secret = process.env.NEXARA_VM_LEASE_SECRET;
  if (!adapterPath || !path.isAbsolute(adapterPath) || !secret || Buffer.byteLength(secret) < 32) {
    throw new Error("MicroVM mode requires an absolute NEXARA_MICROVM_ADAPTER and a 32-byte NEXARA_VM_LEASE_SECRET");
  }
  const adapterModule = await import(pathToFileURL(adapterPath).href);
  const adapter = typeof adapterModule.createNexaraMicroVmDependencies === "function"
    ? await adapterModule.createNexaraMicroVmDependencies()
    : adapterModule.default;
  if (!adapter || typeof adapter.resolveImage !== "function"
    || typeof adapter.resolveBaseDevice !== "function"
    || typeof adapter.authenticateRequest !== "function"
    || typeof adapter.authorizeVmRequest !== "function") {
    throw new Error("MicroVM adapter must export resolveImage, resolveBaseDevice, authenticateRequest and authorizeVmRequest");
  }
  const networkProvider = new LinuxNetworkProvider({
    ipPath: process.env.NEXARA_IP_PATH || "/usr/sbin/ip",
    nftPath: process.env.NEXARA_NFT_PATH || "/usr/sbin/nft"
  });
  const provider = new LinuxJailerProvider({
    jailerPath: process.env.NEXARA_JAILER_PATH || "/usr/bin/jailer",
    firecrackerPath: process.env.NEXARA_FIRECRACKER_PATH || "/usr/bin/firecracker",
    chrootBaseDir: process.env.NEXARA_JAILER_ROOT || "/srv/jailer",
    uid: Number(process.env.NEXARA_JAILER_UID),
    gid: Number(process.env.NEXARA_JAILER_GID),
    parentCgroup: process.env.NEXARA_PARENT_CGROUP || "nexara",
    networkProvider
  });
  microVmAdapter = adapter;
  vmAuthority = new VmLeaseAuthority(secret);
  microVmAuth = adapter.authenticateRequest;
  microVmHost = await createMicroVmHost({
    authority: vmAuthority,
    provider,
    resolveImage: adapter.resolveImage,
    resolveBaseDevice: adapter.resolveBaseDevice,
    stateDirectory: process.env.NEXARA_VM_STATE_DIR || "/var/lib/nexara",
    overlayDirectory: process.env.NEXARA_VM_OVERLAY_DIR || "/var/lib/nexara/overlays"
  });
} else if (executionBackend !== "pty") {
  throw new Error("NEXARA_EXECUTION_BACKEND must be pty or microvm");
}

const registry = new SessionRegistry({
  maxSessions,
  maxSessionsPerOwner: Math.max(1, Number.parseInt(process.env.NEXARA_MAX_SESSIONS_PER_CLIENT || "2", 10) || 2),
  createLimit: Math.max(1, Number.parseInt(process.env.NEXARA_SESSION_CREATE_LIMIT || "8", 10) || 8),
  idleTimeoutMs: Math.max(60_000, Number.parseInt(process.env.NEXARA_SESSION_IDLE_MS || "1800000", 10) || 1800000)
});

function originAllowed(origin) {
  // Non-browser clients may omit Origin; browser clients must match the allowlist.
  return !origin || allowedOrigins.has(origin);
}

function shellEnvironment() {
  const source = process.env;
  const env = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "SYSTEMROOT", "WINDIR", "PATHEXT"]) {
    if (source[key]) env[key] = source[key];
  }
  env.TERM = "xterm-256color";
  env.HOME ||= os.homedir();
  return env;
}

await app.register(cors, {
  origin(origin, cb) {
    if (originAllowed(origin)) return cb(null, true);
    cb(new Error("Origin not allowed"), false);
  }
});
await app.register(websocket);

app.get("/health", async () => ({ name: "NEXARA", status: "ok", version: 1 }));
app.get("/api/capabilities", async () => ({
  protocolVersion: 1,
  sessionSecurity: { perSessionSecret: true, originAllowlist: true, perClientQuota: true, creationRateLimit: true, idleTimeoutMs: registry.idleTimeoutMs },
  backends: [sandboxCapabilities({ runtime: sandboxRuntime, imageConfigured: sandboxEnabled }), { id: "host-pty", label: "Unsandboxed host process terminal", available: allowUnsandboxedHostPty, machineEmulation: false, isolated: false }, { id: "firecracker-microvm", label: "Firecracker microVM", available: Boolean(microVmHost), machineEmulation: true, isolated: Boolean(microVmHost), recoveryComplete: Boolean(microVmHost) }],
  architectures: { x86: { supported: false }, x86_64: { supported: false } }
}));


if (executionBackend === "microvm") {
  app.post("/api/vms", async (request, reply) => {
    let identity;
    try { identity = await microVmAuth(request); }
    catch { return reply.code(401).send({ error: "Authentication required" }); }
    if (!identity || typeof identity.subject !== "string" || identity.subject.length < 1 || identity.subject.length > 128) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    try {
      const body = request.body || {};
      // Never sign client-selected privileges. The trusted deployment adapter
      // must authorize the requested image and return the complete lease policy.
      const policy = await microVmAdapter.authorizeVmRequest({ identity, request: body });
      if (!policy || typeof policy.imageDigest !== "string") {
        return reply.code(403).send({ error: "VM request is not authorized" });
      }
      const envelope = vmAuthority.issue({
        subject: identity.subject,
        imageDigest: policy.imageDigest,
        quotas: policy.quotas,
        capabilities: policy.capabilities,
        egress: policy.egress,
        ttlMs: policy.ttlMs
      });
      const vm = await microVmHost.supervisor.create({
        envelope, subject: identity.subject, imageDigest: policy.imageDigest
      });
      return reply.code(201).send(vm);
    } catch (error) {
      request.log.warn(error, "MicroVM creation rejected");
      return reply.code(400).send({ error: "VM request could not be admitted" });
    }
  });

  app.get("/api/vms", async (request, reply) => {
    let identity;
    try { identity = await microVmAuth(request); } catch {}
    if (!identity?.subject) return reply.code(401).send({ error: "Authentication required" });
    return microVmHost.supervisor.list().filter(vm => vm.subject === identity.subject);
  });

  app.delete("/api/vms/:id", async (request, reply) => {
    let identity;
    try { identity = await microVmAuth(request); } catch {}
    if (!identity?.subject) return reply.code(401).send({ error: "Authentication required" });
    const vm = microVmHost.supervisor.get(request.params.id);
    if (!vm || vm.subject !== identity.subject) return reply.code(404).send({ error: "VM not found" });
    try {
      await microVmHost.supervisor.stop(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      request.log.error(error, "MicroVM shutdown failed");
      return reply.code(503).send({ error: "VM shutdown failed; host recovery may be required" });
    }
  });
}

app.post("/api/sessions", async (request, reply) => {
  if (!sandboxEnabled && !allowUnsandboxedHostPty) return reply.code(503).send({ error: "No execution backend configured. Configure NEXARA_SANDBOX_IMAGE and a sandbox runtime; unsandboxed host PTY is disabled by default." });
  if (!registry.canCreate(request.ip)) return reply.code(429).send({ error: "Session creation limit or capacity reached" });
  const shell = process.env.NEXARA_SHELL || process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  let session;
  try {
    if (sandboxEnabled) {
      const docker = process.env.NEXARA_CONTAINER_ENGINE || "docker";
      const args = buildSandboxArgs({
        image: sandboxImage,
        runtime: sandboxRuntime,
        memory: process.env.NEXARA_SANDBOX_MEMORY || "512m",
        cpus: process.env.NEXARA_SANDBOX_CPUS || "1",
        pids: Number.parseInt(process.env.NEXARA_SANDBOX_PIDS || "64", 10)
      });
      session = pty.spawn(docker, args, {
        name: "xterm-256color", cols: 100, rows: 30,
        env: { PATH: process.env.PATH || "", TERM: "xterm-256color" }
      });
    } else {
      session = pty.spawn(shell, [], {
        name: "xterm-256color", cols: 100, rows: 30,
        cwd: process.env.NEXARA_WORKDIR || os.homedir(),
        env: shellEnvironment()
      });
    }
  } catch (error) {
    request.log.error(error, "Unable to start PTY process");
    return reply.code(500).send({ error: "Unable to start terminal process" });
  }
  try {
    registry.add(id, { session, token, owner: request.ip });
  } catch (error) {
    session.kill();
    request.log.error(error, "Unable to register PTY session");
    return reply.code(429).send({ error: "Session capacity reached" });
  }
  session.onExit(() => registry.remove(id));
  return reply.code(201).send({ id, token, websocketPath: `/api/sessions/${id}/stream` });
});

app.get("/api/sessions/:id/stream", { websocket: true }, (socket, request) => {
  const origin = request.headers.origin;
  if (!originAllowed(origin)) {
    socket.close(1008, "Origin not allowed");
    return;
  }
  const entry = registry.authorize(request.params.id, request.query?.token);
  if (!entry) {
    socket.close(1008, "Invalid session credentials");
    return;
  }
  const { session } = entry;
  session.onExit(() => socket.close(1001, "PTY process exited"));
  const onData = session.onData(data => {
    registry.touch(request.params.id);
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(1013, "Client is not reading terminal output");
      return;
    }
    socket.send(JSON.stringify({ type: "output", data }));
  });
  socket.on("message", raw => {
    if (raw.length > 16 * 1024) {
      socket.close(1009, "Message too large");
      return;
    }
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (!isClientMessage(message)) return;
    registry.touch(request.params.id);
    if (message.type === "input") session.write(message.data);
    if (message.type === "resize") session.resize(message.cols, message.rows);
  });
  socket.on("close", () => onData.dispose());
  socket.on("error", () => onData.dispose());
});

app.delete("/api/sessions/:id", async (request, reply) => {
  const entry = registry.authorize(request.params.id, request.headers["x-session-token"]);
  if (!entry) return reply.code(404).send({ error: "Session not found" });
  entry.session.kill();
  registry.remove(request.params.id);
  return reply.code(204).send();
});

const idleSweep = setInterval(() => registry.sweepIdle(), 60_000);
idleSweep.unref?.();

app.addHook("onClose", async () => {
  clearInterval(idleSweep);
  registry.closeAll();
  if (microVmHost) await microVmHost.close();
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
