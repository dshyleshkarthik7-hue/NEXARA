import { MemoryBlockDevice, BLOCK_SECTOR_SIZE } from "../../runtime/src/block-device.js";

/**
 * Host-trapped subset of legacy BIOS services for real-mode boot experiments.
 * This is not a BIOS ROM, POST implementation, or PC firmware image.
 */
export class LegacyBios {
  constructor({ disk, drive = 0x80, heads = 16, sectorsPerTrack = 63, output = () => {} } = {}) {
    if (!(disk instanceof MemoryBlockDevice)) throw new TypeError("Legacy BIOS requires a MemoryBlockDevice");
    if (!Number.isInteger(drive) || drive < 0x80 || drive > 0xff) throw new RangeError("BIOS hard-disk drive number must be 0x80..0xff");
    if (!Number.isInteger(heads) || heads < 1 || heads > 256) throw new RangeError("BIOS geometry heads must be 1..256");
    if (!Number.isInteger(sectorsPerTrack) || sectorsPerTrack < 1 || sectorsPerTrack > 63) throw new RangeError("BIOS sectors per track must be 1..63");
    if (typeof output !== "function") throw new TypeError("BIOS output must be a function");
    this.disk = disk;
    this.drive = drive;
    this.heads = heads;
    this.sectorsPerTrack = sectorsPerTrack;
    this.output = output;
  }

  #status(cpu, status, count = 0) {
    cpu.ax = ((status & 0xff) << 8) | (status === 0 ? count & 0xff : 0);
    if (status === 0) cpu.flags &= ~1;
    else cpu.flags |= 1;
  }

  #diskInterrupt(cpu) {
    const functionCode = (cpu.ax >>> 8) & 0xff;
    const requestedDrive = cpu.dx & 0xff;
    if (functionCode === 0x00) {
      this.#status(cpu, requestedDrive === this.drive ? 0 : 1);
      return true;
    }
    if (functionCode === 0x08) {
      if (requestedDrive !== this.drive) {
        this.#status(cpu, 1);
        return true;
      }
      const cylinder = Math.min(1023, Math.floor((this.disk.sectors - 1) / (this.heads * this.sectorsPerTrack)));
      const encodedCylinder = ((cylinder & 0xff) << 8) | (this.sectorsPerTrack & 0x3f) | ((cylinder >>> 2) & 0xc0);
      cpu.ax = 1; // AH=0, AL=one installed fixed disk
      cpu.cx = encodedCylinder;
      cpu.dx = ((this.heads - 1) << 8) | this.drive;
      cpu.flags &= ~1;
      return true;
    }
    if (functionCode !== 0x02) {
      this.#status(cpu, 1);
      return true;
    }

    const count = cpu.ax & 0xff;
    const sector = cpu.cx & 0x3f;
    const cylinder = ((cpu.cx >>> 8) & 0xff) | ((cpu.cx & 0xc0) << 2);
    const head = (cpu.dx >>> 8) & 0xff;
    if (requestedDrive !== this.drive) return this.#status(cpu, 1), true;
    if (count < 1 || count > 128 || sector < 1 || sector > this.sectorsPerTrack
      || count > this.sectorsPerTrack - sector + 1 || head >= this.heads || cylinder > 1023) {
      this.#status(cpu, 4);
      return true;
    }
    const offset = cpu.bx & 0xffff;
    if (offset + count * BLOCK_SECTOR_SIZE > 0x10000) {
      this.#status(cpu, 9);
      return true;
    }
    const lba = (cylinder * this.heads + head) * this.sectorsPerTrack + sector - 1;
    let bytes;
    try {
      bytes = this.disk.readSectors(lba, count);
    } catch {
      this.#status(cpu, 4);
      return true;
    }

    const base = ((cpu.es & 0xffff) << 4) + offset;
    const addresses = new Uint32Array(bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i++) {
      const address = cpu.a20Enabled ? base + i : ((base + i) & 0xfffff);
      if (address >= cpu.memory.byteLength) {
        this.#status(cpu, 9);
        return true;
      }
      addresses[i] = address;
    }
    for (let i = 0; i < bytes.byteLength; i++) {
      cpu.memory.write(addresses[i], bytes.subarray(i, i + 1));
    }
    this.#status(cpu, 0, count);
    return true;
  }

  /** Return true when this BIOS subset handled the interrupt vector. */
  handleInterrupt(cpu, vector) {
    if (!cpu || !Number.isInteger(cpu.ax) || !Number.isInteger(cpu.flags)) {
      throw new TypeError("Legacy BIOS interrupt requires a real-mode CPU");
    }
    if (vector === 0x13) return this.#diskInterrupt(cpu);
    if (vector === 0x10) {
      const functionCode = (cpu.ax >>> 8) & 0xff;
      if (functionCode === 0x0e) {
        this.output(String.fromCharCode(cpu.ax & 0xff), {
          page: (cpu.bx >>> 8) & 0xff,
          attribute: cpu.bx & 0xff
        });
        return true;
      }
      cpu.ax = (0x86 << 8) | (cpu.ax & 0xff);
      return true;
    }
    return false;
  }
}
