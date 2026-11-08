import { isIP } from "node:net";

/**
 * Per-operation authorization boundary for VM resource adapters.
 * This broker enforces signed lease policy; adapters remain responsible for
 * safe I/O, path isolation, DNS pinning, and operating-system enforcement.
 */
export class VmCapabilityBroker {
  #authority;
  #envelope;
  #subject;
  #imageDigest;
  #clock;

  constructor({ authority, envelope, subject, imageDigest, clock = Date.now } = {}) {
    if (!authority || typeof authority.verifyCapability !== "function"
      || typeof clock !== "function"
      || typeof subject !== "string" || !subject
      || typeof imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
      throw new TypeError("A lease authority, subject, image digest, and clock are required");
    }
    this.#authority = authority;
    this.#envelope = envelope;
    this.#subject = subject;
    this.#imageDigest = imageDigest;
    this.#clock = clock;
  }

  authorize(capability) {
    return this.#authority.verifyCapability(this.#envelope, capability, {
      now: this.#clock(), subject: this.#subject, imageDigest: this.#imageDigest
    });
  }

  async readStorage({ lba, count = 1, read } = {}) {
    const lease = this.authorize("storage-read");
    if (typeof read !== "function") throw new TypeError("A storage read adapter is required");
    this.#validateRange(lba, count, lease.quotas.diskMiB);
    const result = await read(lba, count);
    if (!(result instanceof Uint8Array) || result.byteLength !== count * 512) {
      throw new Error("Storage adapter returned an invalid sector buffer");
    }
    return result;
  }

  async writeStorage({ lba, data, write } = {}) {
    const lease = this.authorize("storage-write");
    if (typeof write !== "function") throw new TypeError("A storage write adapter is required");
    if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength % 512 !== 0) {
      throw new TypeError("Storage writes must contain whole 512-byte sectors");
    }
    const count = data.byteLength / 512;
    this.#validateRange(lba, count, lease.quotas.diskMiB);
    return write(lba, data);
  }

  authorizeNetwork(target) {
    const lease = this.authorize("network-egress");
    let url;
    try { url = new URL(target); } catch { throw new TypeError("Network target must be an absolute URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || isIP(url.hostname) || !url.hostname.includes(".")
      || url.hostname === "localhost" || url.hostname.endsWith(".localhost")
      || url.hostname.endsWith(".local")) {
      throw new Error("Network target is outside the permitted egress policy");
    }
    const host = url.hostname.toLowerCase();
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const allowed = lease.egress.some(entry => {
      const split = entry.lastIndexOf(":");
      const hasPort = split > -1;
      const name = (hasPort ? entry.slice(0, split) : entry).toLowerCase();
      return name === host && (!hasPort || entry.slice(split + 1) === port);
    });
    if (!allowed) throw new Error("Network target is not allowlisted by the VM lease");
    return Object.freeze({ url: url.href, hostname: host, port: Number(port), protocol: url.protocol });
  }

  #validateRange(lba, count, diskMiB) {
    if (!Number.isSafeInteger(lba) || !Number.isSafeInteger(count) || lba < 0 || count < 1
      || !Number.isSafeInteger((lba + count) * 512)
      || (lba + count) * 512 > diskMiB * 1024 * 1024) {
      throw new RangeError("Storage request exceeds the VM disk quota");
    }
  }
}
