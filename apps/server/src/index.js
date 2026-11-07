import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import os from "node:os";
import pty from "node-pty";
import { isClientMessage } from "../../../packages/protocol/src/index.js";

const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173").split(",").map(s => s.trim());
const sessions = new Map();

await app.register(cors, {
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Origin not allowed"), false);
  }
});
await app.register(websocket);

app.get("/health", async () => ({ name: "NEXARA", status: "ok", version: 1 }));
app.get("/api/capabilities", async () => ({
  protocolVersion: 1,
  backends: [{ id: "host-pty", label: "Host process terminal", available: true, machineEmulation: false }],
  architectures: { x86: { supported: false }, x86_64: { supported: false } }
}));

app.post("/api/sessions", async (request, reply) => {
  const shell = process.env.NEXARA_SHELL || process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
  const id = randomUUID();
  const session = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.env.NEXARA_WORKDIR || os.homedir(),
    env: { ...process.env, TERM: "xterm-256color" }
  });
  sessions.set(id, { session, createdAt: Date.now() });
  session.onExit(() => sessions.delete(id));
  return reply.code(201).send({ id, websocketPath: `/api/sessions/${id}/stream` });
});

app.get("/api/sessions/:id/stream", { websocket: true }, (socket, request) => {
  const entry = sessions.get(request.params.id);
  if (!entry) {
    socket.close(1008, "Unknown session");
    return;
  }
  const { session } = entry;
  const onData = session.onData(data => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: "output", data }));
  });
  socket.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (!isClientMessage(message)) return;
    if (message.type === "input") session.write(message.data);
    if (message.type === "resize") session.resize(message.cols, message.rows);
  });
  socket.on("close", () => onData.dispose());
  socket.on("error", () => onData.dispose());
});

app.delete("/api/sessions/:id", async (request, reply) => {
  const entry = sessions.get(request.params.id);
  if (!entry) return reply.code(404).send({ error: "Session not found" });
  entry.session.kill();
  sessions.delete(request.params.id);
  return reply.code(204).send();
});

app.addHook("onClose", async () => {
  for (const { session } of sessions.values()) session.kill();
  sessions.clear();
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
