import test from "node:test";
import assert from "node:assert/strict";
import { GuestMemory, PcAtInterruptFabric } from "../packages/runtime/src/index.js";
import { X86Cpu } from "../packages/x86-core/src/index.js";

test("x86 IN and OUT immediate-port instructions use the guest I/O bus", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  memory.write(0, Uint8Array.from([0xe6, 0x21, 0xe4, 0x21, 0xf4])); // OUT 0x21,AL; IN AL,0x21; HLT
  const calls = [];
  const ioBus = {
    write(port, value, width) { calls.push(["write", port, value, width]); },
    read(port, width) { calls.push(["read", port, width]); return 0x5a; }
  };
  const cpu = new X86Cpu({ memory, mode: 32, ioBus });
  cpu.setRegister(0, 0xa5n, 8);
  cpu.step();
  cpu.step();
  assert.deepEqual(calls, [["write", 0x21, 0xa5n, 8], ["read", 0x21, 8]]);
  assert.equal(cpu.getRegister(0, 8), 0x5an);
});

test("x86 IN and OUT DX instructions use DX and reject missing or privileged buses", () => {
  const memory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  memory.write(0, Uint8Array.from([0xee, 0xec, 0xf4])); // OUT DX,AL; IN AL,DX; HLT
  const calls = [];
  const ioBus = {
    write(port, value, width) { calls.push(["write", port, value, width]); },
    read(port, width) { calls.push(["read", port, width]); return 0x33; }
  };
  const cpu = new X86Cpu({ memory, mode: 32, ioBus });
  cpu.setRegister(2, 0x40n, 16);
  cpu.setRegister(0, 0x11n, 8);
  cpu.step(); cpu.step();
  assert.deepEqual(calls, [["write", 0x40, 0x11n, 8], ["read", 0x40, 8]]);
  assert.equal(cpu.getRegister(0, 8), 0x33n);

  const noBusMemory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  noBusMemory.write(0, Uint8Array.from([0xe4, 0x40]));
  const noBus = new X86Cpu({ memory: noBusMemory, mode: 32 });
  assert.throws(() => noBus.step(), /without an attached guest I\/O bus/);

  const deniedMemory = new GuestMemory({ initialPages: 1, maximumPages: 1 });
  deniedMemory.write(0, Uint8Array.from([0xe4, 0x40]));
  const denied = new X86Cpu({ memory: deniedMemory, mode: 32, ioBus });
  denied.segments.setCpl(3);
  assert.throws(() => denied.step(), /I\/O privilege check failed/);
});

test("PC/AT fabric satisfies the CPU I/O bus contract with byte-only device widths", () => {
  const fabric = new PcAtInterruptFabric();
  fabric.ioWrite(0x21, 0x12);
  assert.equal(fabric.read(0x21, 8), 0x12);
  assert.throws(() => fabric.read(0x21, 16), /byte reads only/);
  assert.throws(() => fabric.write(0x21, 0x1234n, 16), /byte writes only/);
});


test("ring-3 I/O permissions are checked against the loaded TSS bitmap", () => {
  const memory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  memory.write(0, Uint8Array.from([0xe4, 0x40, 0xf4])); // IN AL,0x40
  const ioBus = { read() { return 0x7b; }, write() {} };
  const cpu = new X86Cpu({ memory, mode: 32, ioBus });
  cpu.segments.setCpl(3);
  cpu.systemTables.loadTaskRegister({ selector: 0x28, base: 0x400, limit: 0x1ff, present: true, busy: true });
  // TSS I/O-map base at offset 102; bitmap at offset 104. Port 0x40 bit is clear.
  memory.write(0x400 + 102, Uint8Array.of(104, 0));
  memory.write(0x400 + 104, new Uint8Array(32));
  cpu.step();
  assert.equal(cpu.getRegister(0, 8), 0x7bn);

  const deniedMemory = new GuestMemory({ initialPages: 2, maximumPages: 2 });
  deniedMemory.write(0, Uint8Array.from([0xe4, 0x40]));
  const denied = new X86Cpu({ memory: deniedMemory, mode: 32, ioBus });
  denied.segments.setCpl(3);
  denied.systemTables.loadTaskRegister({ selector: 0x28, base: 0x400, limit: 0x1ff, present: true, busy: true });
  deniedMemory.write(0x400 + 102, Uint8Array.of(104, 0));
  const bitmap = new Uint8Array(32); bitmap[8] = 1;
  deniedMemory.write(0x400 + 104, bitmap);
  assert.throws(() => denied.step(), /TSS I\/O bitmap denies/);
});
