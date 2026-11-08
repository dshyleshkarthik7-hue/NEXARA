import { canonicalJson, sha256Hex } from "./index.js";

const encoder = new TextEncoder();
const EVENT_TYPES = new Set(["program.load", "input", "interrupt", "checkpoint", "marker"]);

function cloneJson(value) {
  const text = canonicalJson(value);
  return JSON.parse(text);
}

/** Hash-chained deterministic event log with an instruction-count virtual clock. */
export class DeterministicEventLog {
  #events = [];
  #tick = 0;
  #head = "0".repeat(64);

  get tick() { return this.#tick; }
  get head() { return this.#head; }
  get length() { return this.#events.length; }

  advance(instructions = 1) {
    if (!Number.isSafeInteger(instructions) || instructions < 0) throw new RangeError("Virtual time increment must be a non-negative safe integer");
    this.#tick += instructions;
    if (!Number.isSafeInteger(this.#tick)) throw new RangeError("Virtual clock overflow");
    return this.#tick;
  }

  async append(type, payload, { tick = this.#tick } = {}) {
    if (!EVENT_TYPES.has(type)) throw new TypeError(`Unsupported deterministic event type: ${type}`);
    if (!Number.isSafeInteger(tick) || tick < this.#tick) throw new RangeError("Event tick cannot move virtual time backwards");
    const event = Object.freeze({
      sequence: this.#events.length,
      tick,
      type,
      payload: cloneJson(payload),
      previousHash: this.#head
    });
    const hash = await sha256Hex(encoder.encode(canonicalJson(event)));
    const sealed = Object.freeze({ ...event, hash });
    this.#events.push(sealed);
    this.#tick = tick;
    this.#head = hash;
    return sealed;
  }

  export() {
    return Object.freeze({ schemaVersion: 1, tick: this.#tick, head: this.#head, events: this.#events.map(event => ({ ...event })) });
  }

  static async import(bundle) {
    if (!bundle || bundle.schemaVersion !== 1 || !Array.isArray(bundle.events)) throw new TypeError("Invalid deterministic event log bundle");
    const log = new DeterministicEventLog();
    for (const event of bundle.events) {
      const { hash, ...unsigned } = event;
      const expectedSequence = log.length;
      if (unsigned.sequence !== expectedSequence) throw new Error("Event log sequence mismatch");
      if (unsigned.previousHash !== log.head) throw new Error("Event log chain predecessor mismatch");
      if (!Number.isSafeInteger(unsigned.tick) || unsigned.tick < log.tick) throw new Error("Event log virtual time moved backwards");
      if (!EVENT_TYPES.has(unsigned.type)) throw new Error("Event log contains an unsupported event type");
      const expectedHash = await sha256Hex(encoder.encode(canonicalJson(unsigned)));
      if (hash !== expectedHash) throw new Error(`Event log hash mismatch at sequence ${expectedSequence}`);
      log.#events.push(Object.freeze({ ...cloneJson(unsigned), hash }));
      log.#tick = unsigned.tick;
      log.#head = hash;
    }
    if (bundle.tick !== log.tick || bundle.head !== log.head) throw new Error("Event log summary does not match its event chain");
    return log;
  }

  async replay(handlers = {}) {
    const verified = await DeterministicEventLog.import(this.export());
    for (const event of verified.#events) {
      const handler = handlers[event.type];
      if (handler) await handler(Object.freeze({ ...event }));
    }
    return Object.freeze({ eventsReplayed: verified.length, tick: verified.tick, head: verified.head });
  }
}
