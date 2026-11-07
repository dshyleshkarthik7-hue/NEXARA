import { timingSafeEqual } from "node:crypto";

function matchesToken(expected, supplied) {
  if (typeof supplied !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class SessionRegistry {
  #sessions = new Map();
  #creationHistory = new Map();
  #now;

  constructor({
    maxSessions = 4,
    maxSessionsPerOwner = 2,
    createLimit = 8,
    createWindowMs = 60_000,
    idleTimeoutMs = 30 * 60_000,
    now = Date.now
  } = {}) {
    for (const [name, value] of Object.entries({ maxSessions, maxSessionsPerOwner, createLimit, createWindowMs, idleTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.maxSessions = maxSessions;
    this.maxSessionsPerOwner = maxSessionsPerOwner;
    this.createLimit = createLimit;
    this.createWindowMs = createWindowMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.#now = now;
  }

  get size() { return this.#sessions.size; }

  canCreate(owner) {
    if (typeof owner !== "string" || !owner) return false;
    if (this.#sessions.size >= this.maxSessions) return false;
    let activeForOwner = 0;
    for (const entry of this.#sessions.values()) if (entry.owner === owner) activeForOwner++;
    if (activeForOwner >= this.maxSessionsPerOwner) return false;

    const now = this.#now();
    const history = (this.#creationHistory.get(owner) ?? []).filter(time => now - time < this.createWindowMs);
    if (history.length >= this.createLimit) {
      this.#creationHistory.set(owner, history);
      return false;
    }
    history.push(now);
    this.#creationHistory.set(owner, history);
    return true;
  }

  add(id, { session, token, owner }) {
    if (typeof id !== "string" || !id || this.#sessions.has(id)) throw new TypeError("Invalid or duplicate session id");
    if (!session || typeof session.kill !== "function" || typeof token !== "string" || !token || typeof owner !== "string" || !owner) {
      throw new TypeError("Invalid session entry");
    }
    if (this.#sessions.size >= this.maxSessions) throw new RangeError("Session capacity reached");
    const entry = { id, session, token, owner, createdAt: this.#now(), lastActivityAt: this.#now() };
    this.#sessions.set(id, entry);
    return entry;
  }

  authorize(id, token) {
    const entry = this.#sessions.get(id);
    return entry && matchesToken(entry.token, token) ? entry : null;
  }

  touch(id) {
    const entry = this.#sessions.get(id);
    if (!entry) return false;
    entry.lastActivityAt = this.#now();
    return true;
  }

  remove(id) {
    const entry = this.#sessions.get(id);
    if (!entry) return false;
    this.#sessions.delete(id);
    return true;
  }

  sweepIdle() {
    const now = this.#now();
    const expired = [];
    for (const [id, entry] of this.#sessions) {
      if (now - entry.lastActivityAt >= this.idleTimeoutMs) {
        this.#sessions.delete(id);
        expired.push(id);
        try { entry.session.kill(); } catch { /* The process may have exited independently. */ }
      }
    }
    for (const [owner, history] of this.#creationHistory) {
      const fresh = history.filter(time => now - time < this.createWindowMs);
      if (fresh.length) this.#creationHistory.set(owner, fresh);
      else this.#creationHistory.delete(owner);
    }
    return expired;
  }

  closeAll() {
    const entries = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const entry of entries) {
      try { entry.session.kill(); } catch { /* Continue closing remaining processes. */ }
    }
    return entries.length;
  }
}
