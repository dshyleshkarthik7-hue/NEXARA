import test from "node:test";
import assert from "node:assert/strict";
import { VmLeaseAuthority } from "../packages/security/src/lease.js";

const secret = "nexara-test-signing-secret-at-least-32-bytes";
const digest = `sha256:${"a".repeat(64)}`;

test("issues and verifies an expiring, image-bound VM capability lease", () => {
  const authority = new VmLeaseAuthority(secret);
  const envelope = authority.issue({
    subject: "tenant-a", imageDigest: digest,
    capabilities: ["serial", "storage-read"],
    quotas: { cpuMillis: 2000, memoryMiB: 1024, diskMiB: 2048 },
    egress: ["packages.example.org"]
  }, { now: 1_000_000 });
  const lease = authority.verify(envelope, { now: 1_000_100, subject: "tenant-a", imageDigest: digest });
  assert.equal(lease.quotas.memoryMiB, 1024);
  assert.deepEqual(lease.capabilities, ["serial", "storage-read"]);
  assert.equal(VmLeaseAuthority.assertCapability(lease, "serial"), true);
  assert.throws(() => VmLeaseAuthority.assertCapability(lease, "clipboard"), /not granted/);
});

test("rejects altered payloads, expired leases, wrong tenants and wrong images", () => {
  const authority = new VmLeaseAuthority(secret);
  const envelope = authority.issue({ subject: "tenant-a", imageDigest: digest }, { now: 10_000 });
  assert.throws(() => authority.verify({ ...envelope, payload: { ...envelope.payload, subject: "tenant-b" } }, { now: 10_100 }), /signature/);
  assert.throws(() => authority.verify(envelope, { now: 1_000_000 }), /expired/);
  assert.throws(() => authority.verify(envelope, { now: 10_100, subject: "tenant-b" }), /subject mismatch/);
  assert.throws(() => authority.verify(envelope, { now: 10_100, imageDigest: `sha256:${"b".repeat(64)}` }), /image digest mismatch/);
});

test("rejects unsafe quotas, wildcard egress, unknown capabilities and weak secrets", () => {
  assert.throws(() => new VmLeaseAuthority("short"), /32 bytes/);
  const authority = new VmLeaseAuthority(secret);
  assert.throws(() => authority.issue({ subject: "tenant", imageDigest: digest, quotas: { memoryMiB: 999999 } }), /quotas/);
  assert.throws(() => authority.issue({ subject: "tenant", imageDigest: digest, egress: ["*"] }), /Egress/);
  assert.throws(() => authority.issue({ subject: "tenant", imageDigest: digest, capabilities: ["host-root"] }), /Unknown/);
});

test("lease payload and returned verified state cannot be mutated", () => {
  const authority = new VmLeaseAuthority(secret);
  const envelope = authority.issue({ subject: "tenant", imageDigest: digest });
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.payload.quotas), true);
  const lease = authority.verify(envelope);
  assert.equal(Object.isFrozen(lease.capabilities), true);
});
