import { randomUUID } from "node:crypto";

/**
 * Lifecycle coordinator for a host microVM backend.
 *
 * This class deliberately refuses container/PTY drivers. A production driver
 * must create a separate guest-kernel boundary (for example, a configured
 * Firecracker/Kata worker) and implement launch/stop. It does not itself
 * provide hardware isolation.
 */
export class VmSupervisor {
  #authority;
  #driver;
  #clock;
  #instances = new Map();
  #closed = false;

  constructor({ authority, driver, clock = Date.now } = {}) {
    if (!authority || typeof authority.verify !== "function"
      || typeof driver?.launch !== "function" || typeof driver?.stop !== "function"
      || driver.isolationType !== "microvm" || typeof clock !== "function") {
      throw new TypeError("A lease authority and an explicit microVM launch/stop driver are required");
    }
    this.#authority = authority;
    this.#driver = driver;
    this.#clock = clock;
  }

  async create({ envelope, subject, imageDigest } = {}) {
    if (this.#closed) throw new Error("VM supervisor is closed");
    const lease = this.#authority.verify(envelope, {
      now: this.#clock(), subject, imageDigest
    });
    const id = randomUUID();
    const record = { id, state: "starting", leaseId: lease.id, subject: lease.subject, imageDigest: lease.imageDigest, handle: null };
    this.#instances.set(id, record);
    try {
      const handle = await this.#driver.launch(Object.freeze({
        id,
        lease,
        quotas: lease.quotas,
        imageDigest: lease.imageDigest,
        network: Object.freeze({ defaultDeny: true, egress: lease.egress }),
        devices: Object.freeze([...lease.capabilities])
      }));
      if (!handle || typeof handle !== "object") throw new Error("MicroVM driver returned no instance handle");
      if (this.#closed) {
        await this.#driver.stop(handle);
        throw new Error("VM supervisor closed during VM startup");
      }
      record.handle = handle;
      record.state = "running";
      return this.#publicRecord(record);
    } catch (error) {
      record.state = "failed";
      this.#instances.delete(id);
      throw error;
    }
  }

  get(id) {
    const record = this.#instances.get(id);
    if (!record) return null;
    if (record.state === "running") {
      try {
        this.#authority.verify({ payload: this.#driverLeasePayload(record), signature: this.#driverLeaseSignature(record) }, {
          now: this.#clock(), subject: record.subject, imageDigest: record.imageDigest
        });
      } catch {
        // A record without retained lease material is not returned as healthy.
        return this.#publicRecord({ ...record, state: "lease-unavailable" });
      }
    }
    return this.#publicRecord(record);
  }

  async stop(id) {
    const record = this.#instances.get(id);
    if (!record) return false;
    if (record.state === "stopping") return false;
    record.state = "stopping";
    try {
      if (record.handle) await this.#driver.stop(record.handle);
      record.state = "stopped";
      this.#instances.delete(id);
      return true;
    } catch (error) {
      record.state = "stop-failed";
      throw error;
    }
  }

  async close() {
    this.#closed = true;
    const ids = [...this.#instances.keys()];
    const results = await Promise.allSettled(ids.map(id => this.stop(id)));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "One or more microVMs failed to stop");
  }

  list() {
    return [...this.#instances.values()].map(record => this.#publicRecord(record));
  }

  #publicRecord(record) {
    return Object.freeze({
      id: record.id,
      state: record.state,
      leaseId: record.leaseId,
      subject: record.subject,
      imageDigest: record.imageDigest
    });
  }

  // Lease envelopes are retained separately by the driver in production.
  // Until a driver exposes an authenticated lease reference, get() reports
  // lifecycle state only; authorization must be performed by the broker.
  #driverLeasePayload() { throw new Error("Lease envelope is not retained by supervisor"); }
  #driverLeaseSignature() { throw new Error("Lease envelope is not retained by supervisor"); }
}
