import { AtaPioDevice } from "./ata-pio.js";
/**
 * Deterministic PC/AT interrupt-controller and PIT models.
 * These are device primitives; CPU IDT delivery and full chipset timing remain separate.
 */
export class Pic8259 {
  constructor() {
    this.master = this.#chip();
    this.slave = this.#chip();
  }

  #chip() {
    return { irr: 0, isr: 0, imr: 0, vectorBase: 0, initStep: 0, expectIcw4: false, readIsr: false, autoEoi: false };
  }

  #chipFor(port) {
    if (port === 0x20 || port === 0x21) return [this.master, port & 1];
    if (port === 0xa0 || port === 0xa1) return [this.slave, port & 1];
    throw new RangeError("Invalid PIC I/O port");
  }

  write(port, value) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError("PIC value must be a byte");
    const [chip, data] = this.#chipFor(port);
    if (!data) {
      if (value & 0x10) {
        chip.irr = chip.isr = chip.imr = 0;
        chip.initStep = 1;
        chip.expectIcw4 = Boolean(value & 1);
        chip.autoEoi = false;
        return;
      }
      if (value & 0x08) {
        chip.readIsr = Boolean(value & 1);
        return;
      }
      if ((value & 0x18) === 0) {
        const command = (value >> 5) & 7;
        if (command === 1) {
          const irq = this.#highest(chip.isr);
          if (irq >= 0) chip.isr &= ~(1 << irq);
        } else if (command === 5) {
          const irq = value & 7;
          if (chip.isr & (1 << irq)) chip.isr &= ~(1 << irq);
        }
      }
      return;
    }
    if (chip.initStep === 1) {
      if ((value & 7) !== 0) throw new Error("PIC vector base must be aligned to eight");
      chip.vectorBase = value;
      chip.initStep = 2;
    } else if (chip.initStep === 2) {
      chip.initStep = (value & 2) ? 3 : (chip.expectIcw4 ? 4 : 0);
    } else if (chip.initStep === 3) {
      chip.initStep = chip.expectIcw4 ? 4 : 0;
    } else if (chip.initStep === 4) {
      chip.autoEoi = Boolean(value & 2);
      chip.initStep = 0;
    } else {
      chip.imr = value;
    }
  }

  read(port) {
    const [chip, data] = this.#chipFor(port);
    if (data) return chip.imr;
    return chip.readIsr ? chip.isr : chip.irr;
  }

  raise(irq) {
    if (!Number.isInteger(irq) || irq < 0 || irq > 15) throw new RangeError("IRQ must be 0..15");
    if (irq < 8) this.master.irr |= 1 << irq;
    else {
      this.slave.irr |= 1 << (irq - 8);
      this.master.irr |= 1 << 2;
    }
  }

  #highest(bits) {
    for (let i = 0; i < 8; i++) if (bits & (1 << i)) return i;
    return -1;
  }

  acknowledge() {
    const masterPending = this.master.irr & ~this.master.imr;
    const masterIrq = this.#highest(masterPending);
    if (masterIrq < 0) return null;
    if (masterIrq === 2) {
      const slaveIrq = this.#highest(this.slave.irr & ~this.slave.imr);
      if (slaveIrq >= 0) {
        this.slave.irr &= ~(1 << slaveIrq);
        if (!this.slave.autoEoi) this.slave.isr |= 1 << slaveIrq;
        this.master.irr &= ~(1 << 2);
        if (!this.master.autoEoi) this.master.isr |= 1 << 2;
        return { irq: slaveIrq + 8, vector: this.slave.vectorBase + slaveIrq };
      }
    }
    this.master.irr &= ~(1 << masterIrq);
    if (!this.master.autoEoi) this.master.isr |= 1 << masterIrq;
    return { irq: masterIrq, vector: this.master.vectorBase + masterIrq };
  }

  endOfInterrupt(irq = null) {
    if (irq === null) {
      const m = this.#highest(this.master.isr);
      if (m >= 0) this.master.isr &= ~(1 << m);
      const s = this.#highest(this.slave.isr);
      if (s >= 0) this.slave.isr &= ~(1 << s);
      return;
    }
    if (!Number.isInteger(irq) || irq < 0 || irq > 15) throw new RangeError("IRQ must be 0..15");
    if (irq < 8) this.master.isr &= ~(1 << irq);
    else {
      this.slave.isr &= ~(1 << (irq - 8));
      this.master.isr &= ~(1 << 2);
    }
  }

  snapshot() {
    return structuredClone({ format: "nexara-pic8259-v1", master: this.master, slave: this.slave });
  }

  restore(state) {
    if (!state || state.format !== "nexara-pic8259-v1") throw new TypeError("Invalid PIC snapshot");
    const valid = c => c && ["irr","isr","imr","vectorBase","initStep"].every(k => Number.isInteger(c[k]))
      && c.irr >= 0 && c.irr <= 255 && c.isr >= 0 && c.isr <= 255 && c.imr >= 0 && c.imr <= 255
      && c.vectorBase >= 0 && c.vectorBase <= 248 && c.vectorBase % 8 === 0 && c.initStep >= 0 && c.initStep <= 4
      && ["expectIcw4","readIsr","autoEoi"].every(k => typeof c[k] === "boolean");
    if (!valid(state.master) || !valid(state.slave)) throw new TypeError("Invalid PIC snapshot");
    this.master = structuredClone(state.master);
    this.slave = structuredClone(state.slave);
  }
}

