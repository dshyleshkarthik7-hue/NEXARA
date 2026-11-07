const MAX_PATH_LENGTH = 240;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DB_VERSION = 1;

export class WorkspaceConflictError extends Error {
  constructor(path, expected, actual) {
    super(`Workspace file changed: ${path} (expected revision ${expected}, found ${actual})`);
    this.name = "WorkspaceConflictError";
    this.path = path;
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

export function normalizeWorkspacePath(value) {
  if (typeof value !== "string") throw new TypeError("Workspace path must be a string");
  const path = value.normalize("NFC").replaceAll("\\", "/");
  if (!path || path.length > MAX_PATH_LENGTH || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw new TypeError("Invalid workspace path");
  }
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".."
    || segment.startsWith(".nexara") || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new TypeError("Invalid workspace path segment");
  }
  return segments.join("/");
}

function validateContent(content) {
  if (typeof content !== "string") throw new TypeError("Workspace content must be text");
  if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) {
    throw new RangeError("Workspace file exceeds 2 MiB");
  }
}

function cloneRecord(record) {
  return record ? { ...record } : null;
}

/** In-memory implementation used for tests and explicitly non-persistent sessions. */
export class MemoryWorkspaceStore {
  #files = new Map();

  async list() {
    return [...this.#files.values()].map(cloneRecord).sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(pathValue) {
    return cloneRecord(this.#files.get(normalizeWorkspacePath(pathValue)));
  }

  async write(pathValue, content, { expectedRevision } = {}) {
    const path = normalizeWorkspacePath(pathValue);
    validateContent(content);
    const current = this.#files.get(path);
    if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) {
      throw new WorkspaceConflictError(path, expectedRevision, current?.revision ?? null);
    }
    const record = {
      path,
      content,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString()
    };
    this.#files.set(path, record);
    return cloneRecord(record);
  }

  async delete(pathValue, { expectedRevision } = {}) {
    const path = normalizeWorkspacePath(pathValue);
    const current = this.#files.get(path);
    if (!current) return false;
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new WorkspaceConflictError(path, expectedRevision, current.revision);
    }
    return this.#files.delete(path);
  }
}

/** IndexedDB-backed persistent workspace store for browser deployments. */
export class IndexedDbWorkspaceStore {
  #databaseName;
  #indexedDB;
  #databasePromise;

  constructor({ databaseName = "nexara-workspace", indexedDB = globalThis.indexedDB } = {}) {
    if (!indexedDB) throw new Error("IndexedDB is unavailable in this environment");
    this.#databaseName = databaseName;
    this.#indexedDB = indexedDB;
  }

  #database() {
    if (!this.#databasePromise) {
      this.#databasePromise = new Promise((resolve, reject) => {
        const request = this.#indexedDB.open(this.#databaseName, DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("files")) {
            database.createObjectStore("files", { keyPath: "path" });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => database.close();
          resolve(database);
        };
        request.onerror = () => reject(request.error ?? new Error("Unable to open workspace database"));
        request.onblocked = () => reject(new Error("Workspace database upgrade is blocked by another tab"));
      });
    }
    return this.#databasePromise;
  }

  async #transaction(mode, operation) {
    const database = await this.#database();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("files", mode);
      const store = transaction.objectStore("files");
      let result;
      let operationError;
      try {
        operation(store, value => { result = value; }, error => { operationError = error; transaction.abort(); });
      } catch (error) {
        operationError = error;
        transaction.abort();
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(operationError ?? transaction.error ?? new Error("Workspace transaction aborted"));
      transaction.onerror = () => reject(operationError ?? transaction.error ?? new Error("Workspace transaction failed"));
    });
  }

  async list() {
    return this.#transaction("readonly", (store, setResult) => {
      const request = store.getAll();
      request.onsuccess = () => setResult(request.result.sort((a, b) => a.path.localeCompare(b.path)));
    });
  }

  async read(pathValue) {
    const path = normalizeWorkspacePath(pathValue);
    return this.#transaction("readonly", (store, setResult) => {
      const request = store.get(path);
      request.onsuccess = () => setResult(cloneRecord(request.result));
    });
  }

  async write(pathValue, content, { expectedRevision } = {}) {
    const path = normalizeWorkspacePath(pathValue);
    validateContent(content);
    return this.#transaction("readwrite", (store, setResult, fail) => {
      const request = store.get(path);
      request.onsuccess = () => {
        const current = request.result;
        if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) {
          fail(new WorkspaceConflictError(path, expectedRevision, current?.revision ?? null));
          return;
        }
        const record = {
          path,
          content,
          revision: (current?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString()
        };
        const writeRequest = store.put(record);
        writeRequest.onsuccess = () => setResult(cloneRecord(record));
        writeRequest.onerror = () => fail(writeRequest.error ?? new Error("Unable to save workspace file"));
      };
      request.onerror = () => fail(request.error ?? new Error("Unable to read workspace file"));
    });
  }

  async delete(pathValue, { expectedRevision } = {}) {
    const path = normalizeWorkspacePath(pathValue);
    return this.#transaction("readwrite", (store, setResult, fail) => {
      const request = store.get(path);
      request.onsuccess = () => {
        const current = request.result;
        if (!current) { setResult(false); return; }
        if (expectedRevision !== undefined && current.revision !== expectedRevision) {
          fail(new WorkspaceConflictError(path, expectedRevision, current.revision));
          return;
        }
        const deletion = store.delete(path);
        deletion.onsuccess = () => setResult(true);
        deletion.onerror = () => fail(deletion.error ?? new Error("Unable to delete workspace file"));
      };
      request.onerror = () => fail(request.error ?? new Error("Unable to read workspace file"));
    });
  }

  async close() {
    if (!this.#databasePromise) return;
    const database = await this.#databasePromise;
    database.close();
    this.#databasePromise = null;
  }
}

export const WORKSPACE_LIMITS = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  maxPathLength: MAX_PATH_LENGTH
});
