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


test("rejects malformed egress hostnames, invalid ports, and non-array policies", () => {
  const authority = new VmLeaseAuthority(secret);
  for (const egress of ["example..org", "-bad.example", "bad-.example", "example.org:0", "example.org:65536", "example.org:abc"]) {
    assert.throws(() => authority.issue({ subject: "tenant", imageDigest: digest, egress: [egress] }), /Egress/);
  }
  assert.throws(() => authority.issue({ subject: "tenant", imageDigest: digest, egress: "example.org" }), /array/);
  assert.throws(() => authority.issue({ subject: "tenant", imageDigest: digest, capabilities: "serial" }), /array/);
  assert.doesNotThrow(() => authority.issue({ subject: "tenant", imageDigest: digest, egress: ["example.org", "api.example.org:443"] }));
});

test("rejects issue-time overflow and malformed signatures", () => {
  const authority = new VmLeaseAuthority(secret);
  assert.throws(() => authority.issue({ subject: "tenant", imageDigest: digest }, { now: Number.MAX_SAFE_INTEGER - 1 }), /TTL/);
  const envelope = authority.issue({ subject: "tenant", imageDigest: digest }, { now: 1000 });
  assert.throws(() => authority.verify({ ...envelope, signature: "not-base64url" }, { now: 1100 }), /Malformed/);
  assert.throws(() => authority.verify(envelope, { now: -1 }), /Malformed/);
});


test("capability authorization verifies the signed lease before granting access", () => {
  const authority = new VmLeaseAuthority(secret);
  const envelope = authority.issue({
    subject: "tenant-a", imageDigest: digest, capabilities: ["storage-read"]
  }, { now: 20_000 });
  const lease = authority.verifyCapability(envelope, "storage-read", {
    now: 20_100, subject: "tenant-a", imageDigest: digest
  });
  assert.equal(lease.subject, "tenant-a");
  assert.throws(() => authority.verifyCapability(envelope, "storage-write", { now: 20_100 }), /not granted/);
  assert.throws(() => authority.verifyCapability(envelope, "storage-read", { now: 2_000_000 }), /expired/);
  assert.throws(() => authority.verifyCapability({
    ...envelope, payload: { ...envelope.payload, capabilities: ["storage-read", "network-egress"] }
  }, "network-egress", { now: 20_100 }), /signature/);
  assert.throws(() => authority.verifyCapability(envelope, "host-root", { now: 20_100 }), /Unknown/);
});
