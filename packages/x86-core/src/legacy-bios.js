import { MemoryBlockDevice, BLOCK_SECTOR_SIZE } from "../../runtime/src/block-device.js";

/**
 * Host-trapped subset of legacy BIOS services for real-mode boot experiments.
 * This is not a BIOS ROM, POST implementation, or PC firmware image.
 */
export class LegacyBios {
  constructor({ disk, drive = 0x80, heads = 16, sectorsPerTrack = 63, output = () => {}, keyboard = [], ticks = 0 } = {}) {
    if (!(disk instanceof MemoryBlockDevice)) throw new TypeError("Legacy BIOS requires a MemoryBlockDevice");
    if (!Number.isInteger(drive) || drive < 0x80 || drive > 0xff) throw new RangeError("BIOS hard-disk drive number must be 0x80..0xff");
    if (!Number.isInteger(heads) || heads < 1 || heads > 256) throw new RangeError("BIOS geometry heads must be 1..256");
    if (!Number.isInteger(sectorsPerTrack) || sectorsPerTrack < 1 || sectorsPerTrack > 63) throw new RangeError("BIOS sectors per track must be 1..63");
    if (typeof output !== "function") throw new TypeError("BIOS output must be a function");
    if (!Array.isArray(keyboard) || keyboard.some(key => !Number.isInteger(key) || key < 0 || key > 0xffff)) throw new TypeError("keyboard must be an array of 16-bit BIOS key words");
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new RangeError("BIOS ticks must be a non-negative safe integer");
    this.disk = disk;
    this.drive = drive;
    this.heads = heads;
    this.sectorsPerTrack = sectorsPerTrack;
    this.output = output;
    this.keyboard = [...keyboard];
    this.ticks = ticks % 0x1800b0;
    this.midnightFlag = 0;
  }

  enqueueKey(keyWord) {
    if (!Number.isInteger(keyWord) || keyWord < 0 || keyWord > 0xffff) throw new RangeError("key word must be 16-bit unsigned");
    this.keyboard.push(keyWord);
  }

  advanceTicks(count = 1) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("tick count must be a non-negative safe integer");
    const day = 0x1800b0;
    const total = this.ticks + count;
    if (total >= day) this.midnightFlag = 1;
    this.ticks = total % day;
    return this.ticks;
  }

  #keyboardInterrupt(cpu) {
    const functionCode = (cpu.ax >>> 8) & 0xff;
    if (functionCode === 0x00 || functionCode === 0x10) {
      if (this.keyboard.length === 0) {
        // This emulator is non-blocking: ZF reports no queued key instead of stalling the host.
        cpu.flags |= 0x40;
        return true;
      }
      cpu.ax = this.keyboard.shift();
      cpu.flags &= ~0x40;
      return true;
    }
    if (functionCode === 0x01 || functionCode === 0x11) {
      if (this.keyboard.length === 0) cpu.flags |= 0x40;
      else {
        cpu.ax = this.keyboard[0];
        cpu.flags &= ~0x40;
      }
      return true;
    }
    if (functionCode === 0x02) {
      cpu.ax = (cpu.ax & 0xff00) | 0;
      return true;
    }
    cpu.flags |= 0x40;
    return true;
  }

  #clockInterrupt(cpu) {
    const functionCode = (cpu.ax >>> 8) & 0xff;
    if (functionCode !== 0x00) {
      this.#status(cpu, 0x86);
      return true;
    }
    cpu.cx = (this.ticks >>> 16) & 0xffff;
    cpu.dx = this.ticks & 0xffff;
    cpu.ax = (cpu.ax & 0xff00) | this.midnightFlag;
    this.midnightFlag = 0;
    cpu.flags &= ~1;
    return true;
  }

  #status(cpu, status, count = 0) {
    cpu.ax = ((status & 0xff) << 8) | (status === 0 ? count & 0xff : 0);
    if (status === 0) cpu.flags &= ~1;
    else cpu.flags |= 1;
  }

  #copyToGuest(cpu, segment, offset, bytes) {
    const base = ((segment & 0xffff) << 4) + (offset & 0xffff);
    const addresses = new Uint32Array(bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i++) {
      const address = cpu.a20Enabled ? base + i : ((base + i) & 0xfffff);
      if (address >= cpu.memory.byteLength) return false;
      addresses[i] = address;
    }
    for (let i = 0; i < bytes.byteLength; i++) {
      cpu.memory.write(addresses[i], bytes.subarray(i, i + 1));
    }
    return true;
  }

  #readGuest(cpu, segment, offset, length) {
    const base = ((segment & 0xffff) << 4) + (offset & 0xffff);
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const address = cpu.a20Enabled ? base + i : ((base + i) & 0xfffff);
      if (address >= cpu.memory.byteLength) return null;
      bytes[i] = cpu.memory.read(address, 1)[0];
    }
    return bytes;
  }

  #extendedRead(cpu, requestedDrive) {
    if (requestedDrive !== this.drive) {
      this.#status(cpu, 1);
      return true;
    }
    const dap = this.#readGuest(cpu, cpu.ds, cpu.si, 16);
    if (!dap || dap[0] < 0x10 || dap[1] !== 0) {
      this.#status(cpu, 1);
      return true;
    }
    const count = dap[2] | (dap[3] << 8);
    const offset = dap[4] | (dap[5] << 8);
    const segment = dap[6] | (dap[7] << 8);
    let lba = 0n;
    for (let i = 0; i < 8; i++) lba |= BigInt(dap[8 + i]) << BigInt(i * 8);
    if (count < 1 || count > 127 || offset + count * BLOCK_SECTOR_SIZE > 0x10000
      || lba > BigInt(Number.MAX_SAFE_INTEGER)) {
      this.#status(cpu, 1);
      return true;
    }
    let bytes;
    try {
      bytes = this.disk.readSectors(Number(lba), count);
    } catch {
      this.#status(cpu, 4);
      return true;
    }
    if (!this.#copyToGuest(cpu, segment, offset, bytes)) {
      this.#status(cpu, 9);
      return true;
    }
    this.#status(cpu, 0, count);
    return true;
  }

  #diskInterrupt(cpu) {
    const functionCode = (cpu.ax >>> 8) & 0xff;
    const requestedDrive = cpu.dx & 0xff;
    if (functionCode === 0x41) {
      if (requestedDrive !== this.drive || (cpu.bx & 0xffff) !== 0x55aa) {
        this.#status(cpu, 1);
      } else {
        cpu.ax = 0x3000;
        cpu.bx = 0xaa55;
        cpu.cx = 1;
        cpu.flags &= ~1;
      }
      return true;
    }
    if (functionCode === 0x42) return this.#extendedRead(cpu, requestedDrive);
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
    if (requestedDrive !== this.drive) {
      this.#status(cpu, 1);
      return true;
    }
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

    if (!this.#copyToGuest(cpu, cpu.es, offset, bytes)) {
      this.#status(cpu, 9);
      return true;
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
    if (vector === 0x16) return this.#keyboardInterrupt(cpu);
    if (vector === 0x1a) return this.#clockInterrupt(cpu);
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
