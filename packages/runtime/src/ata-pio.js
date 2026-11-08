/**
 * Minimal primary-channel ATA PIO task-file device.
 * Supports IDENTIFY DEVICE and single-sector LBA28 READ/WRITE PIO commands.
 * It is a device-model foundation, not a complete ATA/ATAPI controller.
 */
import { MemoryBlockDevice, BLOCK_SECTOR_SIZE } from "./block-device.js";

const STATUS_DRDY = 0x40;
const STATUS_DRQ = 0x08;
const STATUS_ERR = 0x01;
const ERROR_ABRT = 0x04;

function identifyWords(disk) {
  const words = new Uint16Array(256);
  words[0] = 0x0040;
  words[1] = 16383;
  words[3] = 16;
  words[6] = 63;
  words[47] = 0x8001;
  words[49] = 0x0200;
  words[53] = 0x0007;
  words[60] = disk.sectors & 0xffff;
  words[61] = Math.floor(disk.sectors / 65536);
  const putString = (start, count, value) => {
    const padded = value.padEnd(count * 2, " ").slice(0, count * 2);
    for (let i = 0; i < count; i++) {
      words[start + i] = (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1);
    }
  };
  putString(10, 10, "NEXARA0000000000001");
  putString(27, 20, "NEXARA MEMORY ATA DISK");
  return words;
}

export class AtaPioDevice {
  constructor({ disk } = {}) {
    if (!(disk instanceof MemoryBlockDevice)) throw new TypeError("ATA PIO requires a MemoryBlockDevice");
    if (disk.sectors > 0x10000000) throw new RangeError("ATA LBA28 device capacity exceeded");
    this.disk = disk;
    this.features = 0;
    this.error = 0;
    this.sectorCount = 1;
    this.lbaLow = 0;
    this.lbaMid = 0;
    this.lbaHigh = 0;
    this.driveHead = 0xe0;
    this.status = STATUS_DRDY;
    this.command = 0;
    this.transfer = null;
    this.transferIndex = 0;
    this.transferKind = null;
  }

  #lba() {
    return this.lbaLow | (this.lbaMid << 8) | (this.lbaHigh << 16) | ((this.driveHead & 0x0f) << 24);
  }

  #fail() {
    this.error = ERROR_ABRT;
    this.status = STATUS_DRDY | STATUS_ERR;
    this.transfer = null;
    this.transferKind = null;
    this.transferIndex = 0;
  }

  #beginRead(words, kind) {
    this.transfer = words;
    this.transferKind = kind;
    this.transferIndex = 0;
    this.status = STATUS_DRDY | STATUS_DRQ;
  }

  #execute(command) {
    this.command = command;
    this.error = 0;
    if (command === 0xec) {
      this.sectorCount = 1;
      this.#beginRead(identifyWords(this.disk), "identify");
      return;
    }
    if (command !== 0x20 && command !== 0x30) return this.#fail();
    if (this.sectorCount !== 1 || (this.driveHead & 0x40) === 0) return this.#fail();
    const lba = this.#lba();
    try {
      if (command === 0x20) {
        const bytes = this.disk.readSectors(lba, 1);
        const words = new Uint16Array(256);
        for (let i = 0; i < 256; i++) words[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
        this.#beginRead(words, "read");
      } else {
        if (this.disk.readOnly) return this.#fail();
        this.transfer = new Uint16Array(256);
        this.transferKind = "write";
        this.transferIndex = 0;
        this.status = STATUS_DRDY | STATUS_DRQ;
      }
    } catch {
      this.#fail();
    }
  }

  read(port, width = 8) {
    if (!Number.isInteger(port) || port < 0x1f0 || port > 0x1f7) throw new RangeError("Unsupported ATA port");
    if (port === 0x1f0) {
      if (width !== 16 || !this.transfer || this.transferKind === "write" || !(this.status & STATUS_DRQ)) {
        throw new Error("ATA data register is not ready for a 16-bit read");
      }
      const value = this.transfer[this.transferIndex++];
      if (this.transferIndex === 256) {
        this.transfer = null;
        this.transferKind = null;
        this.transferIndex = 0;
        this.status = STATUS_DRDY;
      }
      return BigInt(value);
    }
    if (width !== 8) throw new RangeError("ATA task-file registers are byte-wide");
    switch (port) {
      case 0x1f1: return BigInt(this.error);
      case 0x1f2: return BigInt(this.sectorCount);
      case 0x1f3: return BigInt(this.lbaLow);
      case 0x1f4: return BigInt(this.lbaMid);
      case 0x1f5: return BigInt(this.lbaHigh);
      case 0x1f6: return BigInt(this.driveHead);
      case 0x1f7: return BigInt(this.status);
      default: return 0n;
    }
  }

  write(port, value, width = 8) {
    if (!Number.isInteger(port) || port < 0x1f0 || port > 0x1f7) throw new RangeError("Unsupported ATA port");
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > (width === 16 ? 0xffff : 0xff)) {
      throw new RangeError("ATA register value is outside access width");
    }
    if (port === 0x1f0) {
      if (width !== 16 || !this.transfer || this.transferKind !== "write" || !(this.status & STATUS_DRQ)) {
        throw new Error("ATA data register is not ready for a 16-bit write");
      }
      this.transfer[this.transferIndex++] = numeric;
      if (this.transferIndex === 256) {
        const bytes = new Uint8Array(BLOCK_SECTOR_SIZE);
        for (let i = 0; i < 256; i++) {
          bytes[i * 2] = this.transfer[i] & 0xff;
          bytes[i * 2 + 1] = this.transfer[i] >>> 8;
        }
        try {
          this.disk.writeSectors(this.#lba(), bytes);
          this.sectorCount = 0;
          this.status = STATUS_DRDY;
        } catch {
          this.#fail();
        }
        this.transfer = null;
        this.transferKind = null;
        this.transferIndex = 0;
      }
      return;
    }
    if (width !== 8) throw new RangeError("ATA task-file registers are byte-wide");
    switch (port) {
      case 0x1f1: this.features = numeric; break;
      case 0x1f2: this.sectorCount = numeric; break;
      case 0x1f3: this.lbaLow = numeric; break;
      case 0x1f4: this.lbaMid = numeric; break;
      case 0x1f5: this.lbaHigh = numeric; break;
      case 0x1f6: this.driveHead = numeric; break;
      case 0x1f7: this.#execute(numeric); break;
      default: break;
    }
  }

  snapshot() {
    return Object.freeze({
      format: "nexara-ata-pio-v1",
      features: this.features, error: this.error, sectorCount: this.sectorCount,
      lbaLow: this.lbaLow, lbaMid: this.lbaMid, lbaHigh: this.lbaHigh,
      driveHead: this.driveHead, status: this.status, command: this.command,
      transfer: this.transfer?.slice() ?? null, transferIndex: this.transferIndex,
      transferKind: this.transferKind
    });
  }
}
