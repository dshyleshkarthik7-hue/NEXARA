import test from "node:test";
import assert from "node:assert/strict";
import { X86InterpreterBackend } from "../packages/x86-core/src/backend.js";

test("x86 backend advertises its real subset and does not claim Linux boot", () => {
  const backend = new X86InterpreterBackend();
  const capabilities = backend.getCapabilities();
  assert.deepEqual(capabilities.modes, [32, 64]);
  assert.equal(capabilities.linuxBoot, false);
  assert.equal(capabilities.completeX86Compatibility, false);
});

test("backend creates a 32-bit machine and executes a guest program", async () => {
  const backend = new X86InterpreterBackend();
  const machine = await backend.createMachine({ mode: 32, memoryPages: 2 });
  machine.loadProgram(Uint8Array.from([0xb8, 42, 0, 0, 0, 0xf4]));
  const result = machine.run();
  assert.equal(result.state, "halted");
  assert.equal(machine.getRegister(0, 32), 42n);
  assert.equal(machine.state.mode, 32);
  assert.equal(machine.state.halted, true);
});

test("backend creates a 64-bit machine and restores saved execution state", async () => {
  const backend = new X86InterpreterBackend();
  const machine = await backend.createMachine({ mode: 64, memoryPages: 1 });
  machine.loadProgram(Uint8Array.from([0x48,0xb8,7,0,0,0,0,0,0,0,0xf4]));
  machine.step();
  const state = machine.saveState();
  machine.setRegister(0, 99n, 64);
  machine.loadState(state);
  assert.equal(machine.getRegister(0, 64), 7n);
  assert.equal(machine.state.instructionPointer, 10);
});

test("backend rejects invalid configurations and out-of-bounds programs", async () => {
  const backend = new X86InterpreterBackend();
  await assert.rejects(backend.createMachine({ mode: 16 }), RangeError);
  const machine = await backend.createMachine({ memoryPages: 1, maximumPages: 1 });
  assert.throws(() => machine.loadProgram(new Uint8Array(4097)), RangeError);
});

import { parseHexProgram } from "../packages/x86-core/src/backend.js";

test("hexadecimal program parser accepts whitespace and comma-separated bytes", () => {
  assert.deepEqual([...parseHexProgram("B8 2A 00 00 00 F4")], [0xb8,0x2a,0,0,0,0xf4]);
  assert.deepEqual([...parseHexProgram("0x48, 0xB8")], [0x48,0xb8]);
});

test("hexadecimal program parser rejects empty and malformed bytes", () => {
  assert.throws(() => parseHexProgram(""), TypeError);
  assert.throws(() => parseHexProgram("B8 2"), TypeError);
  assert.throws(() => parseHexProgram("GG"), TypeError);
});


test("MMU-backed machine fetches instructions and accesses guest data through mappings", async () => {
  const backend = new X86InterpreterBackend();
  const machine = await backend.createMachine({ mode: 32, memoryPages: 2, virtualMemory: true });
  assert.ok(machine.addressSpace);
  machine.loadProgram(Uint8Array.from([0x8b,0x03,0xf4]));
  machine.setRegister(3, 0x1000n, 32);
  machine.writeMemory(0x1000, Uint8Array.of(0x78,0x56,0x34,0x12));
  const result = machine.run();
  assert.equal(result.state, "halted");
  assert.equal(machine.getRegister(0,32), 0x12345678n);
});

test("MMU-backed CPU enforces data read and instruction execute permissions", async () => {
  const backend = new X86InterpreterBackend();
  const machine = await backend.createMachine({ mode: 32, memoryPages: 2, virtualMemory: true });
  machine.loadProgram(Uint8Array.from([0x8b,0x03,0xf4]));
  machine.setRegister(3, 0x1000n, 32);
  machine.addressSpace.protect(0x1000n, { read: false, write: false });
  assert.throws(() => machine.step(), error => error.name === "PageFault" && error.present);

  const execute = await backend.createMachine({ mode: 32, memoryPages: 1, virtualMemory: true });
  execute.loadProgram(Uint8Array.from([0xf4]));
  execute.addressSpace.protect(0n, { execute: false });
  assert.throws(() => execute.step(), error => error.name === "PageFault" && error.instruction);
});


