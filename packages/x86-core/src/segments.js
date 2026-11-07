import { X86DescriptorTable } from "./descriptors.js";

/**
 * Cached segment-register state for protected-mode foundations.
 * Supports descriptor-validated data and stack loads plus code-cache installation
 * by a trusted control-transfer path. It intentionally does not change CPU CPL
 * or perform far transfers, call gates, privilege stack switches, or memory checks.
 */
export class X86SegmentState {
  constructor({ gdt, ldt = null, cpl = 0, longMode = false } = {}) {
    if (!(gdt instanceof X86DescriptorTable) || gdt.kind !== "gdt") throw new TypeError("gdt must be a GDT descriptor table");
    if (ldt !== null && (!(ldt instanceof X86DescriptorTable) || ldt.kind !== "ldt")) throw new TypeError("ldt must be an LDT descriptor table");
    if (!Number.isInteger(cpl) || cpl < 0 || cpl > 3) throw new RangeError("CPL must be 0..3");
    this.gdt = gdt;
    this.ldt = ldt;
    this.cpl = cpl;
    this.longMode = Boolean(longMode);
    this.registers = {
      cs: { selector: 0, cache: null },
      ss: { selector: 0, cache: null },
      ds: { selector: 0, cache: null },
      es: { selector: 0, cache: null },
      fs: { selector: 0, cache: null },
      gs: { selector: 0, cache: null }
    };
  }

  #table(selector) {
    if ((selector & 4) === 0) return this.gdt;
    if (!this.ldt) throw new Error("LDT selector used while LDTR is unusable");
    return this.ldt;
  }

  #resolve(selector, { nullAllowed = false } = {}) {
    if (!Number.isInteger(selector) || selector < 0 || selector > 0xffff) throw new RangeError("Invalid segment selector");
    if ((selector & 0xfff8) === 0) {
      if (nullAllowed) return null;
      throw new Error("Null selector is not valid for this segment register");
    }
    const descriptor = this.#table(selector).readSegment(selector, { cpl: this.cpl });
    if (!descriptor || descriptor.system) throw new Error("Selector does not reference a code/data segment descriptor");
    return descriptor;
  }

  loadData(name, selector) {
    if (!["ds", "es", "fs", "gs"].includes(name)) throw new RangeError("Data segment register must be DS, ES, FS or GS");
    if ((selector & 0xfff8) === 0) {
      this.registers[name] = { selector, cache: null };
      return this.snapshot()[name];
    }
    const descriptor = this.#resolve(selector);
    if (descriptor.executable && !descriptor.readable) throw new Error("Code segment is not readable");
    if (!descriptor.executable && !descriptor.readable) throw new Error("Data segment is not readable");
    this.registers[name] = { selector, cache: descriptor };
    return this.snapshot()[name];
  }

  loadStack(selector) {
    const descriptor = this.#resolve(selector);
    const rpl = selector & 3;
    if (descriptor.executable || !descriptor.writable) throw new Error("SS requires a writable data segment");
    if (descriptor.dpl !== this.cpl || rpl !== this.cpl) throw new Error("SS privilege check failed");
    this.registers.ss = { selector, cache: descriptor };
    return this.snapshot().ss;
  }

  /** Install a validated CS cache after an external control-transfer validator. */
  installCodeSegment(selector, { allowPrivilegeChange = false } = {}) {
    const descriptor = this.#resolve(selector);
    if (!descriptor.executable) throw new Error("CS requires a code segment");
    if (!descriptor.present) throw new Error("Code segment not present");
    if (descriptor.conforming) {
      if (descriptor.dpl > this.cpl) throw new Error("Conforming CS privilege check failed");
    } else if (!allowPrivilegeChange && (descriptor.dpl !== this.cpl || (selector & 3) !== this.cpl)) {
      throw new Error("Non-conforming CS privilege check failed");
    }
    this.registers.cs = { selector, cache: descriptor };
    return this.snapshot().cs;
  }

  setCpl(cpl) {
    if (!Number.isInteger(cpl) || cpl < 0 || cpl > 3) throw new RangeError("CPL must be 0..3");
    this.cpl = cpl;
  }

  restore(state) {
    if (!state || state.format !== "nexara-x86-segments-v1" || state.longMode !== this.longMode
      || !Number.isInteger(state.cpl) || state.cpl < 0 || state.cpl > 3) {
      throw new TypeError("Invalid or incompatible segment state");
    }
    this.cpl = state.cpl;
    const load = (name, entry) => {
      if (entry === null) {
        if (name === "cs" || name === "ss") {
          this.registers[name] = { selector: 0, cache: null };
          return;
        }
        this.loadData(name, 0);
        return;
      }
      if (!entry || !Number.isInteger(entry.selector)) throw new TypeError(`Invalid ${name.toUpperCase()} segment snapshot`);
      if (name === "cs") this.installCodeSegment(entry.selector);
      else if (name === "ss") this.loadStack(entry.selector);
      else this.loadData(name, entry.selector);
    };
    for (const name of ["cs", "ss", "ds", "es", "fs", "gs"]) load(name, state[name]);
    return this.snapshot();
  }

  snapshot() {
    const cache = value => value.cache ? {
      selector: value.selector, base: value.cache.base.toString(), limit: value.cache.limit.toString(),
      dpl: value.cache.dpl, executable: value.cache.executable, readable: value.cache.readable,
      writable: value.cache.writable, conforming: value.cache.conforming,
      defaultSize: value.cache.defaultSize, long: value.cache.long, present: value.cache.present
    } : null;
    return Object.freeze({
      format: "nexara-x86-segments-v1", cpl: this.cpl, longMode: this.longMode,
      cs: cache(this.registers.cs), ss: cache(this.registers.ss),
      ds: cache(this.registers.ds), es: cache(this.registers.es),
      fs: cache(this.registers.fs), gs: cache(this.registers.gs)
    });
  }
}
