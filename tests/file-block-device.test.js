import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileBlockDevice } from "../packages/runtime/src/index.js";

test("file block devices persist bounded sector writes across reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-disk-"));
  const id = "12345678-1234-4234-8234-123456789abc";
  try {
    const disk = await FileBlockDevice.open({ directory, vmId: id, sectors: 8 });
    await disk.writeSectors(3, new Uint8Array(512).fill(0x6b));
    await disk.sync();
    await disk.close();
    const reopened = await FileBlockDevice.open({ directory, vmId: id, sectors: 8, create: false });
    assert.equal((await reopened.readSectors(3))[0], 0x6b);
    await assert.rejects(() => reopened.readSectors(8), /outside/);
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file block devices enforce read-only mode and geometry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-disk-"));
  const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  try {
    const disk = await FileBlockDevice.open({ directory, vmId: id, sectors: 4 });
    await disk.close();
    const readOnly = await FileBlockDevice.open({ directory, vmId: id, sectors: 4, readOnly: true });
    await assert.rejects(() => readOnly.writeSectors(0, new Uint8Array(512)), /read-only/);
    await readOnly.close();
    await assert.rejects(() => FileBlockDevice.open({ directory, vmId: id, sectors: 8, create: false }), /geometry/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file block devices reject unsafe identifiers and missing images", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexara-disk-"));
  try {
    await assert.rejects(() => FileBlockDevice.open({ directory, vmId: "../escape", sectors: 2 }), /identifier/);
    await assert.rejects(() => FileBlockDevice.open({ directory, vmId: "12345678-1234-4234-8234-123456789abc", sectors: 2, readOnly: true }), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