test("MMU-backed machine save state restores mappings and permissions", async () => {
  const backend = new X86InterpreterBackend();
  const machine = await backend.createMachine({ mode: 32, memoryPages: 2, virtualMemory: true });
  machine.addressSpace.protect(0x1000n, { read: false, write: false });
  const state = machine.saveState();
  machine.addressSpace.protect(0x1000n, { read: true, write: true });
  assert.deepEqual([...machine.readMemory(0x1000, 1)], [0]);
  machine.loadState(state);
  assert.throws(() => machine.readMemory(0x1000, 1), error => error.name === "PageFault" && error.present);
});


test("CPU save state preserves the hardware-style page-table root", async () => {
  const backend = new X86InterpreterBackend();
  const machine = await backend.createMachine({ mode: 64, memoryPages: 2, virtualMemory: true });
  machine.cpu.writeControlRegister(4, 1n << 5n);
  machine.cpu.writeControlRegister(0, 0xe0000011n);
  machine.cpu.writeControlRegister(3, 0n);
  const state = machine.saveState();
  machine.addressSpace.clearPageTableRoot();
  assert.equal(machine.addressSpace.pageTableRoot, null);
  machine.loadState(state);
  assert.equal(machine.addressSpace.pageTableRoot, 0n);
});


test("CR0 CR3 and CR4 validate paging prerequisites and reserved bits", async () => {
  const machine = await new X86InterpreterBackend().createMachine({ mode: 64, memoryPages: 2, virtualMemory: true });
  const cpu = machine.cpu;
  assert.equal(cpu.readControlRegister(0), 0x60000010n);
  assert.throws(() => cpu.writeControlRegister(0, 1n << 31n), /requires CR0.PE/i);
  assert.throws(() => cpu.writeControlRegister(4, 1n << 63n), /reserved bits/i);
  assert.throws(() => cpu.writeControlRegister(4, 1n << 7n), /reserved bits/i);
  const mode32 = await new X86InterpreterBackend().createMachine({ mode: 32, memoryPages: 2, virtualMemory: true });
  assert.throws(() => mode32.cpu.writeControlRegister(0, 0x80000011n), /32-bit paging is not implemented/i);
  assert.throws(() => cpu.writeControlRegister(3, 1n), /aligned/i);
  cpu.writeControlRegister(4, 1n << 5n); // CR4.PAE
  cpu.writeControlRegister(0, 0xe0000011n); // CR0.PG | CD | NW | PE
  assert.equal(cpu.readControlRegister(0), 0xe0000011n);
  assert.throws(() => cpu.writeControlRegister(4, 0n), /cannot clear CR4.PAE/i);
});

test("EFER LME activates modeled LMA only with PAE paging and controls NX", async () => {
  const machine = await new X86InterpreterBackend().createMachine({ mode: 64, memoryPages: 5, virtualMemory: true });
  const cpu = machine.cpu;
  cpu.writeControlRegister(4, 1n << 5n);
  cpu.writeControlRegister(0, 0xe0000011n);
  cpu.writeMsr(0xc0000080, (1n << 8n) | (1n << 11n));
  assert.equal((cpu.readMsr(0xc0000080) & (1n << 10n)) !== 0n, true);
  assert.equal((cpu.readMsr(0xc0000080) & (1n << 11n)) !== 0n, true);
  assert.equal(machine.addressSpace.pageTableRoot, 0n);
  assert.throws(() => cpu.writeMsr(0xc0000080, 1n << 10n), /reserved or read-only/i);
  assert.throws(() => cpu.writeMsr(0xc0000080, 1n << 11n), /cannot clear EFER.LME/i);
});