export class Pit8253 {
  constructor({ inputHz = 1193182 } = {}) {
    if (!Number.isInteger(inputHz) || inputHz <= 0) throw new RangeError("Invalid PIT input frequency");
    this.inputHz = inputHz;
    this.reload = 65536;
    this.counter = 65536;
    this.mode = 3;
    this.access = 3;
    this.lowByte = null;
    this.output = false;
    this.elapsedTicks = 0n;
    this.pendingIrq = false;
  }

  writeControl(value) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError("PIT control must be a byte");
    const channel = value >> 6;
    if (channel !== 0) return;
    this.access = (value >> 4) & 3;
    if (this.access === 0) return;
    this.mode = (value >> 1) & 7;
    if (this.mode >= 6) this.mode -= 4;
    if (![2,3].includes(this.mode)) throw new Error("PIT model supports channel-0 modes 2 and 3");
    this.lowByte = null;
  }

  writeCounter0(value) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError("PIT data must be a byte");
    if (this.access === 1) this.#load(value);
    else if (this.access === 2) this.#load(value << 8);
    else if (this.lowByte === null) this.lowByte = value;
    else {
      this.#load(this.lowByte | (value << 8));
      this.lowByte = null;
    }
  }

  #load(value) {
    this.reload = value === 0 ? 65536 : value;
    this.counter = this.reload;
    this.output = false;
    this.elapsedTicks = 0n;
  }

  tick(ticks = 1) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new RangeError("Invalid PIT tick count");
    let pulses = 0;
    for (let i = 0; i < ticks; i++) {
      this.elapsedTicks++;
      if (this.counter > 1) this.counter--;
      else {
        this.counter = this.reload;
        this.output = !this.output;
        if (this.mode === 2 || this.output) {
          pulses++;
          this.pendingIrq = true;
        }
      }
    }
    return pulses;
  }

  consumeIrq() {
    const pending = this.pendingIrq;
    this.pendingIrq = false;
    return pending;
  }

  snapshot() {
    return Object.freeze({ format: "nexara-pit8253-v1", inputHz: this.inputHz, reload: this.reload,
      counter: this.counter, mode: this.mode, access: this.access, lowByte: this.lowByte,
      output: this.output, elapsedTicks: this.elapsedTicks.toString(), pendingIrq: this.pendingIrq });
  }

  restore(s) {
    if (!s || s.format !== "nexara-pit8253-v1" || s.inputHz !== this.inputHz
      || !Number.isInteger(s.reload) || s.reload < 1 || s.reload > 65536
      || !Number.isInteger(s.counter) || s.counter < 1 || s.counter > 65536
      || ![2,3].includes(s.mode) || ![1,2,3].includes(s.access)
      || !(s.lowByte === null || (Number.isInteger(s.lowByte) && s.lowByte >= 0 && s.lowByte <= 255))
      || typeof s.output !== "boolean" || typeof s.pendingIrq !== "boolean"
      || typeof s.elapsedTicks !== "string" || !/^\d+$/.test(s.elapsedTicks)) throw new TypeError("Invalid PIT snapshot");
    this.reload = s.reload; this.counter = s.counter; this.mode = s.mode; this.access = s.access;
    this.lowByte = s.lowByte; this.output = s.output; this.pendingIrq = s.pendingIrq;
    this.elapsedTicks = BigInt(s.elapsedTicks);
  }
}


