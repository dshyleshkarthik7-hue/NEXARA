import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import pty from "node-pty";
import { isClientMessage } from "../../../packages/protocol/src/index.js";
import { SessionRegistry } from "./session-registry.js";

const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "http://localhost:5173").split(",").map(s => s.trim()).filter(Boolean));
const maxSessions = Math.max(1, Number.parseInt(process.env.NEXARA_MAX_SESSIONS || "4", 10) || 4);
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
  sessionSecurity: { perSessionSecret: true, originAllowlist: true },
  backends: [{ id: "host-pty", label: "Host process terminal", available: true, machineEmulation: false }],
  architectures: { x86: { supported: false }, x86_64: { supported: false } }
}));

app.post("/api/sessions", async (request, reply) => {
  if (!registry.canCreate(request.ip)) return reply.code(429).send({ error: "Session creation limit or capacity reached" });
  const shell = process.env.NEXARA_SHELL || process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  let session;
  try {
    session = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: process.env.NEXARA_WORKDIR || os.homedir(),
      env: shellEnvironment()
    });
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
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
