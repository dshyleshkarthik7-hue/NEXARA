import { GuestMemory } from "../../runtime/src/index.js";

const U64_MAX = 0xffffffffffffffffn;

function baseValue(value, name) {
  let result;
  try { result = BigInt(value); } catch { throw new TypeError(`${name} must be an integer`); }
  if (result < 0n || result > U64_MAX) throw new RangeError(`${name} is outside the 64-bit range`);
  return result;
}

/**
 * Architectural storage for GDTR, IDTR, LDTR and task-register state.
 * This models register contents and table bounds only; it does not execute
 * LGDT/LIDT/LLDT/LTR or perform hardware task/privilege transitions.
 */
export class X86SystemTableState {
  constructor(memory, { longMode = true } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    this.memory = memory;
    this.longMode = Boolean(longMode);
    this.gdtr = { base: 0n, limit: 0xffff };
    this.idtr = { base: 0n, limit: 0xffff };
    this.ldtr = { selector: 0, base: 0n, limit: 0, present: false, usable: false };
    this.task = { selector: 0, base: 0n, limit: 0, present: false, busy: false, usable: false };
  }

  #table(base, limit, name) {
    const nextBase = baseValue(base, `${name} base`);
    if (!Number.isInteger(limit) || limit < 0 || limit > 0xffff) {
      throw new RangeError(`${name} limit must be a 16-bit unsigned integer`);
    }
    if (nextBase + BigInt(limit) >= BigInt(this.memory.byteLength)) {
      throw new RangeError(`${name} exceeds guest physical memory`);
    }
    return { base: nextBase, limit };
  }

  loadGdtr(base, limit) { this.gdtr = this.#table(base, limit, "GDTR"); return this.snapshot().gdtr; }
  loadIdtr(base, limit) { this.idtr = this.#table(base, limit, "IDTR"); return this.snapshot().idtr; }

  loadLdtr({ selector, base, limit, present = true, usable = true }) {
    if (!Number.isInteger(selector) || selector < 0 || selector > 0xffff || (selector & 4) !== 0) {
      throw new RangeError("LDTR selector must be a GDT selector");
    }
    const table = this.#table(base, limit, "LDTR");
    this.ldtr = { selector, ...table, present: Boolean(present), usable: Boolean(usable) && selector !== 0 };
    return this.snapshot().ldtr;
  }

  clearLdtr() {
    this.ldtr = { selector: 0, base: 0n, limit: 0, present: false, usable: false };
    return this.snapshot().ldtr;
  }

  loadTaskRegister({ selector, base, limit, present = true, busy = true, usable = true }) {
    if (!Number.isInteger(selector) || selector < 0 || selector > 0xffff || selector === 0 || (selector & 4) !== 0) {
      throw new RangeError("Task register selector must be a non-null GDT selector");
    }
    const table = this.#table(base, limit, "Task register");
    this.task = { selector, ...table, present: Boolean(present), busy: Boolean(busy), usable: Boolean(usable) };
    return this.snapshot().task;
  }

  snapshot() {
    const table = value => ({ base: value.base.toString(), limit: value.limit });
    const segment = value => ({ selector: value.selector, base: value.base.toString(), limit: value.limit,
      present: value.present, usable: value.usable, ...(Object.hasOwn(value, "busy") ? { busy: value.busy } : {}) });
    return Object.freeze({
      format: "nexara-x86-system-tables-v1", longMode: this.longMode,
      gdtr: table(this.gdtr), idtr: table(this.idtr),
      ldtr: segment(this.ldtr), task: segment(this.task)
    });
  }

  restore(state) {
    if (!state || state.format !== "nexara-x86-system-tables-v1" || state.longMode !== this.longMode) {
      throw new TypeError("Invalid or incompatible system-table state");
    }
    const gdtr = this.#table(state.gdtr?.base, state.gdtr?.limit, "GDTR");
    const idtr = this.#table(state.idtr?.base, state.idtr?.limit, "IDTR");
    const validateSegment = (value, name, allowNull, hasBusy) => {
      if (!value || !Number.isInteger(value.selector) || value.selector < 0 || value.selector > 0xffff
        || (!allowNull && value.selector === 0) || (value.selector & 4) !== 0
        || typeof value.present !== "boolean" || typeof value.usable !== "boolean"
        || (hasBusy && typeof value.busy !== "boolean")) throw new TypeError(`Invalid ${name} state`);
      return { selector: value.selector, ...this.#table(value.base, value.limit, name),
        present: value.present, usable: value.usable, ...(hasBusy ? { busy: value.busy } : {}) };
    };
    const ldtr = validateSegment(state.ldtr, "LDTR", true, false);
    const task = validateSegment(state.task, "Task register", false, true);
    this.gdtr = gdtr; this.idtr = idtr; this.ldtr = ldtr; this.task = task;
    return this.snapshot();
  }
}
