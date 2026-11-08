/**
 * Validates and stages a legacy BIOS boot sector in guest memory.
 *
 * This models the disk-to-0x7c00 handoff only. It does not emulate BIOS
 * interrupts, a 16-bit CPU execution mode, POST, or firmware device services.
 */
import { MemoryBlockDevice, BLOCK_SECTOR_SIZE } from "./block-device.js";
import { GuestMemory } from "./index.js";

export const LEGACY_BOOT_ADDRESS = 0x7c00;
export const LEGACY_BOOT_SIGNATURE = 0xaa55;

export class LegacyBootSectorLoader {
  constructor({ disk, memory } = {}) {
    if (!(disk instanceof MemoryBlockDevice)) throw new TypeError("Legacy boot loader requires a MemoryBlockDevice");
    if (!(memory instanceof GuestMemory)) throw new TypeError("Legacy boot loader requires GuestMemory");
    this.disk = disk;
    this.memory = memory;
  }

  prepare({ lba = 0, drive = 0x80 } = {}) {
    if (!Number.isSafeInteger(lba) || lba < 0 || lba >= this.disk.sectors) {
      throw new RangeError("Boot-sector LBA is outside the disk");
    }
    if (!Number.isInteger(drive) || drive < 0 || drive > 0xff) {
      throw new RangeError("BIOS drive number must fit in one byte");
    }
    if (this.memory.byteLength < LEGACY_BOOT_ADDRESS + BLOCK_SECTOR_SIZE) {
      throw new RangeError("Guest memory must include the complete 0x7c00 boot-sector window");
    }

    const sector = this.disk.readSectors(lba);
    const signature = sector[510] | (sector[511] << 8);
    if (signature !== LEGACY_BOOT_SIGNATURE) {
      throw new Error("Disk sector does not contain the 0x55AA legacy boot signature");
    }

    // GuestMemory.write is bounds-checked and copies the complete sector.
    this.memory.write(LEGACY_BOOT_ADDRESS, sector);
    return Object.freeze({
      architecture: "x86-real-mode-handoff",
      drive,
      bootLba: lba,
      loadAddress: LEGACY_BOOT_ADDRESS,
      bytesLoaded: BLOCK_SECTOR_SIZE,
      cs: 0x0000,
      ip: LEGACY_BOOT_ADDRESS,
      ds: 0x0000,
      es: 0x0000,
      ss: 0x0000,
      sp: LEGACY_BOOT_ADDRESS
    });
  }
}
