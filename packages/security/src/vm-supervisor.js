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
  #limits;

  constructor({ authority, driver, clock = Date.now, limits = {} } = {}) {
    if (!authority || typeof authority.verify !== "function"
      || typeof driver?.launch !== "function" || typeof driver?.stop !== "function"
      || driver.isolationType !== "microvm" || typeof clock !== "function") {
      throw new TypeError("A lease authority and an explicit microVM launch/stop driver are required");
    }
    const normalized = {
      maxInstances: limits.maxInstances ?? 16,
      cpuMillis: limits.cpuMillis ?? 64000,
      memoryMiB: limits.memoryMiB ?? 262144,
      diskMiB: limits.diskMiB ?? 1048576
    };
    if (Object.values(normalized).some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError("Supervisor aggregate limits must be positive safe integers");
    }
    this.#limits = Object.freeze(normalized);
    this.#authority = authority;
    this.#driver = driver;
    this.#clock = clock;
  }

  async create({ envelope, subject, imageDigest } = {}) {
    if (this.#closed) throw new Error("VM supervisor is closed");
    const lease = this.#authority.verify(envelope, {
      now: this.#clock(), subject, imageDigest
    });
    this.#reserve(lease.quotas);
    const id = randomUUID();
    const record = { id, quotas: lease.quotas, state: "starting", leaseId: lease.id, subject: lease.subject, imageDigest: lease.imageDigest, envelope, handle: null };
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

  /** Stops running VMs whose signed lease has expired or become invalid. */
  async reapExpired() {
    const expired = [];
    for (const record of this.#instances.values()) {
      if (record.state !== "running" && record.state !== "stop-failed") continue;
      try {
        this.#authority.verify(record.envelope, {
          now: this.#clock(), subject: record.subject, imageDigest: record.imageDigest
        });
      } catch {
        expired.push(record.id);
      }
    }
    const results = await Promise.allSettled(expired.map(id => this.stop(id)));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Failed to stop expired VMs");
    return expired;
  }

  get(id) {
    const record = this.#instances.get(id);
    if (!record) return null;
    if (record.state === "running") {
      try {
        this.#authority.verify(record.envelope, {
          now: this.#clock(), subject: record.subject, imageDigest: record.imageDigest
        });
      } catch {
        return this.#publicRecord({ ...record, state: "lease-expired-or-invalid" });
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

  #reserve(quotas) {
    const active = [...this.#instances.values()];
    const totals = active.reduce((sum, record) => ({
      cpuMillis: sum.cpuMillis + record.quotas.cpuMillis,
      memoryMiB: sum.memoryMiB + record.quotas.memoryMiB,
      diskMiB: sum.diskMiB + record.quotas.diskMiB
    }), { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 });
    if (active.length >= this.#limits.maxInstances
      || totals.cpuMillis + quotas.cpuMillis > this.#limits.cpuMillis
      || totals.memoryMiB + quotas.memoryMiB > this.#limits.memoryMiB
      || totals.diskMiB + quotas.diskMiB > this.#limits.diskMiB) {
      throw new Error("VM request exceeds supervisor aggregate resource limits");
    }
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

} 
