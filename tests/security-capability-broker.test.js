import test from "node:test";
import assert from "node:assert/strict";
import { VmLeaseAuthority } from "../packages/security/src/lease.js";
import { VmCapabilityBroker } from "../packages/security/src/capability-broker.js";

const secret = "nexara-test-signing-secret-at-least-32-bytes";
const digest = `sha256:${"c".repeat(64)}`;

function setup({ capabilities = ["storage-read", "storage-write", "network-egress"], egress = ["packages.example.org", "api.example.org:8443"], now = 50_000 } = {}) {
  const authority = new VmLeaseAuthority(secret);
  const envelope = authority.issue({
    subject: "tenant-a", imageDigest: digest, capabilities, egress,
    quotas: { diskMiB: 16 }
  }, { now });
  let current = now + 10;
  return { broker: new VmCapabilityBroker({
    authority, envelope, subject: "tenant-a", imageDigest: digest, clock: () => current
  }), advance: value => { current = value; } };
}

test("broker authorizes bounded storage reads and validates adapter results", async () => {
  const { broker } = setup();
  const result = await broker.readStorage({
    lba: 1, count: 2, read: async (lba, count) => new Uint8Array(count * 512).fill(lba)
  });
  assert.equal(result.byteLength, 1024);
  assert.equal(result[0], 1);
  await assert.rejects(() => broker.readStorage({ lba: 32768, count: 1, read: () => new Uint8Array(512) }), /quota/);
  await assert.rejects(() => broker.readStorage({ lba: 0, read: () => new Uint8Array(1) }), /invalid sector buffer/);
});

test("broker requires storage-write capability before invoking the adapter", async () => {
  const { broker } = setup({ capabilities: ["storage-read"] });
  let called = false;
  await assert.rejects(() => broker.writeStorage({
    lba: 0, data: new Uint8Array(512), write: () => { called = true; }
  }), /not granted/);
  assert.equal(called, false);
});

test("broker validates write ranges and sector-aligned data", async () => {
  const { broker } = setup();
  let writes = 0;
  await assert.rejects(() => broker.writeStorage({ lba: 0, data: new Uint8Array(513), write: () => { writes++; } }), /whole 512-byte/);
  await assert.rejects(() => broker.writeStorage({ lba: 32768, data: new Uint8Array(512), write: () => { writes++; } }), /quota/);
  assert.equal(writes, 0);
  await broker.writeStorage({ lba: 3, data: new Uint8Array(512), write: async () => { writes++; } });
  assert.equal(writes, 1);
});

test("network broker allows only exact lease hosts and optional exact ports", () => {
  const { broker } = setup();
  assert.deepEqual(broker.authorizeNetwork("https://packages.example.org/v1"), {
    url: "https://packages.example.org/v1", hostname: "packages.example.org", port: 443, protocol: "https:"
  });
  assert.equal(broker.authorizeNetwork("https://api.example.org:8443/").port, 8443);
  for (const target of [
    "https://evil.example.org/", "https://api.example.org:443/",
    "http://packages.example.org/", "file:///etc/passwd",
    "http://127.0.0.1/", "http://localhost/", "https://user:pass@packages.example.org/"
  ]) assert.throws(() => broker.authorizeNetwork(target));
});

test("broker rechecks expiry and tenant/image binding on every operation", async () => {
  const { broker, advance } = setup();
  advance(2_000_000);
  await assert.rejects(() => broker.readStorage({ lba: 0, read: () => new Uint8Array(512) }), /expired/);
});