/**
 * Minimal PC/AT I/O-port and timer-to-PIC wiring.
 * The caller advances virtual PIT ticks and asks this fabric to queue one
 * acknowledged PIC vector on a CPU implementing requestInterrupt(vector).
 */
export class PcAtInterruptFabric {
  constructor({ pic = new Pic8259(), pit = new Pit8253(), ata = null } = {}) {
    if (!(pic instanceof Pic8259) || !(pit instanceof Pit8253)
      || (ata !== null && !(ata instanceof AtaPioDevice))) throw new TypeError("Invalid PC interrupt or storage devices");
    this.pic = pic;
    this.pit = pit;
    this.ata = ata;
  }

  read(port, width = 8) {
    return this.ioRead(port, width);
  }

  write(port, value, width = 8) {
    const numeric = Number(value);
    const maximum = width === 16 ? 0xffff : width === 8 ? 0xff : -1;
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > maximum) throw new RangeError("I/O value does not fit access width");
    return this.ioWrite(port, numeric, width);
  }

  ioWrite(port, value, width = 8) {
    if (!Number.isInteger(port) || port < 0 || port > 0xffff) throw new RangeError("Invalid I/O port");
    if (port >= 0x1f0 && port <= 0x1f7 && this.ata) return this.ata.write(port, value, width);
    if (width !== 8) throw new RangeError("PC/AT PIC and PIT ports support byte reads only");
    if (port === 0x20 || port === 0x21 || port === 0xa0 || port === 0xa1) return this.pic.write(port, value);
    if (port === 0x40) return this.pit.writeCounter0(value);
    if (port === 0x43) return this.pit.writeControl(value);
    throw new RangeError("Unmapped PC I/O port");
  }

  ioRead(port, width = 8) {
    if (port >= 0x1f0 && port <= 0x1f7 && this.ata) return this.ata.read(port, width);
    if (width !== 8) throw new RangeError("PC/AT PIC and PIT ports support byte accesses only");
    if (port === 0x20 || port === 0x21 || port === 0xa0 || port === 0xa1) return this.pic.read(port);
    throw new RangeError("Unmapped or unsupported PC I/O port");
  }

  advanceTicks(ticks) {
    const pulses = this.pit.tick(ticks);
    if (this.pit.consumeIrq()) this.pic.raise(0);
    return pulses;
  }

  dispatchOne(cpu) {
    if (!cpu || typeof cpu.requestInterrupt !== "function") throw new TypeError("CPU must implement requestInterrupt(vector)");
    const next = this.pic.acknowledge();
    if (!next) return null;
    try {
      cpu.requestInterrupt(next.vector);
    } catch (error) {
      // Preserve the acknowledged interrupt if the CPU cannot accept it.
      this.pic.raise(next.irq);
      this.pic.endOfInterrupt(next.irq);
      throw error;
    }
    return next;
  }

  snapshot() {
    return Object.freeze({
      format: "nexara-pcat-fabric-v1",
      pic: this.pic.snapshot(),
      pit: this.pit.snapshot(),
      ata: this.ata?.snapshot() ?? null
    });
  }

  restore(state) {
    if (!state || state.format !== "nexara-pcat-fabric-v1"
      || (this.ata && !state.ata) || (!this.ata && state.ata != null)) {
      throw new TypeError("Invalid PC fabric snapshot or device configuration mismatch");
    }
    this.pic.restore(state.pic);
    this.pit.restore(state.pit);
    if (this.ata) this.ata.restore(state.ata);
    return this.snapshot();
  }
}
