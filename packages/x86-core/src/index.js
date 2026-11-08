import { GuestMemory } from "../../runtime/src/index.js";
import { X86LegacyPaging32, PageFault } from "../../runtime/src/mmu.js";
import { X86SystemTableState } from "./system-tables.js";
export { X86Tss32, X86Tss64 } from "./task-state.js";
import { X86DescriptorTable } from "./descriptors.js";
import { X86SegmentState } from "./segments.js";
import { X86Tss32, X86Tss64 } from "./task-state.js";

const REG_NAMES = ["rax","rcx","rdx","rbx","rsp","rbp","rsi","rdi","r8","r9","r10","r11","r12","r13","r14","r15"];
const CF = 1n, PF = 1n << 2n, ZF = 1n << 6n, SF = 1n << 7n, OF = 1n << 11n;
const ARITH_FLAGS = CF | PF | ZF | SF | OF;

export class CpuFault extends Error {
  constructor(message, ip) {
    super(`${message} at guest IP 0x${ip.toString(16)}`);
    this.name = "CpuFault";
    this.ip = ip;
  }
}

/**
 * Experimental x86 interpreter, not a complete x86 implementation.
 * Supports a limited integer instruction subset in 32-bit and 64-bit modes.
 * Includes an experimental partial paging model and limited control-register/MSR instructions.
 * Includes a bounded protected-mode ring-transition subset; not a complete x86 implementation.
 */
export class X86Cpu {
  constructor({ memory, mode = 64, instructionPointer = 0, addressSpace = null, legacyPaging32 = null, ioBus = null, exceptionDelivery = false } = {}) {
    if (!(memory instanceof GuestMemory)) throw new TypeError("memory must be GuestMemory");
    if (mode !== 32 && mode !== 64) throw new RangeError("mode must be 32 or 64");
    if (!Number.isSafeInteger(instructionPointer) || instructionPointer < 0
      || (!addressSpace && instructionPointer >= memory.byteLength)) {
      throw new RangeError("instructionPointer is outside guest memory");
    }
    if (addressSpace && addressSpace.memory !== memory) throw new TypeError("addressSpace must use the CPU guest memory");
    if (legacyPaging32 !== null && (!(legacyPaging32 instanceof X86LegacyPaging32) || legacyPaging32.memory !== memory || mode !== 32)) throw new TypeError("legacyPaging32 must be a 32-bit paging engine using the CPU guest memory");
    if (addressSpace && legacyPaging32) throw new TypeError("Choose one paging backend");
    if (addressSpace) addressSpace.translate(BigInt(instructionPointer), { execute: true });
    this.memory = memory;
    this.addressSpace = addressSpace;
    this.legacyPaging32 = legacyPaging32;
    if (ioBus !== null && (!ioBus || typeof ioBus.read !== "function" || typeof ioBus.write !== "function")) throw new TypeError("ioBus must implement read(port, width) and write(port, value, width)");
    this.ioBus = ioBus;
    this.exceptionDelivery = Boolean(exceptionDelivery);
    this.mode = mode;
    this.ip = instructionPointer;
    this.registers = Array.from({ length: 16 }, () => 0n);
    this.flags = 2n;
    this.halted = false;
    this.instructionsExecuted = 0;
    this.pendingInterrupts = [];
    this.controlRegisters = new Map([[0, 0x60000010n], [2, 0n], [3, 0n], [4, 0n]]);
    this.efer = 0n;
    this.systemTables = new X86SystemTableState(memory, { longMode: mode === 64 });
    this.gdt = new X86DescriptorTable(memory, { base: 0n, limit: Math.min(0xffff, memory.byteLength - 1), kind: "gdt", longMode: mode === 64, paging: legacyPaging32 });
    this.idt = new X86DescriptorTable(memory, { base: 0n, limit: Math.min(0xffff, memory.byteLength - 1), kind: "idt", longMode: mode === 64, paging: legacyPaging32 });
    this.segments = new X86SegmentState({ gdt: this.gdt, cpl: 0, longMode: mode === 64 });
  }

