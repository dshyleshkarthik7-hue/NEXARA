const API = import.meta.env.VITE_API_URL || "http://localhost:8787";
const editor = document.querySelector("#editor");
const lineNumbers = document.querySelector("#line-numbers");
const output = document.querySelector("#terminal-output");
const input = document.querySelector("#terminal-input");
const send = document.querySelector("#send-input");
const status = document.querySelector("#terminal-status");
const connection = document.querySelector("#connection-label");
let sessionId = null;
let sessionToken = null;
let socket = null;

function updateEditorMeta() {
  const lines = editor.value.split("\n").length;
  lineNumbers.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  const before = editor.value.slice(0, editor.selectionStart);
  const row = before.split("\n");
  document.querySelector("#cursor-position").textContent = `Ln ${row.length}, Col ${row.at(-1).length + 1}`;
}
editor.addEventListener("input", updateEditorMeta);
editor.addEventListener("click", updateEditorMeta);
editor.addEventListener("keyup", updateEditorMeta);

function appendOutput(value) {
  const line = document.createElement("span");
  line.textContent = value;
  output.append(line);
  output.scrollTop = output.scrollHeight;
}
function setConnected(connected) {
  input.disabled = !connected;
  send.disabled = !connected;
  status.textContent = connected ? "Session connected" : "Disconnected";
}
async function createSession() {
  try {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    const response = await fetch(`${API}/api/sessions`, { method: "POST" });
    if (!response.ok) throw new Error(`Session request failed (${response.status})`);
    const data = await response.json();
    sessionId = data.id;
    sessionToken = data.token;
    const wsUrl = new URL(data.websocketPath, API);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.searchParams.set("token", sessionToken);
    socket = new WebSocket(wsUrl);
    socket.addEventListener("open", () => {
      setConnected(true);
      appendOutput("\r\n[connected to authenticated host PTY]\r\n");
      input.focus();
    });
    socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "output" && typeof message.data === "string") appendOutput(message.data);
      } catch { /* Ignore malformed server frames. */ }
    });
    socket.addEventListener("close", () => setConnected(false));
    socket.addEventListener("error", () => {
      setConnected(false);
      appendOutput("\r\n[terminal connection error]\r\n");
    });
  } catch (error) {
    appendOutput(`\r\n[error] ${error.message}\r\n`);
  }
}
document.querySelector("#new-session").addEventListener("click", createSession);
document.querySelector("#terminal-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!socket || socket.readyState !== WebSocket.OPEN || !input.value) return;
  socket.send(JSON.stringify({ type: "input", data: input.value + "\n" }));
  input.value = "";
});
document.querySelector("#clear-terminal").addEventListener("click", () => { output.replaceChildren(); });
window.addEventListener("beforeunload", () => {
  if (socket) socket.close();
  if (sessionId && sessionToken) {
    fetch(`${API}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { "x-session-token": sessionToken },
      keepalive: true
    });
  }
});
fetch(`${API}/health`).then(r => {
  if (!r.ok) throw new Error("offline");
  connection.textContent = "Server online";
}).catch(() => { connection.textContent = "Server unavailable"; });
updateEditorMeta();