test("control registers and EFER survive save-state restore", async () => {
  const machine = await new X86InterpreterBackend().createMachine({ mode: 64, memoryPages: 2, virtualMemory: true });
  machine.cpu.writeControlRegister(4, 1n << 5n);
  machine.cpu.writeControlRegister(0, 0xe0000011n);
  machine.cpu.writeMsr(0xc0000080, (1n << 8n) | (1n << 11n));
  const state = machine.saveState();
  machine.cpu.writeControlRegister(0, 0x60000011n); // leave paging before clearing LME
  machine.cpu.writeMsr(0xc0000080, 0n);
  machine.cpu.writeControlRegister(0, 0x60000010n);
  machine.loadState(state);
  assert.equal(machine.cpu.readControlRegister(4), 1n << 5n);
  assert.equal(machine.cpu.readControlRegister(0), 0xe0000011n);
  assert.equal((machine.cpu.readMsr(0xc0000080) & (1n << 10n)) !== 0n, true);
});


test("EFER.NXE controls execution faults for NX guest page-table entries", async () => {
  const machine = await new X86InterpreterBackend().createMachine({ mode: 64, memoryPages: 5, virtualMemory: true });
  const put64 = (address, value) => {
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
    machine.memory.write(address, bytes);
  };
  put64(0, 0x1007n);
  put64(0x1000, 0x2007n);
  put64(0x2000, 0x3007n);
  put64(0x3000 + 4 * 8, 0x4007n | (1n << 63n));
  machine.cpu.writeControlRegister(4, 1n << 5n);
  machine.cpu.writeControlRegister(3, 0n);
  machine.cpu.writeMsr(0xc0000080, 1n << 11n); // NXE
  machine.cpu.writeControlRegister(0, 0xe0000011n); // enable paging and protected mode
  assert.throws(() => machine.addressSpace.fetch(0x4000n, 1), error =>
    error.name === "PageFault" && error.present && error.instruction && !error.reserved);
  machine.cpu.writeMsr(0xc0000080, 0n); // NX without NXE is a reserved-bit fault
  assert.throws(() => machine.addressSpace.fetch(0x4000n, 1), error =>
    error.name === "PageFault" && error.present && error.instruction && error.reserved);
});


test("guest MOV CR instructions read and write CR0 CR3 and CR4", async () => {
  const machine = await new X86InterpreterBackend().createMachine({ mode: 64, memoryPages: 2 });
  machine.cpu.writeControlRegister(4, 1n << 5n);
  machine.loadProgram(Uint8Array.from([0x0f,0x20,0xe0])); // mov rax, cr4
  machine.step();
  assert.equal(machine.getRegister(0,64), 1n << 5n);

  machine.setRegister(0, 0x1000n, 64);
  machine.loadProgram(Uint8Array.from([0x0f,0x22,0xd8])); // mov cr3, rax
  machine.step();
  assert.equal(machine.cpu.readControlRegister(3), 0x1000n);

  machine.loadProgram(Uint8Array.from([0x0f,0x20,0xd8])); // mov rax, cr3
  machine.step();
  assert.equal(machine.getRegister(0,64), 0x1000n);
});

test("guest RDMSR and WRMSR access the modeled EFER register", async () => {
  const machine = await new X86InterpreterBackend().createMachine({ mode: 64, memoryPages: 2 });
  machine.setRegister(1, 0xc0000080n, 32); // ECX = EFER MSR
  machine.setRegister(0, (1n << 11n) | 1n, 32);
  machine.setRegister(2, 0n, 32);
  machine.loadProgram(Uint8Array.from([0x0f,0x30])); // wrmsr
  machine.step();
  assert.equal(machine.cpu.readMsr(0xc0000080), 0x801n);

  machine.setRegister(0, 0n, 32);
  machine.loadProgram(Uint8Array.from([0x0f,0x32])); // rdmsr
  machine.step();
  assert.equal(machine.getRegister(0,32), 0x801n);
  assert.equal(machine.getRegister(2,32), 0n);
});

test("guest control-register instructions reject memory forms and unsupported registers", async () => {
  const memoryForm = await new X86InterpreterBackend().createMachine({ mode: 64, memoryPages: 1 });
  memoryForm.loadProgram(Uint8Array.from([0x0f,0x20,0x00]));
  assert.throws(() => memoryForm.step(), /register-direct/i);

  const unsupported = await new X86InterpreterBackend().createMachine({ mode: 64, memoryPages: 1 });
  unsupported.loadProgram(Uint8Array.from([0x0f,0x20,0xc8])); // CR1 is reserved/unsupported
  assert.throws(() => unsupported.step(), /unsupported control register/i);
});
