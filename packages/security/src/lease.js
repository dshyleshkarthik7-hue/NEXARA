import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const FORMAT = "nexara-vm-lease-v1";
const CAPABILITIES = new Set(["serial", "keyboard", "display", "storage-read", "storage-write", "clipboard", "network-egress", "file-import", "file-export"]);
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function validateRequest(input, now) {
  if (!input || typeof input !== "object" || typeof input.subject !== "string"
    || input.subject.length < 1 || input.subject.length > 128
    || typeof input.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)) {
    throw new TypeError("Lease subject and SHA-256 image digest are required");
  }
  const ttlMs = input.ttlMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) throw new RangeError("Lease TTL is outside policy");
  const quotas = input.quotas ?? {};
  const cpuMillis = quotas.cpuMillis ?? 1000;
  const memoryMiB = quotas.memoryMiB ?? 512;
  const diskMiB = quotas.diskMiB ?? 1024;
  if (!Number.isInteger(cpuMillis) || cpuMillis < 100 || cpuMillis > 64000
    || !Number.isInteger(memoryMiB) || memoryMiB < 64 || memoryMiB > 262144
    || !Number.isInteger(diskMiB) || diskMiB < 16 || diskMiB > 1048576) {
    throw new RangeError("VM resource quotas exceed policy bounds");
  }
  const capabilities = [...new Set(input.capabilities ?? [])].sort();
  if (capabilities.some(value => !CAPABILITIES.has(value))) throw new TypeError("Unknown VM capability");
  const egress = [...new Set(input.egress ?? [])].sort();
  if (egress.some(value => typeof value !== "string" || value.length > 253 || value === "*" || !/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/.test(value))) {
    throw new TypeError("Egress entries must be explicit hostnames or host:port values");
  }
  return {
    format: FORMAT,
    id: randomUUID(),
    subject: input.subject,
    imageDigest: input.imageDigest,
    issuedAt: now,
    expiresAt: now + ttlMs,
    quotas: { cpuMillis, memoryMiB, diskMiB },
    capabilities,
    egress
  };
}

export class VmLeaseAuthority {
  #key;
  constructor(secret) {
    const key = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(String(secret ?? ""), "utf8");
    if (key.byteLength < 32) throw new RangeError("VM lease signing secret must contain at least 32 bytes");
    this.#key = key;
  }

  issue(input, { now = Date.now() } = {}) {
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Invalid lease issue time");
    const payload = validateRequest(input, now);
    const body = JSON.stringify(canonical(payload));
    const signature = createHmac("sha256", this.#key).update(body).digest("base64url");
    return freezeDeep({ payload, signature });
  }

  verify(envelope, { now = Date.now(), subject, imageDigest } = {}) {
    if (!envelope || !envelope.payload || envelope.payload.format !== FORMAT
      || typeof envelope.signature !== "string" || !Number.isSafeInteger(now)) {
      throw new TypeError("Malformed VM lease");
    }
    const body = JSON.stringify(canonical(envelope.payload));
    const expected = createHmac("sha256", this.#key).update(body).digest();
    let supplied;
    try { supplied = Buffer.from(envelope.signature, "base64url"); } catch { throw new Error("Invalid VM lease signature"); }
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new Error("Invalid VM lease signature");
    }
    const lease = envelope.payload;
    if (lease.expiresAt <= now || lease.issuedAt > now + 30_000 || lease.expiresAt - lease.issuedAt > MAX_TTL_MS) {
      throw new Error("VM lease is expired or outside its validity window");
    }
    if (subject !== undefined && lease.subject !== subject) throw new Error("VM lease subject mismatch");
    if (imageDigest !== undefined && lease.imageDigest !== imageDigest) throw new Error("VM lease image digest mismatch");
    return freezeDeep(structuredClone(lease));
  }

  static assertCapability(lease, capability) {
    if (!lease || lease.format !== FORMAT || !CAPABILITIES.has(capability) || !lease.capabilities.includes(capability)) {
      throw new Error("VM capability was not granted by the lease");
    }
    return true;
  }
}

export const VM_CAPABILITIES = Object.freeze([...CAPABILITIES].sort());