  #syncDescriptorTables() {
    this.gdt.setRegister(this.systemTables.gdtr.base, this.systemTables.gdtr.limit);
    this.idt.setRegister(this.systemTables.idtr.base, this.systemTables.idtr.limit);
    const ldtr = this.systemTables.ldtr;
    this.segments.ldt = ldtr.usable && ldtr.present
      ? new X86DescriptorTable(this.memory, { base: ldtr.base, limit: ldtr.limit, kind: "ldt", longMode: this.mode === 64, paging: this.legacyPaging32 })
      : null;
  }

  requestInterrupt(vector) {
    if (!Number.isInteger(vector) || vector < 0 || vector > 255) throw new RangeError("Interrupt vector must be between 0 and 255");
    if (this.pendingInterrupts.length >= 256) throw new RangeError("Pending interrupt queue is full");
    if (!this.pendingInterrupts.includes(vector)) this.pendingInterrupts.push(vector);
  }

  /** Deliver a caller-classified protected-mode exception with an optional CPU error code. */
  deliverException(vector, { errorCode = null, returnIp = this.ip } = {}) {
    if (!Number.isInteger(vector) || vector < 0 || vector > 255) throw new RangeError("Exception vector must be between 0 and 255");
    if (!Number.isSafeInteger(returnIp) || returnIp < 0 || (this.mode === 32 && returnIp > 0xffffffff)) throw new RangeError("Exception return IP is outside interpreter range");
    if (errorCode !== null && (!Number.isInteger(errorCode) || errorCode < 0 || errorCode > 0xffffffff)) {
      throw new RangeError("Exception error code must be 32-bit");
    }
    this.#deliverSoftwareInterrupt(vector, returnIp, this.ip, false, errorCode === null ? null : BigInt(errorCode));
    return Object.freeze({ vector, errorCode, ip: this.ip });
  }

  /** Save the current 32-bit CPU context into the active busy TSS. */
  saveTaskStateToTss() {
    if (this.mode !== 32 || (this.controlRegisters.get(0) & 1n) === 0n) throw new CpuFault("32-bit protected mode is required to save a hardware task", this.ip);
    const task = this.systemTables.task;
    if (!task.usable || !task.present || !task.busy || task.limit < 0x67) throw new CpuFault("TR does not reference a usable busy 32-bit TSS", this.ip);
    try {
      const tss = new X86Tss32(this.memory, { base: task.base, limit: task.limit, paging: (this.controlRegisters.get(0) & (1n << 31n)) !== 0n ? this.legacyPaging32 : null });
      return tss.setTaskState({
        eip: this.ip >>> 0, eflags: Number(this.flags & 0xffffffffn),
        registers: { eax: Number(this.getRegister(0, 32)), ecx: Number(this.getRegister(1, 32)),
          edx: Number(this.getRegister(2, 32)), ebx: Number(this.getRegister(3, 32)),
          esp: Number(this.getRegister(4, 32)), ebp: Number(this.getRegister(5, 32)),
          esi: Number(this.getRegister(6, 32)), edi: Number(this.getRegister(7, 32)) },
        segments: { es: this.segments.registers.es.selector, cs: this.segments.registers.cs.selector,
          ss: this.segments.registers.ss.selector, ds: this.segments.registers.ds.selector,
          fs: this.segments.registers.fs.selector, gs: this.segments.registers.gs.selector,
          ldt: this.systemTables.ldtr.selector }
      });
    } catch (error) { throw new CpuFault(error.message, this.ip); }
  }

  /**
   * Restore the active TSS register image after validating every segment on a
   * temporary segment-state object. This is a bounded state primitive, not
   * an architectural task-switch instruction.
   */
  loadTaskStateFromTss() {
    if (this.mode !== 32 || (this.controlRegisters.get(0) & 1n) === 0n) throw new CpuFault("32-bit protected mode is required to load a hardware task", this.ip);
    const task = this.systemTables.task;
    if (!task.usable || !task.present || !task.busy || task.limit < 0x67) throw new CpuFault("TR does not reference a usable busy 32-bit TSS", this.ip);
    try {
      const tss = new X86Tss32(this.memory, { base: task.base, limit: task.limit, paging: (this.controlRegisters.get(0) & (1n << 31n)) !== 0n ? this.legacyPaging32 : null });
      const state = tss.getTaskState();
      const targetCpl = state.segments.cs & 3;
      if (state.segments.ldt !== this.systemTables.ldtr.selector) throw new Error("TSS LDTR selector must match the loaded LDTR for this bounded restore path");
      if ((state.eflags & 2) === 0) throw new Error("TSS EFLAGS reserved bit 1 must be set");
      const nextSegments = new X86SegmentState({ gdt: this.gdt, ldt: this.segments.ldt, cpl: targetCpl, longMode: false });
      nextSegments.installCodeSegment(state.segments.cs);
      nextSegments.loadStack(state.segments.ss);
      for (const name of ["ds", "es", "fs", "gs"]) nextSegments.loadData(name, state.segments[name]);
      const cs = nextSegments.registers.cs.cache;
      if (BigInt(state.eip) > cs.limit) throw new Error("TSS EIP exceeds the target code-segment limit");
      // Commit only after TSS bounds, EFLAGS, CS, SS and all data selectors validate.
      const names = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
      const indices = [0, 1, 2, 3, 4, 5, 6, 7];
      for (let i = 0; i < names.length; i++) this.setRegister(indices[i], BigInt(state.registers[names[i]]), 32);
      this.flags = BigInt(state.eflags);
      this.ip = state.eip;
      this.segments = nextSegments;
      return Object.freeze({ ip: this.ip, flags: this.flags, segments: this.segments.snapshot() });
    } catch (error) { throw new CpuFault(error.message, this.ip); }
  }
  /**
   * Execute the supported 32-bit protected-mode TSS task-switch paths.
   * TSS and descriptor-table bases are linear addresses and use the active
   * legacy paging backend when CR0.PG is set.
   */
  switchTask(selector, { reason = "jmp", returnIp = this.ip } = {}) {
    if (this.mode !== 32 || (this.controlRegisters.get(0) & 1n) === 0n) throw new CpuFault("Hardware task switching requires 32-bit protected mode", this.ip);
    const pagingEnabled = (this.controlRegisters.get(0) & (1n << 31n)) !== 0n;
    if (pagingEnabled && !this.legacyPaging32) throw new CpuFault("Paged 32-bit task switching requires the legacy paging backend", this.ip);
    if (!["jmp", "call", "task-gate", "iret-task"].includes(reason)) throw new CpuFault("Unsupported task-switch reason", this.ip);
    if (!Number.isInteger(selector) || selector <= 0 || selector > 0xffff || (selector & 4) !== 0) throw new CpuFault("Task switch requires a non-null GDT selector", this.ip);
    if (!Number.isSafeInteger(returnIp) || returnIp < 0 || returnIp > 0xffffffff) throw new CpuFault("Task return IP is outside 32-bit range", this.ip);
    const current = this.systemTables.task;
    if (!current.usable || !current.present || !current.busy || current.limit < 0x67) throw new CpuFault("Current TR must reference a usable busy 32-bit TSS", this.ip);
    try {
      const currentDescriptor = this.gdt.readSystemDescriptor(current.selector, { allowedTypes: [11] });
      if (currentDescriptor.base !== current.base || currentDescriptor.limit < 0x67n) throw new Error("Current TR does not match its busy GDT TSS descriptor");
      const targetDescriptor = this.gdt.readSystemDescriptor(selector, { allowedTypes: reason === "iret-task" ? [11] : [9] });
      if (["jmp", "call"].includes(reason) && Math.max(this.segments.cpl, selector & 3) > targetDescriptor.dpl) throw new Error("Task-switch selector privilege check failed");
      if (targetDescriptor.limit < 0x67n || targetDescriptor.base > 0xffffffffn) throw new Error("Target TSS must be a bounded 32-bit TSS with a 104-byte header");
      const taskPaging = pagingEnabled ? this.legacyPaging32 : null;
      const targetTss = new X86Tss32(this.memory, { base: targetDescriptor.base, limit: Number(targetDescriptor.limit), paging: taskPaging });
      const incoming = targetTss.getTaskState();
      const incomingCr3 = BigInt(targetTss.cr3);
      if ((incomingCr3 & 0xfffn) !== 0n || incomingCr3 + 4096n > BigInt(this.memory.byteLength)) {
        throw new Error("Incoming TSS CR3 must be an aligned in-range page-directory base");
      }
      if ((incoming.eflags & 2) === 0) throw new Error("Incoming TSS EFLAGS reserved bit 1 must be set");
      const targetCpl = incoming.segments.cs & 3;
      let nextLdtr = null;
      let nextLdt = null;
      if ((incoming.segments.ldt & 0xfff8) !== 0) {
        const ldtDescriptor = this.gdt.readSystemDescriptor(incoming.segments.ldt, { allowedTypes: [2] });
        if (ldtDescriptor.limit > 0xffffn || ldtDescriptor.base + ldtDescriptor.limit >= BigInt(this.memory.byteLength)) throw new Error("Incoming LDT exceeds guest memory or supported bounds");
        nextLdtr = { selector: incoming.segments.ldt, base: ldtDescriptor.base, limit: Number(ldtDescriptor.limit), present: true, usable: true };
        nextLdt = new X86DescriptorTable(this.memory, { base: ldtDescriptor.base, limit: Number(ldtDescriptor.limit), kind: "ldt", longMode: false, paging: taskPaging });
      }
      const nextSegments = new X86SegmentState({ gdt: this.gdt, ldt: nextLdt, cpl: targetCpl, longMode: false });
      nextSegments.installCodeSegment(incoming.segments.cs);
      nextSegments.loadStack(incoming.segments.ss);
      for (const name of ["es", "ds", "fs", "gs"]) nextSegments.loadData(name, incoming.segments[name]);
      if (BigInt(incoming.eip) > nextSegments.registers.cs.cache.limit) throw new Error("Incoming TSS EIP exceeds code-segment limit");
      const targetAccessAddress = this.gdt.base + BigInt((selector >>> 3) * 8 + 5);
      const currentAccessAddress = this.gdt.base + BigInt((current.selector >>> 3) * 8 + 5);
      if (targetAccessAddress > 0xffffffffn || currentAccessAddress > 0xffffffffn) throw new Error("TSS descriptor access byte exceeds 32-bit linear address space");
      if (pagingEnabled) {
        this.legacyPaging32.translate(targetAccessAddress, { write: true, user: false });
        if (reason === "jmp" || reason === "iret-task") this.legacyPaging32.translate(currentAccessAddress, { write: true, user: false });
      } else if (targetAccessAddress >= BigInt(this.memory.byteLength) || currentAccessAddress >= BigInt(this.memory.byteLength)) throw new Error("TSS descriptor access byte exceeds guest memory");
      const oldTss = new X86Tss32(this.memory, { base: current.base, limit: current.limit, paging: taskPaging });
      // Validate every guest-memory write before changing the outgoing task image.
      oldTss.preflightWrite(32, 66);
      if (reason === "task-gate" || reason === "call") targetTss.preflightWrite(0, 2);
      oldTss.setTaskState({
        eip: returnIp, eflags: Number(this.flags & 0xffffffffn),
        registers: { eax: Number(this.getRegister(0, 32)), ecx: Number(this.getRegister(1, 32)), edx: Number(this.getRegister(2, 32)), ebx: Number(this.getRegister(3, 32)),
          esp: Number(this.getRegister(4, 32)), ebp: Number(this.getRegister(5, 32)), esi: Number(this.getRegister(6, 32)), edi: Number(this.getRegister(7, 32)) },
        segments: { es: this.segments.registers.es.selector, cs: this.segments.registers.cs.selector, ss: this.segments.registers.ss.selector,
          ds: this.segments.registers.ds.selector, fs: this.segments.registers.fs.selector, gs: this.segments.registers.gs.selector, ldt: this.systemTables.ldtr.selector }
      });
      // Descriptor writes and the CPU commit occur only after the incoming image validates.
      const targetAccess = reason === "iret-task" ? targetDescriptor.raw[5] : targetDescriptor.raw[5] | 2;
      const currentAccess = (reason === "jmp" || reason === "iret-task") ? currentDescriptor.raw[5] & ~2 : currentDescriptor.raw[5];
      if (reason === "task-gate" || reason === "call") targetTss.backlink = current.selector;
      this.#writeLinear(Number(targetAccessAddress), Uint8Array.of(targetAccess), { user: false });
      if (reason === "jmp" || reason === "iret-task") this.#writeLinear(Number(currentAccessAddress), Uint8Array.of(currentAccess), { user: false });
      if (nextLdtr) this.systemTables.loadLdtr(nextLdtr); else this.systemTables.clearLdtr();
      this.systemTables.loadTaskRegister({ selector, base: targetDescriptor.base, limit: Number(targetDescriptor.limit), present: true, busy: true, usable: true });
      this.#syncDescriptorTables();
      for (let i = 0; i < 8; i++) this.setRegister(i, BigInt(incoming.registers[["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"][i]]), 32);
      this.writeControlRegister(3, incomingCr3);
      this.flags = (reason === "task-gate" || reason === "call")
        ? BigInt(incoming.eflags) | (1n << 14n)
        : reason === "jmp" ? BigInt(incoming.eflags) & ~(1n << 14n) : BigInt(incoming.eflags);
      this.ip = incoming.eip;
      this.segments = nextSegments;
      return Object.freeze({ selector, ip: this.ip, cpl: this.segments.cpl, task: this.systemTables.snapshot().task });
    } catch (error) { throw new CpuFault("Task switch failed: " + error.message, this.ip); }
  }
  readControlRegister(index) {
    if (![0, 2, 3, 4].includes(index)) throw new CpuFault("Unsupported control register", this.ip);
    return this.controlRegisters.get(index);
  }

  #syncPagingState() {
    const cr0 = this.controlRegisters.get(0);
    const cr4 = this.controlRegisters.get(4);
    const paging = (cr0 & (1n << 31n)) !== 0n;
    const pae = (cr4 & (1n << 5n)) !== 0n;
    const lme = (this.efer & (1n << 8n)) !== 0n;
    if (paging && (cr0 & 1n) === 0n) throw new CpuFault("CR0.PG requires CR0.PE", this.ip);
    if (paging && this.mode !== 64 && !this.legacyPaging32) throw new CpuFault("32-bit paging is not implemented without the legacy paging backend", this.ip);
    if (paging && this.mode === 32 && (cr4 & (1n << 5n)) !== 0n) throw new CpuFault("PAE paging is not implemented by the legacy backend", this.ip);
    if (paging && this.mode === 64 && !pae) throw new CpuFault("Long-mode paging requires CR4.PAE", this.ip);
    if (paging && lme && !pae) throw new CpuFault("EFER.LME requires CR4.PAE", this.ip);
    if (this.mode === 64 && paging && lme) this.efer |= 1n << 10n;
    else this.efer &= ~(1n << 10n);
    if (this.legacyPaging32) {
      this.legacyPaging32.setControl({ pse: (cr4 & (1n << 4n)) !== 0n, writeProtect: (cr0 & (1n << 16n)) !== 0n });
      if (paging) this.legacyPaging32.loadCr3(this.controlRegisters.get(3));
      else this.legacyPaging32.flush();
    }
    if (this.addressSpace) {
      if (paging) this.addressSpace.setPageTableRoot(this.controlRegisters.get(3));
      else this.addressSpace.clearPageTableRoot();
      this.addressSpace.setNxEnabled((this.efer & (1n << 11n)) !== 0n);
    }
  }

  writeControlRegister(index, value) {
    const next = BigInt(value) & 0xffffffffffffffffn;
    if (index === 0) {
      const allowed = 0x00000000e005003fn;
      if ((next & ~allowed) !== 0n) throw new CpuFault("CR0 contains reserved bits", this.ip);
      if ((next & (1n << 31n)) !== 0n && (next & 1n) === 0n) {
        throw new CpuFault("CR0.PG requires CR0.PE", this.ip);
      }
    } else if (index === 2) {
      if (this.mode === 32 && next > 0xffffffffn) throw new CpuFault("CR2 exceeds 32-bit linear address range", this.ip);
    } else if (index === 3) {
      if ((next & 0xfffn) !== 0n) throw new CpuFault("CR3 must be 4 KiB aligned", this.ip);
      if (next >= BigInt(this.memory.byteLength)) throw new CpuFault("CR3 exceeds guest physical memory", this.ip);
    } else if (index === 4) {
      const allowed = this.legacyPaging32 ? 0x0000000000000030n : 0x0000000000000020n; // PSE and PAE only where supported
      if ((next & ~allowed) !== 0n) throw new CpuFault("CR4 contains reserved bits", this.ip);
      if ((this.controlRegisters.get(0) & (1n << 31n)) !== 0n && this.mode === 64 && (next & (1n << 5n)) === 0n) {
        throw new CpuFault("Cannot clear CR4.PAE while paging is active in 64-bit mode", this.ip);
      }
    } else {
      throw new CpuFault("Unsupported control register", this.ip);
    }
    const previous = this.controlRegisters.get(index);
    this.controlRegisters.set(index, next);
    try { this.#syncPagingState(); }
    catch (error) { this.controlRegisters.set(index, previous); this.#syncPagingState(); throw error; }
    return next;
  }

  readMsr(index) {
    if (index !== 0xc0000080) throw new CpuFault("Unsupported model-specific register", this.ip);
    return this.efer;
  }

  writeMsr(index, value) {
    if (index !== 0xc0000080) throw new CpuFault("Unsupported model-specific register", this.ip);
    const next = BigInt(value) & 0xffffffffffffffffn;
    const allowed = 0x901n; // SCE, LME and NXE; LMA is read-only
    if ((next & ~allowed) !== 0n) throw new CpuFault("EFER contains reserved or read-only bits", this.ip);
    const previous = this.efer;
    if ((previous & (1n << 10n)) !== 0n && (next & (1n << 8n)) === 0n) {
      throw new CpuFault("Cannot clear EFER.LME while long mode is active", this.ip);
    }
    this.efer = next | (previous & (1n << 10n));
    try { this.#syncPagingState(); }
    catch (error) { this.efer = previous; this.#syncPagingState(); throw error; }
    return this.efer;
  }

  #mask(width) { return (1n << BigInt(width)) - 1n; }
  #reg(index) {
    if (!Number.isInteger(index) || index < 0 || index >= (this.mode === 64 ? 16 : 8)) {
      throw new CpuFault("Invalid general-purpose register", this.ip);
    }
  }

  getRegister(index, width = this.mode) {
    this.#reg(index);
    if (![8, 16, 32, 64].includes(width) || (width === 64 && this.mode !== 64)) throw new RangeError("Invalid register width");
    return this.registers[index] & this.#mask(width);
  }

  setRegister(index, value, width = this.mode) {
    this.#reg(index);
    if (![8, 16, 32, 64].includes(width) || (width === 64 && this.mode !== 64)) throw new RangeError("Invalid register width");
    const mask = this.#mask(width);
    const v = BigInt(value) & mask;
    if (width === 32 || width === 64) this.registers[index] = v;
    else this.registers[index] = (this.registers[index] & ~mask) | v;
  }

  #fetch8() {
    if (!this.addressSpace && this.ip >= this.memory.byteLength) throw new CpuFault("Instruction fetch outside memory", this.ip);
    const address = this.ip++;
    const code = this.segments?.registers.cs.cache;
    if (code && this.mode !== 64 && BigInt(address) > code.limit) throw new CpuFault("Instruction fetch exceeds CS limit", address);
    const linear = BigInt(address) + (this.mode === 64 ? 0n : (code?.base ?? 0n));
    if (linear > BigInt(Number.MAX_SAFE_INTEGER)) throw new CpuFault("Instruction linear address exceeds host safe integer range", address);
    return this.#readLinear(linear, 1, { execute: true })[0];
  }
  #fetchUnsigned(bytes) {
    let value = 0n;
    for (let i = 0; i < bytes; i++) value |= BigInt(this.#fetch8()) << BigInt(i * 8);
    return value;
  }
  #fetchSigned(bytes) {
    const bits = BigInt(bytes * 8);
    const value = this.#fetchUnsigned(bytes);
    const sign = 1n << (bits - 1n);
    return value & sign ? value - (1n << bits) : value;
  }

  #address(value, addressWidth) {
    const normalized = BigInt(value) & this.#mask(addressWidth);
    if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) throw new CpuFault("Address exceeds host safe integer range", this.ip);
    return Number(normalized);
  }

  #decodeModRM(rex, addressWidth) {
    const byte = this.#fetch8();
    const mod = byte >> 6;
    const reg = ((byte >> 3) & 7) | ((rex & 4) ? 8 : 0);
    const rmLow = byte & 7;
    const rm = rmLow | ((rex & 1) ? 8 : 0);
    this.#reg(reg);
    if (mod === 3) {
      this.#reg(rm);
      return { reg, operand: { kind: "register", index: rm } };
    }

    let base = 0n;
    let index = 0n;
    let scale = 1n;
    let ripRelative = false;
    if (rmLow === 4) {
      const sib = this.#fetch8();
      const scaleBits = sib >> 6;
      const indexLow = (sib >> 3) & 7;
      const baseLow = sib & 7;
      const indexReg = indexLow | ((rex & 2) ? 8 : 0);
      const baseReg = baseLow | ((rex & 1) ? 8 : 0);
      scale = 1n << BigInt(scaleBits);
      if (indexLow !== 4 || (rex & 2)) {
        this.#reg(indexReg);
        index = this.getRegister(indexReg, addressWidth) * scale;
      }
      if (mod === 0 && baseLow === 5) base = this.#fetchSigned(4);
      else {
        this.#reg(baseReg);
        base = this.getRegister(baseReg, addressWidth);
      }
    } else if (mod === 0 && rmLow === 5) {
      if (this.mode === 64 && addressWidth === 64) ripRelative = true;
      else base = 0n;
      if (!ripRelative) base = this.#fetchSigned(4);
    } else {
      this.#reg(rm);
      base = this.getRegister(rm, addressWidth);
    }

    let displacement = 0n;
    if (mod === 1) displacement = this.#fetchSigned(1);
    if (mod === 2 || (mod === 0 && rmLow === 5 && !ripRelative)) displacement = mod === 2 ? this.#fetchSigned(4) : displacement;
    if (mod === 0 && rmLow === 5 && ripRelative) displacement = this.#fetchSigned(4);
    if (ripRelative) base = BigInt(this.ip);

    const address = this.#address(base + index + displacement, addressWidth);
    return { reg, operand: { kind: "memory", address } };
  }

  #readLinear(address, length, { execute = false, user = this.segments.cpl === 3 } = {}) {
    try {
      if (this.addressSpace) return execute
        ? this.addressSpace.fetch(BigInt(address), length, { user })
        : this.addressSpace.read(BigInt(address), length, { user });
      if (this.legacyPaging32 && (this.controlRegisters.get(0) & (1n << 31n)) !== 0n) {
        return this.legacyPaging32.read(address, length, { execute, user });
      }
      return this.memory.read(Number(address), length);
    } catch (error) {
      if (error instanceof PageFault) this.controlRegisters.set(2, error.address & this.#mask(this.mode));
      throw error;
    }
  }

  #writeLinear(address, data, { user = this.segments.cpl === 3 } = {}) {
    try {
      if (this.addressSpace) this.addressSpace.write(BigInt(address), data, { user });
      else if (this.legacyPaging32 && (this.controlRegisters.get(0) & (1n << 31n)) !== 0n) {
        this.legacyPaging32.write(address, data, { user });
      } else this.memory.write(Number(address), data);
    } catch (error) {
      if (error instanceof PageFault) this.controlRegisters.set(2, error.address & this.#mask(this.mode));
      throw error;
    }
  }

  #readOperand(operand, width) {
    if (operand.kind === "register") return this.getRegister(operand.index, width);
    const bytes = width / 8;
    const data = this.#readLinear(operand.address, bytes);
    let value = 0n;
    for (let i = 0; i < bytes; i++) value |= BigInt(data[i]) << BigInt(i * 8);
    return value;
  }

  #writeOperand(operand, value, width) {
    if (operand.kind === "register") return this.setRegister(operand.index, value, width);
    const bytes = width / 8;
    const v = BigInt(value) & this.#mask(width);
    const data = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) data[i] = Number((v >> BigInt(i * 8)) & 0xffn);
    this.#writeLinear(operand.address, data);
  }

  #setArithmeticFlags(result, a, b, width, operation) {
    const mask = this.#mask(width);
    const sign = 1n << BigInt(width - 1);
    const r = result & mask;
    this.flags &= ~ARITH_FLAGS;
    if (r === 0n) this.flags |= ZF;
    let parity = Number(r & 0xffn), ones = 0;
    while (parity) { ones ^= 1; parity &= parity - 1; }
    if (ones === 0) this.flags |= PF;
    if (r & sign) this.flags |= SF;
    if (operation === "add") {
      if (a + b > mask) this.flags |= CF;
      if ((~(a ^ b) & (a ^ r) & sign) !== 0n) this.flags |= OF;
    } else if (operation === "sub") {
      if (a < b) this.flags |= CF;
      if (((a ^ b) & (a ^ r) & sign) !== 0n) this.flags |= OF;
    }
  }

  #alu(operation, left, right, width) {
    const a = left & this.#mask(width);
    const b = right & this.#mask(width);
    const result = operation === "add" ? a + b
      : operation === "sub" || operation === "cmp" ? a - b
      : operation === "and" || operation === "test" ? a & b
      : operation === "or" ? a | b : a ^ b;
    this.#setArithmeticFlags(result, a, b, width, operation === "cmp" ? "sub" : operation);
    return result & this.#mask(width);
  }

  #condition(code) {
    const cf = (this.flags & CF) !== 0n;
    const zf = (this.flags & ZF) !== 0n;
    const sf = (this.flags & SF) !== 0n;
    const of = (this.flags & OF) !== 0n;
    const pf = (this.flags & PF) !== 0n;
    switch (code & 15) {
      case 0: return of;
      case 1: return !of;
      case 2: return cf;
      case 3: return !cf;
      case 4: return zf;
      case 5: return !zf;
      case 6: return cf || zf;
      case 7: return !cf && !zf;
      case 8: return sf;
      case 9: return !sf;
      case 10: return pf;
      case 11: return !pf;
      case 12: return sf !== of;
      case 13: return sf === of;
      case 14: return zf || sf !== of;
      case 15: return !zf && sf === of;
      default: return false;
    }
  }

  #branch(displacement, start) {
    const target = this.ip + Number(displacement);
    const code = this.segments?.registers.cs.cache;
    if (!Number.isSafeInteger(target) || target < 0 || (code && this.mode !== 64 && BigInt(target) > code.limit)
      || (!this.addressSpace && BigInt(target) + (this.mode === 64 ? 0n : (code?.base ?? 0n)) >= BigInt(this.memory.byteLength))) {
      throw new CpuFault("Branch target outside memory", start);
    }
    this.ip = target;
  }

  #checkIoPermission(start, port, width) {
    const iopl = Number((this.flags >> 12n) & 3n);
    if (this.segments.cpl > iopl) {
      const task = this.systemTables.task;
      if (!task.usable || !task.present || task.limit < 0x67) {
        throw new CpuFault("I/O privilege check failed (#GP); no usable 32-bit TSS is loaded", start);
      }
      try {
        const tss = new X86Tss32(this.memory, { base: task.base, limit: task.limit, paging: (this.controlRegisters.get(0) & (1n << 31n)) !== 0n ? this.legacyPaging32 : null });
        if (!tss.allowsIo(port, width)) throw new Error("TSS I/O bitmap denies this port range");
      } catch (error) {
        throw new CpuFault("I/O privilege check failed (#GP): " + error.message, start);
      }
    }
    if (!this.ioBus) throw new CpuFault("I/O instruction executed without an attached guest I/O bus", start);
  }

  #readIo(port, width, start) {
    if (![8, 16, 32].includes(width)) throw new CpuFault("Unsupported I/O operand width", start);
    if (!Number.isInteger(port) || port < 0 || port > 0xffff || port + width / 8 > 0x10000) throw new CpuFault("I/O port range overflow", start);
    this.#checkIoPermission(start, port, width);
    if (!this.ioBus) throw new CpuFault("I/O instruction executed without an attached guest I/O bus", start);
    try {
      const value = this.ioBus.read(port, width);
      const result = BigInt(value);
      if (result < 0n || result > this.#mask(width)) throw new Error("I/O bus returned a value outside operand width");
      return result;
    } catch (error) { throw new CpuFault("Guest I/O read failed: " + error.message, start); }
  }

  #writeIo(port, value, width, start) {
    if (![8, 16, 32].includes(width)) throw new CpuFault("Unsupported I/O operand width", start);
    if (!Number.isInteger(port) || port < 0 || port > 0xffff || port + width / 8 > 0x10000) throw new CpuFault("I/O port range overflow", start);
    this.#checkIoPermission(start, port, width);
    if (!this.ioBus) throw new CpuFault("I/O instruction executed without an attached guest I/O bus", start);
    try { this.ioBus.write(port, BigInt(value) & this.#mask(width), width); }
    catch (error) { throw new CpuFault("Guest I/O write failed: " + error.message, start); }
  }

  #stackWidth(operandWidth) { return this.mode === 64 ? 64 : operandWidth; }
  #push(value, width) {
    const bytes = width / 8;
    const stackReg = 4;
    const next = this.getRegister(stackReg, this.mode) - BigInt(bytes);
    const address = this.#address(next, this.mode);
    this.#writeOperand({ kind: "memory", address }, value, width);
    this.setRegister(stackReg, next, this.mode);
  }
  #pop(width) {
    const stackReg = 4;
    const address = this.#address(this.getRegister(stackReg, this.mode), this.mode);
    const value = this.#readOperand({ kind: "memory", address }, width);
    this.setRegister(stackReg, this.getRegister(stackReg, this.mode) + BigInt(width / 8), this.mode);
    return value;
  }

  #writeInterruptFrame(linearAddress, values, start) {
    const frame = new Uint8Array(values.length * 4);
    const view = new DataView(frame.buffer);
    values.forEach((value, index) => view.setUint32(index * 4, Number(BigInt(value) & 0xffffffffn), true));
    const physicalWrites = [];
    try {
      let offset = 0;
      while (offset < frame.length) {
        const linear = BigInt(linearAddress) + BigInt(offset);
        let physical;
        if (this.addressSpace) {
          physical = this.addressSpace.translate(linear, { write: true, user: false });
        } else if (this.legacyPaging32 && (this.controlRegisters.get(0) & (1n << 31n)) !== 0n) {
          physical = this.legacyPaging32.translate(linear, { write: true, user: false });
        } else {
          physical = Number(linear);
        }
        const count = Math.min(frame.length - offset, 4096 - Number(linear & 0xfffn));
        if (!Number.isSafeInteger(physical) || physical < 0 || physical + count > this.memory.byteLength) {
          throw new RangeError("Interrupt frame exceeds guest physical memory");
        }
        physicalWrites.push({ physical, bytes: frame.slice(offset, offset + count) });
        offset += count;
      }
    } catch (error) {
      if (error instanceof PageFault) this.controlRegisters.set(2, error.address & this.#mask(this.mode));
      throw error;
    }
    // No guest stack byte is modified until every page in the frame is writable.
    for (const write of physicalWrites) this.memory.write(write.physical, write.bytes);
  }

  #writeInterruptFrame64(linearAddress, values) {
    const frame = new Uint8Array(values.length * 8);
    const view = new DataView(frame.buffer);
    values.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value) & 0xffffffffffffffffn, true));
    const physicalWrites = [];
    let offset = 0;
    while (offset < frame.length) {
      const linear = BigInt(linearAddress) + BigInt(offset);
      if (linear < 0n || linear > 0xffffffffffffffffn) throw new RangeError("Long-mode interrupt stack address overflow");
      let physical;
      if (this.addressSpace) physical = this.addressSpace.translate(linear, { write: true, user: false });
      else {
        if (linear > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Long-mode stack address exceeds host safe integer range");
        physical = Number(linear);
      }
      const count = Math.min(frame.length - offset, 4096 - Number(linear & 0xfffn));
      if (!Number.isSafeInteger(physical) || physical < 0 || physical + count > this.memory.byteLength) {
        throw new RangeError("Long-mode interrupt frame exceeds guest physical memory");
      }
      physicalWrites.push({ physical, bytes: frame.slice(offset, offset + count) });
      offset += count;
    }
    // Preflight every translated page before modifying any guest stack byte.
    for (const write of physicalWrites) this.memory.write(write.physical, write.bytes);
  }

  #deliverLongModeInterrupt(vector, returnIp, start, software = true, errorCode = null) {
    if (this.mode !== 64 || (this.controlRegisters.get(0) & 1n) === 0n) {
      throw new CpuFault("Long-mode interrupt delivery requires protected mode", start);
    }
    try {
      const oldCpl = this.segments.cpl;
      const gate = this.idt.readGate(vector, { cpl: oldCpl, software });
      const target = this.gdt.readSegment(gate.selector, { cpl: 0 });
      if (!target || !target.executable || !target.present || target.conforming || !target.long || target.defaultSize) {
        throw new Error("Long-mode IDT target must be a present 64-bit non-conforming code segment");
      }
      const targetCpl = target.dpl;
      const plan = this.segments.prepareCodeTransition(gate.selector, { targetCpl, allowInward: true });
      if (gate.offset > 0x00007fffffffffffn || gate.offset > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Long-mode interrupt target is not representable by this interpreter");
      }
      const oldCs = this.segments.registers.cs.selector;
      const oldSs = this.segments.registers.ss.selector;
      const oldRsp = this.getRegister(4, 64);
      const oldFlags = this.flags;
      const stackSwitch = gate.ist !== 0 || targetCpl < oldCpl;
      let nextRsp;
      let frameValues;
      if (stackSwitch) {
        const task = this.systemTables.task;
        if (!task.usable || !task.present || !task.busy || task.limit < 0x67) {
          throw new Error("Long-mode stack switch requires a present busy 64-bit TSS");
        }
        const tss = new X86Tss64(this.memory, { base: task.base, limit: task.limit });
        const top = gate.ist !== 0 ? tss.getIst(gate.ist) : tss.getRsp(targetCpl);
        if (top === 0n) throw new Error("Selected TSS RSP/IST stack pointer is null");
        const frameBytes = 40n + (errorCode === null ? 0n : 8n);
        if (top < frameBytes) throw new Error("Long-mode TSS stack underflows");
        nextRsp = top - frameBytes;
        frameValues = [BigInt(returnIp), BigInt(oldCs), oldFlags, oldRsp, BigInt(oldSs)];
        if (errorCode !== null) frameValues.unshift(BigInt(errorCode));
        this.#writeInterruptFrame64(nextRsp, frameValues);
        this.segments.commitLongModePrivilegeTransition(plan);
      } else {
        const frameBytes = 24n + (errorCode === null ? 0n : 8n);
        if (oldRsp < frameBytes) throw new Error("Long-mode interrupt stack underflows");
        nextRsp = oldRsp - frameBytes;
        frameValues = [BigInt(returnIp), BigInt(oldCs), oldFlags];
        if (errorCode !== null) frameValues.unshift(BigInt(errorCode));
        this.#writeInterruptFrame64(nextRsp, frameValues);
        this.segments.installCodeSegment(gate.selector);
      }
      this.setRegister(4, nextRsp, 64);
      this.ip = Number(gate.offset);
      if (gate.interruptGate) this.flags &= ~(1n << 9n);
      this.flags &= ~(1n << 8n);
    } catch (error) {
      if (error instanceof PageFault) this.controlRegisters.set(2, error.address & this.#mask(64));
      throw new CpuFault(error.message, start);
    }
  }

  #deliverSoftwareInterrupt(vector, returnIp, start, software = true, errorCode = null) {
    if (this.mode === 64) return this.#deliverLongModeInterrupt(vector, returnIp, start, software, errorCode);
    if (this.mode !== 32 || (this.controlRegisters.get(0) & 1n) === 0n) throw new CpuFault("Protected interrupt delivery requires 32-bit protected mode", start);
    try {
      const oldCpl = this.segments.cpl;
      const gate = this.idt.readGate(vector, { cpl: oldCpl, software });
      if (gate.taskGate) {
        if (gate.offset !== 0n) throw new Error("Task gate reserved offset must be zero");
        this.switchTask(gate.selector, { reason: "task-gate", returnIp });
        // Exception error codes are pushed on the incoming task's stack,
        // after the hardware task switch has loaded its SS:ESP.
        if (errorCode !== null) this.#push(errorCode, 32);
        return;
      }
      const target = this.gdt.readSegment(gate.selector, { cpl: 0 });
      if (!target || !target.executable || !target.present || target.conforming) {
        throw new Error("Interrupt target must be a present non-conforming code segment");
      }
      const targetCpl = target.dpl;
      const plan = this.segments.prepareCodeTransition(gate.selector, { targetCpl, allowInward: true });
      if (gate.offset > target.limit || target.base + gate.offset > 0xffffffffn) {
        throw new Error("Interrupt target exceeds code segment or 32-bit linear address space");
      }
      const oldCs = this.segments.registers.cs.selector;
      const oldSs = this.segments.registers.ss.selector;
      const oldEsp = Number(this.getRegister(4, 32));
      const oldFlags = this.flags;
      let nextEsp, nextSs, frameValues, stackDescriptor;

      if (targetCpl < oldCpl) {
        if (targetCpl !== 0 && targetCpl !== 1 && targetCpl !== 2) throw new Error("Unsupported target privilege ring");
        const task = this.systemTables.task;
        if (!task.usable || !task.present || !task.busy || task.limit < 0x67) {
          throw new Error("Privilege transition requires a present busy 32-bit TSS");
        }
        const tss = new X86Tss32(this.memory, { base: task.base, limit: task.limit, paging: (this.controlRegisters.get(0) & (1n << 31n)) !== 0n ? this.legacyPaging32 : null });
        const ringStack = tss.getRingStack(targetCpl);
        nextSs = ringStack.ss;
        stackDescriptor = this.segments.prepareStack(nextSs, { targetCpl });
        const top = BigInt(ringStack.esp);
        const frameBytes = 20n + (errorCode === null ? 0n : 4n);
        if (top < frameBytes) throw new Error("TSS privilege stack underflows");
        nextEsp = top - frameBytes;
        if (nextEsp > stackDescriptor.limit || top - 1n > stackDescriptor.limit) throw new Error("TSS privilege stack exceeds SS limit");
        const linear = stackDescriptor.base + nextEsp;
        if (linear + frameBytes > 4294967296n) throw new Error("TSS privilege stack exceeds 32-bit linear address space");
        frameValues = [BigInt(returnIp), BigInt(oldCs), oldFlags, BigInt(oldEsp), BigInt(oldSs)];
        if (errorCode !== null) frameValues.unshift(BigInt(errorCode));
        this.#writeInterruptFrame(Number(linear), frameValues, start);
        this.segments.commitPrivilegeTransition(plan, nextSs, stackDescriptor);
      } else {
        if (targetCpl !== oldCpl) throw new Error("Interrupt cannot transfer to an outer privilege ring");
        stackDescriptor = this.segments.registers.ss.cache;
        const frameBytes = 12n + (errorCode === null ? 0n : 4n);
        if (!stackDescriptor || BigInt(oldEsp) < frameBytes || BigInt(oldEsp) > stackDescriptor.limit) throw new Error("Current interrupt stack is invalid");
        nextEsp = BigInt(oldEsp) - frameBytes;
        if (nextEsp + frameBytes - 1n > stackDescriptor.limit) throw new Error("Interrupt frame exceeds SS limit");
        const linear = stackDescriptor.base + nextEsp;
        if (linear + frameBytes > 4294967296n) throw new Error("Interrupt frame exceeds 32-bit linear address space");
        frameValues = [BigInt(returnIp), BigInt(oldCs), oldFlags];
        if (errorCode !== null) frameValues.unshift(BigInt(errorCode));
        this.#writeInterruptFrame(Number(linear), frameValues, start);
        this.segments.installCodeSegment(gate.selector);
      }
      this.setRegister(4, nextEsp, 32);
      this.ip = Number(gate.offset);
      if (gate.interruptGate) this.flags &= ~(1n << 9n);
      this.flags &= ~(1n << 8n);
    } catch (error) { throw new CpuFault(error.message, start); }
  }

  #returnFromLongModeInterrupt(start) {
    if ((this.controlRegisters.get(0) & 1n) === 0n) throw new CpuFault("IRET requires protected mode", start);
    try {
      const rsp = this.getRegister(4, 64);
      if (rsp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("IRET stack address exceeds host safe integer range");
      const frame = this.#readLinear(Number(rsp), 24);
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const targetIp = view.getBigUint64(0, true);
      const selector = Number(view.getBigUint64(8, true) & 0xffffn);
      const restoredFlags = view.getBigUint64(16, true);
      if (targetIp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("IRET target exceeds interpreter address range");
      const targetCpl = selector & 3;
      if (targetCpl === this.segments.cpl && this.segments.registers.ss.selector !== 0) {
        const plan = this.segments.prepareCodeTransition(selector, { targetCpl, allowInward: false });
        if (!plan.cache.long || plan.cache.defaultSize) throw new Error("IRET target is not a 64-bit code segment");
        this.segments.installCodeSegment(selector);
        this.setRegister(4, rsp + 24n, 64);
      } else if (targetCpl > this.segments.cpl || this.segments.registers.ss.selector === 0) {
        if (rsp > BigInt(Number.MAX_SAFE_INTEGER - 40)) throw new Error("Outer IRET frame exceeds host address range");
        const outer = this.#readLinear(Number(rsp), 40);
        const full = new DataView(outer.buffer, outer.byteOffset, outer.byteLength);
        const outerRsp = full.getBigUint64(24, true);
        const outerSs = Number(full.getBigUint64(32, true) & 0xffffn);
        const plan = targetCpl > this.segments.cpl
          ? this.segments.prepareCodeReturn(selector)
          : this.segments.prepareCodeTransition(selector, { targetCpl, allowInward: false });
        if (!plan.cache.long || plan.cache.defaultSize) throw new Error("IRET target is not a 64-bit code segment");
        const stackDescriptor = this.segments.prepareLongModeStackReturn(outerSs, { targetCpl });
        if (outerRsp > 0xffffffffffffffffn) throw new Error("Restored RSP is outside 64-bit range");
        this.segments.commitLongModeReturn(plan, outerSs, stackDescriptor);
        this.setRegister(4, outerRsp, 64);
      } else {
        throw new Error("IRET cannot return to a more privileged ring");
      }
      this.ip = Number(targetIp);
      this.flags = (restoredFlags & 0x003f7fd7n) | 2n;
    } catch (error) { throw new CpuFault(error.message, start); }
  }

  #returnFromInterrupt(start) {
    if (this.mode === 64) return this.#returnFromLongModeInterrupt(start);
    if (this.mode === 32 && (this.flags & (1n << 14n)) !== 0n) {
      try {
        const current = this.systemTables.task;
        if (!current.usable || !current.present || !current.busy || current.limit < 0x67) {
          throw new Error("Nested-task IRET requires a present busy current TSS");
        }
        const currentTss = new X86Tss32(this.memory, { base: current.base, limit: current.limit, paging: (this.controlRegisters.get(0) & (1n << 31n)) !== 0n ? this.legacyPaging32 : null });
        const backlink = currentTss.backlink;
        if (backlink === 0) throw new Error("Nested-task IRET requires a non-null TSS backlink");
        return this.switchTask(backlink, { reason: "iret-task", returnIp: this.ip });
      } catch (error) { throw new CpuFault(error.message, start); }
    }
    if (this.mode !== 32 || (this.controlRegisters.get(0) & 1n) === 0n) throw new CpuFault("IRET requires 32-bit protected mode", start);
    try {
      const stack = this.segments.registers.ss.cache;
      const esp = this.getRegister(4, 32);
      if (!stack || esp + 11n > stack.limit) throw new Error("IRET frame exceeds current SS limit");
      const linear = stack.base + esp;
      const frame = this.#readLinear(Number(linear), 12);
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const targetOffset = BigInt(view.getUint32(0, true));
      const selector = view.getUint16(4, true);
      const restoredFlags = BigInt(view.getUint32(8, true));
      const targetCpl = selector & 3;
      if (targetCpl === this.segments.cpl) {
        const cache = this.segments.prepareCodeTransition(selector, { targetCpl, allowInward: false }).cache;
        if (targetOffset > cache.limit || cache.base + targetOffset >= BigInt(this.memory.byteLength)) throw new Error("IRET target exceeds code segment or guest memory");
        this.segments.installCodeSegment(selector);
        this.setRegister(4, esp + 12n, 32);
      } else if (targetCpl > this.segments.cpl) {
        if (esp + 19n > stack.limit) throw new Error("Outer-privilege IRET frame exceeds current SS limit");
        const outer = this.#readLinear(Number(linear), 20);
        const full = new DataView(outer.buffer, outer.byteOffset, outer.byteLength);
        const outerEsp = BigInt(full.getUint32(12, true));
        const outerSs = full.getUint16(16, true);
        const plan = this.segments.prepareCodeReturn(selector);
        const targetStack = this.segments.prepareStack(outerSs, { targetCpl });
        if (targetOffset > plan.cache.limit || plan.cache.base + targetOffset >= BigInt(this.memory.byteLength)) throw new Error("IRET target exceeds code segment or guest memory");
        if (outerEsp > targetStack.limit) throw new Error("Restored ESP exceeds outer SS limit");
        this.segments.commitPrivilegeTransition(plan, outerSs, targetStack);
        this.setRegister(4, outerEsp, 32);
      } else {
        throw new Error("IRET cannot return to a more privileged ring");
      }
      this.ip = Number(targetOffset);
      this.flags = (restoredFlags & 0x003f7fd7n) | 2n;
    } catch (error) { throw new CpuFault(error.message, start); }
  }

  step() {
    const faultingIp = this.ip;
    try {
      return this.#executeStep();
    } catch (error) {
      if (!(error instanceof PageFault) || !this.exceptionDelivery) throw error;
      try {
        this.deliverException(14, { errorCode: error.errorCode, returnIp: faultingIp });
        return Object.freeze({ state: "exception", vector: 14, errorCode: error.errorCode, ip: this.ip });
      } catch (pageFaultDeliveryError) {
        try {
          this.deliverException(8, { errorCode: 0, returnIp: faultingIp });
          return Object.freeze({ state: "exception", vector: 8, errorCode: 0, ip: this.ip });
        } catch (doubleFaultDeliveryError) {
          throw new CpuFault("Triple fault: page-fault and double-fault delivery both failed", faultingIp);
        }
      }
    }
  }

  #executeStep() {
    if (this.halted && this.pendingInterrupts.length && (this.flags & (1n << 9n)) !== 0n) this.halted = false;
    if (this.halted) return { state: "halted", ip: this.ip };
    const start = this.ip;
    if (this.mode === 32 && (this.flags & (1n << 9n)) !== 0n && this.pendingInterrupts.length) {
      const vector = this.pendingInterrupts[0];
      // A request is consumed only after successful architectural delivery.
      this.#deliverSoftwareInterrupt(vector, this.ip, start, false);
      this.pendingInterrupts.shift();
    }
    let operand16 = false;
    let address32 = false;
    let rex = 0;
    let opcode = this.#fetch8();
    if (opcode === 0x66) { operand16 = true; opcode = this.#fetch8(); }
    if (opcode === 0x67) { address32 = true; opcode = this.#fetch8(); }
    if (this.mode === 64 && opcode >= 0x40 && opcode <= 0x4f) { rex = opcode & 15; opcode = this.#fetch8(); }
    const width = (rex & 8) ? 64 : (operand16 ? 16 : 32);
    const addressWidth = this.mode === 64 && !address32 ? 64 : 32;

    if (opcode === 0xe4 || opcode === 0xe5 || opcode === 0xe6 || opcode === 0xe7
      || opcode === 0xec || opcode === 0xed || opcode === 0xee || opcode === 0xef) {
      const byteOperation = [0xe4, 0xe6, 0xec, 0xee].includes(opcode);
      const input = [0xe4, 0xe5, 0xec, 0xed].includes(opcode);
      const port = opcode >= 0xec ? Number(this.getRegister(2, 16)) : this.#fetch8();
      const ioWidth = byteOperation ? 8 : (this.mode === 64 && !operand16 ? 32 : width);
      if (input) this.setRegister(0, this.#readIo(port, ioWidth, start), ioWidth);
      else this.#writeIo(port, this.getRegister(0, ioWidth), ioWidth, start);
    } else if (opcode === 0xcd || opcode === 0xcc) {
      const vector = opcode === 0xcc ? 3 : this.#fetch8();
      this.#deliverSoftwareInterrupt(vector, this.ip, start);
    } else if (opcode === 0xcf) {
      this.#returnFromInterrupt(start);
    } else if (opcode === 0x90) {
      // NOP
    } else if (opcode === 0xf4) {
      this.halted = true;
    } else if (opcode >= 0xb8 && opcode <= 0xbf) {
      const index = (opcode - 0xb8) | ((rex & 1) ? 8 : 0);
      this.#reg(index);
      this.setRegister(index, this.#fetchUnsigned(width === 64 ? 8 : width / 8), width);
    } else if (opcode >= 0x50 && opcode <= 0x57) {
      const index = (opcode - 0x50) | ((rex & 1) ? 8 : 0);
      this.#reg(index);
      this.#push(this.getRegister(index, this.#stackWidth(width)), this.#stackWidth(width));
    } else if (opcode >= 0x58 && opcode <= 0x5f) {
      const index = (opcode - 0x58) | ((rex & 1) ? 8 : 0);
      this.#reg(index);
      this.setRegister(index, this.#pop(this.#stackWidth(width)), this.#stackWidth(width));
    } else if (opcode === 0x68 || opcode === 0x6a) {
      const immediate = opcode === 0x6a ? this.#fetchSigned(1) : this.#fetchSigned(width === 16 ? 2 : 4);
      this.#push(immediate, this.#stackWidth(width));
    } else if ([0x89,0x8b,0x01,0x03,0x09,0x0b,0x21,0x23,0x29,0x2b,0x31,0x33,0x39,0x3b,0x85].includes(opcode)) {
      const { reg, operand } = this.#decodeModRM(rex, addressWidth);
      const regValue = this.getRegister(reg, width);
      const operandValue = this.#readOperand(operand, width);
      if (opcode === 0x89) this.#writeOperand(operand, regValue, width);
      if (opcode === 0x8b) this.setRegister(reg, operandValue, width);
      if (opcode === 0x01 || opcode === 0x03 || opcode === 0x09 || opcode === 0x0b || opcode === 0x21 || opcode === 0x23) {
        const isReverse = [0x03,0x0b,0x23].includes(opcode);
        const operation = [0x09,0x0b].includes(opcode) ? "or" : [0x21,0x23].includes(opcode) ? "and" : "add";
        const result = this.#alu(operation, isReverse ? regValue : operandValue, isReverse ? operandValue : regValue, width);
        if ([0x01,0x09,0x21].includes(opcode)) this.#writeOperand(operand, result, width); else this.setRegister(reg, result, width);
      }
      if (opcode === 0x29 || opcode === 0x2b || opcode === 0x39 || opcode === 0x3b) {
        const reverse = opcode === 0x2b || opcode === 0x3b;
        const result = this.#alu("sub", reverse ? regValue : operandValue, reverse ? operandValue : regValue, width);
        if (opcode === 0x29) this.#writeOperand(operand, result, width);
        if (opcode === 0x2b) this.setRegister(reg, result, width);
      }
      if (opcode === 0x31 || opcode === 0x33 || opcode === 0x85) {
        const result = this.#alu(opcode === 0x85 ? "test" : "xor", opcode === 0x31 || opcode === 0x85 ? operandValue : regValue, opcode === 0x31 || opcode === 0x85 ? regValue : operandValue, width);
        if (opcode === 0x31) this.#writeOperand(operand, result, width);
        else if (opcode === 0x33) this.setRegister(reg, result, width);
      }
    } else if (opcode === 0xc1 || opcode === 0xd1 || opcode === 0xd3) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      const extension = decoded.reg & 7;
      if (![4, 5, 7].includes(extension)) throw new CpuFault("Unsupported shift extension", start);
      let count = opcode === 0xc1 ? this.#fetch8() : opcode === 0xd1 ? 1 : Number(this.getRegister(1, 8));
      count &= this.mode === 64 && width === 64 ? 0x3f : 0x1f;
      if (count !== 0) {
        const mask = this.#mask(width);
        const original = this.#readOperand(decoded.operand, width) & mask;
        const sign = 1n << BigInt(width - 1);
        let result, carry = false;
        if (extension === 4) {
          carry = count <= width && ((original >> BigInt(width - count)) & 1n) !== 0n;
          result = count >= width ? 0n : (original << BigInt(count)) & mask;
        } else if (extension === 5) {
          carry = count <= width && ((original >> BigInt(count - 1)) & 1n) !== 0n;
          result = count >= width ? 0n : original >> BigInt(count);
        } else {
          carry = count <= width && ((original >> BigInt(count - 1)) & 1n) !== 0n;
          const signed = (original & sign) !== 0n ? original - (1n << BigInt(width)) : original;
          result = count >= width ? ((original & sign) !== 0n ? mask : 0n) : (signed >> BigInt(count)) & mask;
        }
        this.#setArithmeticFlags(result, 0n, 0n, width, "logic");
        if (carry) this.flags |= CF;
        if (count === 1) {
          const overflow = extension === 4 ? (((result & sign) !== 0n) !== carry)
            : extension === 5 ? ((original & sign) !== 0n) : false;
          if (overflow) this.flags |= OF;
        }
        this.#writeOperand(decoded.operand, result, width);
      }
    } else if (opcode === 0x9a) {
      if ((this.controlRegisters.get(0) & 1n) === 0n || this.mode === 64) throw new CpuFault("Immediate far CALL requires 32-bit protected mode", start);
      const offset = this.#fetchUnsigned(operand16 ? 2 : 4);
      const selector = Number(this.#fetchUnsigned(2));
      try {
        if ((selector & 4) !== 0) throw new Error("Far CALL through an LDT selector is unsupported");
        const descriptor = this.gdt.readSegment(selector, { cpl: this.segments.cpl });
        if (!descriptor?.system) throw new Error("Far CALL to ordinary code segments is not implemented");
        if (descriptor.type !== 9) throw new Error("Far CALL task switch requires an available 32-bit TSS");
        // The offset field is architecturally ignored for a TSS task switch.
        void offset;
        this.switchTask(selector, { reason: "call", returnIp: this.ip });
      } catch (error) { throw new CpuFault(error.message, start); }
    } else if (opcode === 0xea) {
      if ((this.controlRegisters.get(0) & 1n) === 0n || this.mode === 64) throw new CpuFault("Immediate far jump requires 32-bit protected mode", start);
      const offset = this.#fetchUnsigned(operand16 ? 2 : 4);
      const selector = Number(this.#fetchUnsigned(2));
      try {
        if ((selector & 4) === 0) {
          const descriptor = this.gdt.readSegment(selector, { cpl: this.segments.cpl });
          if (descriptor?.system) {
            this.switchTask(selector, { reason: "jmp", returnIp: this.ip });
          } else {
            const cache = this.segments.installCodeSegment(selector);
            if (offset > cache.limit) throw new Error("Far-jump target exceeds CS limit");
            const linear = offset + cache.base;
            if (linear >= BigInt(this.memory.byteLength)) throw new Error("Far-jump target exceeds guest memory");
            this.ip = Number(offset);
          }
        } else {
          throw new Error("Far JMP through an LDT selector is unsupported for task switching");
        }
      } catch (error) { throw new CpuFault(error.message, start); }
    } else if (opcode === 0x8e || opcode === 0x8c) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      const segment = decoded.reg & 7;
      const names = ["es", null, "ss", "ds", "fs", "gs"];
      if (segment === 1 || segment === 6 || segment === 7) throw new CpuFault("Invalid segment-register encoding", start);
      if (opcode === 0x8c) {
        const selector = this.segments.registers[names[segment]]?.selector ?? 0;
        this.#writeOperand(decoded.operand, BigInt(selector), 16);
      } else {
        if ((this.controlRegisters.get(0) & 1n) === 0n) throw new CpuFault("Real-mode segment loads are not implemented", start);
        if (this.segments.cpl !== 0 && segment === 2) throw new CpuFault("Loading SS requires CPL 0 in this implementation", start);
        const selector = Number(this.#readOperand(decoded.operand, 16));
        try {
          if (segment === 2) this.segments.loadStack(selector);
          else this.segments.loadData(names[segment], selector);
        } catch (error) { throw new CpuFault(error.message, start); }
      }
    } else if (opcode === 0x63 && this.mode === 64 && (rex & 8)) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      const raw = this.#readOperand(decoded.operand, 32);
      const value = (raw & 0x80000000n) !== 0n ? raw - 0x100000000n : raw;
      this.setRegister(decoded.reg, value, 64);
    } else if (opcode === 0x8d) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      if (decoded.operand.kind !== "memory") throw new CpuFault("LEA requires a memory addressing form", start);
      this.setRegister(decoded.reg, BigInt(decoded.operand.address), width);
    } else if (opcode === 0x69 || opcode === 0x6b) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      const immediate = this.#fetchSigned(opcode === 0x6b ? 1 : (width === 16 ? 2 : 4));
      const signExtend = value => {
        const sign = 1n << BigInt(width - 1);
        const normalized = value & this.#mask(width);
        return (normalized & sign) !== 0n ? normalized - (1n << BigInt(width)) : normalized;
      };
      const product = signExtend(this.#readOperand(decoded.operand, width)) * immediate;
      const result = product & this.#mask(width);
      const overflow = signExtend(result) !== product;
      this.flags &= ~(CF | OF);
      if (overflow) this.flags |= CF | OF;
      this.setRegister(decoded.reg, result, width);
    } else if (opcode === 0xf6) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      const extension = decoded.reg & 7;
      if (![0, 2, 3, 4, 5, 6, 7].includes(extension)) throw new CpuFault("Unsupported F6 byte extension", start);
      const operand = this.#readOperand(decoded.operand, 8);
      if (extension === 0) {
        const immediate = this.#fetchUnsigned(1);
        this.#alu("test", operand, immediate, 8);
      } else if (extension === 2) {
        this.#writeOperand(decoded.operand, (~operand) & 0xffn, 8);
      } else if (extension === 3) {
        const result = this.#alu("sub", 0n, operand, 8);
        this.#writeOperand(decoded.operand, result, 8);
      } else if (extension === 4 || extension === 5) {
        const accumulator = this.getRegister(0, 8);
        const signed = value => (value & 0x80n) !== 0n ? value - 0x100n : value;
        const product = extension === 4 ? accumulator * operand : signed(accumulator) * signed(operand);
        this.setRegister(0, product, 16);
        const overflow = extension === 4 ? (product >> 8n) !== 0n : signed(product & 0xffn) !== product;
        this.flags &= ~(CF | OF);
        if (overflow) this.flags |= CF | OF;
      } else {
        const rawDividend = this.getRegister(0, 16);
        const dividend = extension === 6 ? rawDividend : ((rawDividend & 0x8000n) !== 0n ? rawDividend - 0x10000n : rawDividend);
        const divisor = extension === 6 ? operand : ((operand & 0x80n) !== 0n ? operand - 0x100n : operand);
        if (divisor === 0n) throw new CpuFault("Integer divide by zero", start);
        const quotient = dividend / divisor;
        const remainder = dividend % divisor;
        const min = extension === 6 ? 0n : -128n;
        const max = extension === 6 ? 255n : 127n;
        if (quotient < min || quotient > max) throw new CpuFault("Integer division quotient overflow", start);
        this.setRegister(0, ((remainder & 0xffn) << 8n) | (quotient & 0xffn), 16);
      }
    } else if (opcode === 0xf7) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      const extension = decoded.reg & 7;
      if (![0, 2, 3, 4, 5, 6, 7].includes(extension)) throw new CpuFault("Unsupported F7 integer extension", start);
      const operand = this.#readOperand(decoded.operand, width) & this.#mask(width);
      if (extension === 0) {
        let immediate = this.#fetchUnsigned(width === 16 ? 2 : 4);
        if (width === 64 && (immediate & 0x80000000n)) immediate |= 0xffffffff00000000n;
        this.#alu("test", operand, immediate, width);
      } else {
      const mask = this.#mask(width);
      const signBit = 1n << BigInt(width - 1);
      const signed = value => (value & signBit) !== 0n ? value - (1n << BigInt(width)) : value;
      if (extension === 2) {
        this.#writeOperand(decoded.operand, ~operand & mask, width);
      } else if (extension === 3) {
        const result = this.#alu("sub", 0n, operand, width);
        this.#writeOperand(decoded.operand, result, width);
      } else if (extension === 4 || extension === 5) {
        const accumulator = this.getRegister(0, width);
        const product = extension === 4 ? accumulator * operand : signed(accumulator) * signed(operand);
        const low = product & mask;
        const high = (product >> BigInt(width)) & mask;
        this.setRegister(0, low, width);
        this.setRegister(2, high, width);
        const overflow = extension === 4 ? high !== 0n : signed(low) !== product;
        this.flags &= ~(CF | OF);
        if (overflow) this.flags |= CF | OF;
      } else {
        const high = this.getRegister(2, width);
        const low = this.getRegister(0, width);
        const dividendBits = BigInt(width * 2);
        const rawDividend = (high << BigInt(width)) | low;
        const dividend = extension === 6 ? rawDividend
          : (rawDividend & (1n << (dividendBits - 1n))) !== 0n
            ? rawDividend - (1n << dividendBits) : rawDividend;
        const divisor = extension === 6 ? operand : signed(operand);
        if (divisor === 0n) throw new CpuFault("Integer divide by zero", start);
        const quotient = dividend / divisor;
        const remainder = dividend % divisor;
        const min = extension === 6 ? 0n : -(1n << BigInt(width - 1));
        const max = extension === 6 ? mask : (1n << BigInt(width - 1)) - 1n;
        if (quotient < min || quotient > max) throw new CpuFault("Integer division quotient overflow", start);
        this.setRegister(0, quotient, width);
        this.setRegister(2, remainder, width);
      }
      }
    } else if (opcode === 0xff) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      const extension = decoded.reg & 7;
      const arithmeticWidth = this.mode === 64 ? (rex & 8 ? 64 : operand16 ? 16 : 32) : width;
      const controlWidth = this.#stackWidth(width);
      const pushWidth = this.mode === 64 && operand16 ? 16 : controlWidth;
      const value = this.#readOperand(decoded.operand, extension === 2 || extension === 4 ? controlWidth : extension === 6 ? pushWidth : arithmeticWidth);
      if (extension === 0 || extension === 1) {
        const carry = this.flags & CF;
        const result = this.#alu(extension === 0 ? "add" : "sub", value, 1n, arithmeticWidth);
        this.flags = (this.flags & ~CF) | carry;
        this.#writeOperand(decoded.operand, result, arithmeticWidth);
      } else if (extension === 2 || extension === 4) {
        const target = value & this.#mask(this.mode);
        if (!this.addressSpace && target >= BigInt(this.memory.byteLength)) throw new CpuFault("Indirect branch target outside memory", start);
        if (target > BigInt(Number.MAX_SAFE_INTEGER)) throw new CpuFault("Indirect branch target exceeds host safe integer range", start);
        if (extension === 2) this.#push(BigInt(this.ip), this.#stackWidth(width));
        this.ip = Number(target);
      } else if (extension === 6) {
        this.#push(value, pushWidth);
      } else {
        throw new CpuFault("Unsupported FF integer extension", start);
      }
    } else if (opcode === 0xc7) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      if (((decoded.reg & 7) !== 0)) throw new CpuFault("Unsupported C7 extension", start);
      const immediateBytes = width === 16 ? 2 : 4;
      let immediate = this.#fetchUnsigned(immediateBytes);
      if (width === 64 && (immediate & 0x80000000n)) immediate |= 0xffffffff00000000n;
      this.#writeOperand(decoded.operand, immediate, width);
    } else if (opcode === 0x81 || opcode === 0x83) {
      const decoded = this.#decodeModRM(rex, addressWidth);
      const extension = decoded.reg & 7;
      if (![0, 1, 4, 5, 6, 7].includes(extension)) throw new CpuFault("Unsupported integer group-1 extension", start);
      const immediateBytes = opcode === 0x83 ? 1 : (width === 16 ? 2 : 4);
      let immediate = opcode === 0x83 ? this.#fetchSigned(1) : this.#fetchUnsigned(immediateBytes);
      if (opcode === 0x81 && width === 64 && (immediate & 0x80000000n)) immediate |= 0xffffffff00000000n;
      const operation = extension === 0 ? "add" : extension === 1 ? "or" : extension === 4 ? "and" : extension === 5 ? "sub" : extension === 6 ? "xor" : "cmp";
      const left = this.#readOperand(decoded.operand, width);
      const result = this.#alu(operation, left, immediate, width);
      if (operation !== "cmp") this.#writeOperand(decoded.operand, result, width);
    } else if ([0x05,0x0d,0x25,0x2d,0x35,0x3d].includes(opcode)) {
      const bytes = width === 64 ? 4 : width / 8;
      let immediate = this.#fetchUnsigned(bytes);
      if (width === 64 && (immediate & 0x80000000n)) immediate |= 0xffffffff00000000n;
      const operation = opcode === 0x05 ? "add" : opcode === 0x0d ? "or" : opcode === 0x25 ? "and" : opcode === 0x2d ? "sub" : opcode === 0x35 ? "xor" : "cmp";
      const result = this.#alu(operation, this.getRegister(0, width), immediate, width);
      if (operation !== "cmp") this.setRegister(0, result, width);
    } else if (opcode === 0xeb || opcode === 0xe9 || opcode === 0xe8) {
      const displacement = this.#fetchSigned(opcode === 0xeb ? 1 : 4);
      if (opcode === 0xe8) this.#push(BigInt(this.ip), this.#stackWidth(width));
      this.#branch(displacement, start);
    } else if (opcode === 0xc3) {
      const target = this.#pop(this.#stackWidth(width));
      const normalized = target & this.#mask(this.mode);
      if (!this.addressSpace && normalized >= BigInt(this.memory.byteLength)) throw new CpuFault("Return target outside memory", start);
      if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) throw new CpuFault("Return target exceeds host safe integer range", start);
      this.ip = Number(normalized);
    } else if (opcode >= 0x70 && opcode <= 0x7f) {
      const displacement = this.#fetchSigned(1);
      if (this.#condition(opcode & 15)) this.#branch(displacement, start);
    } else if (opcode === 0x0f) {
      const second = this.#fetch8();
      if (second === 0x01) {
        const decoded = this.#decodeModRM(rex, addressWidth);
        const extension = decoded.reg & 7;
        if (decoded.operand.kind !== "memory" || (decoded.reg & 8) !== 0 || (extension !== 2 && extension !== 3)) {
          throw new CpuFault("LGDT/LIDT require a memory operand", start);
        }
        if ((this.controlRegisters.get(0) & 1n) !== 0n && this.segments.cpl !== 0) {
          throw new CpuFault("LGDT/LIDT require CPL 0 in protected mode", start);
        }
        const length = this.mode === 64 ? 10 : 6;
        const raw = this.addressSpace ? this.addressSpace.read(BigInt(decoded.operand.address), length) : this.memory.read(decoded.operand.address, length);
        const limit = raw[0] | (raw[1] << 8);
        let base = 0n;
        const baseBytes = this.mode === 64 ? 8 : 4;
        for (let i = 0; i < baseBytes; i++) base |= BigInt(raw[2 + i]) << BigInt(i * 8);
        try {
          if (extension === 2) {
            this.systemTables.loadGdtr(base, limit);
            this.gdt.setRegister(base, limit);
          } else {
            this.systemTables.loadIdtr(base, limit);
            this.idt.setRegister(base, limit);
          }
        } catch (error) { throw new CpuFault(error.message, start); }
      } else if (second === 0x00) {
        const decoded = this.#decodeModRM(rex, addressWidth);
        const extension = decoded.reg & 7;
        if ((decoded.reg & 8) !== 0 || (extension !== 2 && extension !== 3)) {
          throw new CpuFault("Invalid LLDT/LTR opcode extension", start);
        }
        if ((this.controlRegisters.get(0) & 1n) === 0n || this.segments.cpl !== 0) {
          throw new CpuFault("LLDT/LTR require protected mode at CPL 0", start);
        }
        const selector = Number(this.#readOperand(decoded.operand, 16));
        if (selector === 0) {
          if (extension === 2) { this.systemTables.clearLdtr(); this.segments.ldt = null; }
          else throw new CpuFault("LTR selector cannot be null", start);
        } else {
          try {
            if ((selector & 4) !== 0) throw new Error("LLDT/LTR selector must reference the GDT");
            const descriptor = this.gdt.readSystemDescriptor(selector, {
              allowedTypes: extension === 2 ? [2] : [9]
            });
            const access = descriptor.raw[5];
            const base = descriptor.base;
            const limit = descriptor.limit;
            if (limit > 0xffffn) throw new Error("LLDT/LTR descriptor limit exceeds supported 64-KiB table/TSS bound");
            if (extension === 2) {
              if (limit < 7n) throw new Error("LLDT descriptor limit is too small");
              this.systemTables.loadLdtr({ selector, base, limit: Number(limit), present: true, usable: true });
              this.segments.ldt = new X86DescriptorTable(this.memory, { base, limit: Number(limit), kind: "ldt", longMode: this.mode === 64 });
            } else {
              if (limit < 0x67n) throw new Error("LTR requires a 104-byte TSS");
              // LTR accepts only an available TSS (type 9); the GDT decoder
              // reads the 16-byte descriptor form in long mode. Mark it busy
              // only after the task-register bounds have validated.
              this.systemTables.loadTaskRegister({ selector, base, limit: Number(limit), present: true, busy: true, usable: true });
              this.memory.write(Number(this.systemTables.gdtr.base) + ((selector >>> 3) * 8) + 5, Uint8Array.of((access & 0xf0) | 0x0b));
            }
          } catch (error) { throw new CpuFault(error.message, start); }
        }
      } else if (second >= 0x80 && second <= 0x8f) {
        const displacement = this.#fetchSigned(4);
        if (this.#condition(second & 15)) this.#branch(displacement, start);
      } else if ([0xb6, 0xb7, 0xbe, 0xbf].includes(second)) {
        const decoded = this.#decodeModRM(rex, addressWidth);
        const sourceWidth = (second === 0xb6 || second === 0xbe) ? 8 : 16;
        const raw = this.#readOperand(decoded.operand, sourceWidth);
        const signExtend = second === 0xbe || second === 0xbf;
        const signBit = 1n << BigInt(sourceWidth - 1);
        const value = signExtend && (raw & signBit) !== 0n ? raw - (1n << BigInt(sourceWidth)) : raw;
        this.setRegister(decoded.reg, value, width);
      } else if (second === 0xaf) {
        const decoded = this.#decodeModRM(rex, addressWidth);
        const signExtend = (value, bits) => {
          const sign = 1n << BigInt(bits - 1);
          const mask = this.#mask(bits);
          const normalized = value & mask;
          return (normalized & sign) !== 0n ? normalized - (1n << BigInt(bits)) : normalized;
        };
        const left = signExtend(this.getRegister(decoded.reg, width), width);
        const right = signExtend(this.#readOperand(decoded.operand, width), width);
        const product = left * right;
        const result = product & this.#mask(width);
        const overflow = signExtend(result, width) !== product;
        this.flags &= ~(CF | OF);
        if (overflow) this.flags |= CF | OF;
        this.setRegister(decoded.reg, result, width);
      } else if (second === 0xa2) {
        // CPUID reports only the small, explicitly implemented NEXARA feature set.
        const leaf = this.getRegister(0, 32);
        const subleaf = this.getRegister(1, 32);
        let eax = 0n, ebx = 0n, ecx = 0n, edx = 0n;
        const pack = (value) => {
          let result = 0n;
          for (let i = 0; i < 4; i++) result |= BigInt(value.charCodeAt(i) || 0) << BigInt(i * 8);
          return result;
        };
        if (leaf === 0n) {
          eax = 1n;
          const vendor = "NEXARA      ";
          ebx = pack(vendor.slice(0, 4));
          edx = pack(vendor.slice(4, 8));
          ecx = pack(vendor.slice(8, 12));
        } else if (leaf === 1n) {
          eax = 0x00000663n;
          // TSC is exposed because the deterministic RDTSC subset is implemented.
          edx = 1n << 4n;
        } else if (leaf === 0x80000000n) {
          eax = 0x80000001n;
        } else if (leaf === 0x80000001n && this.mode === 64) {
          // Long mode capability only; this does not imply full x86-64 compatibility.
          edx = 1n << 29n;
        }
        this.setRegister(0, eax, 32);
        this.setRegister(3, ebx, 32);
        this.setRegister(1, ecx, 32);
        this.setRegister(2, edx, 32);
        void subleaf;
      } else if (second === 0x20 || second === 0x22) {
        const modrm = this.#fetch8();
        if ((modrm >> 6) !== 3 || (rex & 4) !== 0) {
          throw new CpuFault("MOV to/from control register requires register-direct encoding", start);
        }
        const control = (modrm >> 3) & 7;
        if (this.segments.cpl !== 0) throw new CpuFault("MOV CR requires CPL 0", start);
        const general = (modrm & 7) | ((rex & 1) ? 8 : 0);
        this.#reg(general);
        if (second === 0x20) this.setRegister(general, this.readControlRegister(control), this.mode);
        else this.writeControlRegister(control, this.getRegister(general, this.mode));
      } else if (second === 0x30) {
        const index = Number(this.getRegister(1, 32));
        const value = (this.getRegister(2, 32) << 32n) | this.getRegister(0, 32);
        this.writeMsr(index, value);
      } else if (second === 0x32) {
        const value = this.readMsr(Number(this.getRegister(1, 32)));
        this.setRegister(0, value & 0xffffffffn, 32);
        this.setRegister(2, (value >> 32n) & 0xffffffffn, 32);
      } else if (second === 0x31) {
        const timestamp = BigInt(this.instructionsExecuted);
        this.setRegister(0, timestamp & 0xffffffffn, 32);
        this.setRegister(2, timestamp >> 32n, 32);
      } else throw new CpuFault(`Unsupported 0F opcode 0x${second.toString(16)}`, start);
    } else {
      throw new CpuFault(`Unsupported opcode 0x${opcode.toString(16).padStart(2, "0")}`, start);
    }

    this.instructionsExecuted++;
    return { state: this.halted ? "halted" : "running", ip: this.ip, instructionPointer: start };
  }

  run({ maxInstructions = 100000 } = {}) {
    if (!Number.isInteger(maxInstructions) || maxInstructions < 1) throw new RangeError("maxInstructions must be positive");
    let executed = 0;
    while (!this.halted && executed < maxInstructions) { this.step(); executed++; }
    return { state: this.halted ? "halted" : "limit", instructionsExecuted: executed, ip: this.ip };
  }

  saveState() {
    return {
      format: "nexara-x86-state-v1",
      mode: this.mode,
      ip: this.ip,
      registers: this.registers.map(value => value.toString()),
      flags: this.flags.toString(),
      halted: this.halted,
      pendingInterrupts: [...this.pendingInterrupts],
      instructionsExecuted: this.instructionsExecuted,
      controlRegisters: Object.fromEntries([...this.controlRegisters].map(([key,value]) => [String(key), value.toString()])),
      efer: this.efer.toString(),
      systemTables: this.systemTables.snapshot(),
      segments: this.segments.snapshot(),
      memory: this.memory.snapshot(),
      addressSpace: this.addressSpace ? this.addressSpace.snapshot() : null,
      pageTableRoot: this.addressSpace?.pageTableRoot === null || !this.addressSpace ? null : this.addressSpace.pageTableRoot.toString(),
      legacyPaging32: this.legacyPaging32 ? this.legacyPaging32.snapshot() : null
    };
  }

  loadState(state) {
    if (!state || state.format !== "nexara-x86-state-v1" || state.mode !== this.mode
      || !Number.isSafeInteger(state.ip) || state.ip < 0
      || !Array.isArray(state.registers) || state.registers.length !== 16
      || !state.registers.every(value => typeof value === "string" && /^\d+$/.test(value))
      || typeof state.flags !== "string" || !/^\d+$/.test(state.flags)
      || typeof state.halted !== "boolean"
      || !Array.isArray(state.pendingInterrupts) || state.pendingInterrupts.length > 256
      || !state.pendingInterrupts.every(vector => Number.isInteger(vector) && vector >= 0 && vector <= 255)
      || !Number.isSafeInteger(state.instructionsExecuted) || state.instructionsExecuted < 0
      || !state.controlRegisters || !["0","2","3","4"].every(key => typeof state.controlRegisters[key] === "string" && /^\d+$/.test(state.controlRegisters[key]))
      || typeof state.efer !== "string" || !/^\d+$/.test(state.efer)
      || !state.systemTables || state.systemTables.format !== "nexara-x86-system-tables-v1"
      || !state.segments || state.segments.format !== "nexara-x86-segments-v1"
      || !(state.memory instanceof Uint8Array) || state.memory.byteLength <= state.ip
      || state.memory.byteLength % 4096 !== 0
      || (this.addressSpace && !Array.isArray(state.addressSpace))
      || (state.pageTableRoot !== null && state.pageTableRoot !== undefined && (typeof state.pageTableRoot !== "string" || !/^\d+$/.test(state.pageTableRoot)))
      || (!this.addressSpace && state.pageTableRoot != null)
      || (this.legacyPaging32 && (!state.legacyPaging32 || state.legacyPaging32.format !== "nexara-legacy-paging32-v1"))
      || (!this.legacyPaging32 && state.legacyPaging32 != null)) {
      throw new TypeError("Invalid or incompatible x86 CPU state");
    }
    const registers = state.registers.map(value => BigInt(value));
    const flags = BigInt(state.flags);
    if (registers.some(value => value > this.#mask(this.mode)) || flags > this.#mask(64)) {
      throw new RangeError("CPU state contains out-of-range values");
    }
    this.memory.restore(state.memory);
    if (this.legacyPaging32) this.legacyPaging32.restore(state.legacyPaging32);
    if (this.addressSpace) {
      this.addressSpace.restore(state.addressSpace);
      if (state.pageTableRoot == null) this.addressSpace.clearPageTableRoot();
      else this.addressSpace.setPageTableRoot(BigInt(state.pageTableRoot));
    }
    this.ip = state.ip;
    this.registers = registers;
    this.flags = flags;
    this.halted = state.halted;
    this.pendingInterrupts = [...state.pendingInterrupts];
    this.instructionsExecuted = state.instructionsExecuted;
    this.controlRegisters = new Map(["0","2","3","4"].map(key => [Number(key), BigInt(state.controlRegisters[key])]));
    this.efer = BigInt(state.efer);
    this.systemTables.restore(state.systemTables);
    this.#syncDescriptorTables();
    this.segments.restore(state.segments);
    this.#syncPagingState();
  }

  registerSnapshot() {
    return Object.fromEntries(REG_NAMES.slice(0, this.mode === 64 ? 16 : 8).map((name, i) => [name, this.registers[i].toString()]));
  }
}
