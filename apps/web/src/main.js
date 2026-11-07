import { IndexedDbWorkspaceStore } from "../../../packages/workspace/src/index.js";

const API = import.meta.env.VITE_API_URL || "http://localhost:8787";
const editor = document.querySelector("#editor");
const lineNumbers = document.querySelector("#line-numbers");
const output = document.querySelector("#terminal-output");
const input = document.querySelector("#terminal-input");
const send = document.querySelector("#send-input");
const status = document.querySelector("#terminal-status");
const connection = document.querySelector("#connection-label");
const saveStatus = document.querySelector("#editor-save-status");
const fileList = document.querySelector("#workspace-files");
let sessionId = null;
let sessionToken = null;
let socket = null;
let workspace = null;
let currentFile = "untitled.txt";
const fileRevisions = new Map();
let saveTimer = null;
let saveQueue = Promise.resolve();

function updateEditorMeta() {
  const lines = editor.value.split("\n").length;
  lineNumbers.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  const before = editor.value.slice(0, editor.selectionStart);
  const row = before.split("\n");
  document.querySelector("#cursor-position").textContent = `Ln ${row.length}, Col ${row.at(-1).length + 1}`;
}
editor.addEventListener("input", () => {
  updateEditorMeta();
  scheduleSave();
});
editor.addEventListener("click", updateEditorMeta);
editor.addEventListener("keyup", updateEditorMeta);

function setSaveStatus(message) {
  if (saveStatus) saveStatus.textContent = message;
}

function renderFileList(files) {
  fileList.replaceChildren();
  for (const file of files) {
    const button = document.createElement("button");
    button.className = "file-item" + (file.path === currentFile ? " active" : "");
    button.type = "button";
    button.textContent = file.path;
    button.addEventListener("click", () => openFile(file.path));
    fileList.append(button);
  }
}

async function refreshFiles() {
  renderFileList(await workspace.list());
}

async function openFile(path) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveCurrentFile();
  }
  await saveQueue;
  const record = await workspace.read(path);
  if (!record) return;
  currentFile = record.path;
  fileRevisions.set(record.path, record.revision);
  editor.value = record.content;
  document.querySelector("#active-filename").textContent = currentFile;
  updateEditorMeta();
  setSaveStatus("Saved locally");
  await refreshFiles();
}

async function saveCurrentFile() {
  if (!workspace) return;
  const content = editor.value;
  const path = currentFile;
  saveQueue = saveQueue.then(async () => {
    try {
      setSaveStatus("Saving…");
      const expectedRevision = fileRevisions.get(path) ?? null;
      const record = await workspace.write(path, content, { expectedRevision });
      fileRevisions.set(path, record.revision);
      if (path === currentFile && content === editor.value) {
        setSaveStatus("Saved locally");
      }
      await refreshFiles();
    } catch (error) {
      if (error.name === "WorkspaceConflictError") {
        setSaveStatus("Save conflict — another tab changed this file");
      } else {
        setSaveStatus("Save failed");
        console.error("NEXARA workspace save failed", error);
      }
    }
  }).catch(error => console.error("Workspace save queue failed", error));
  return saveQueue;
}

function scheduleSave() {
  setSaveStatus("Unsaved changes");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveCurrentFile();
  }, 400);
}

async function initializeWorkspace() {
  try {
    workspace = new IndexedDbWorkspaceStore();
    let files = await workspace.list();
    if (!files.some(file => file.path === "untitled.txt")) {
      await workspace.write("untitled.txt", "Welcome to NEXARA. Your edits are saved in this browser.");
    }
    files = await workspace.list();
    renderFileList(files);
    await openFile(files.some(file => file.path === "untitled.txt") ? "untitled.txt" : files[0].path);
  } catch (error) {
    setSaveStatus("Browser storage unavailable");
    console.error("NEXARA workspace could not initialize", error);
    editor.disabled = true;
  }
}

document.querySelector("#new-file").addEventListener("click", async () => {
  const path = window.prompt("New workspace file path (for example, src/main.js):");
  if (!path) return;
  try {
    const record = await workspace.write(path, "", { expectedRevision: null });
    fileRevisions.set(record.path, record.revision);
    await openFile(record.path);
  } catch (error) {
    window.alert(error.message);
  }
});

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
void initializeWorkspace();
