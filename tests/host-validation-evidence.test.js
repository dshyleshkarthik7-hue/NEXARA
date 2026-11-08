import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const scripts = [
  "scripts/host-validation.sh",
  "scripts/verify-jailed-process.sh",
  "scripts/verify-two-boot-guest-evidence.sh",
  "scripts/collect-host-validation-evidence.sh",
  "scripts/build-firecracker-guest-initramfs.sh",
  "scripts/build-firecracker-test-disk.sh",
  "scripts/build-firecracker-kernel.sh",
  "scripts/build-host-binaries.sh",
  "scripts/verify-host-bundle.sh",
  "scripts/run-firecracker-two-boot.sh"
];

test("all Linux host validation scripts pass bash syntax checking", () => {
  for (const script of scripts) {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, script + ": " + result.stderr);
  }
});

test("two-boot evidence verifier accepts two-boot guest persistence evidence", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-host-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, "first.log");
  const second = path.join(root, "second.log");
  await writeFile(first, [
    "NEXARA_GUEST_BOOT_OK",
    "NEXARA_DISK_WRITE_OK",
    "NEXARA_GUEST_VALIDATION_COMPLETE"
  ].join("\n"));
  await writeFile(second, [
    "NEXARA_GUEST_BOOT_OK",
    "NEXARA_DISK_PERSISTENCE_PRESENT",
    "NEXARA_GUEST_VALIDATION_COMPLETE"
  ].join("\n"));
  const result = spawnSync("bash", [
    "scripts/verify-two-boot-guest-evidence.sh", first, second, "14", "18"
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /second boot found the same marker/);
});

test("two-boot evidence verifier rejects missing persistence and unchanged firewall counter", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexara-host-evidence-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, "first.log");
  const second = path.join(root, "second.log");
  await writeFile(first, "NEXARA_GUEST_BOOT_OK\nNEXARA_DISK_WRITE_OK\nNEXARA_GUEST_VALIDATION_COMPLETE\n");
  await writeFile(second, "NEXARA_GUEST_BOOT_OK\nNEXARA_GUEST_VALIDATION_COMPLETE\n");
  const missingMarker = spawnSync("bash", [
    "scripts/verify-two-boot-guest-evidence.sh", first, second, "14", "18"
  ], { encoding: "utf8" });
  assert.notEqual(missingMarker.status, 0);
  await writeFile(second, "NEXARA_GUEST_BOOT_OK\nNEXARA_DISK_PERSISTENCE_PRESENT\nNEXARA_GUEST_VALIDATION_COMPLETE\n");
  const unchangedCounter = spawnSync("bash", [
    "scripts/verify-two-boot-guest-evidence.sh", first, second, "14", "14"
  ], { encoding: "utf8" });
  assert.notEqual(unchangedCounter.status, 0);
});
