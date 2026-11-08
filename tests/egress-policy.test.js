import test from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, resolveAuthorizedEgress } from "../packages/security/src/egress-policy.js";

test("public-address classifier rejects private, local, reserved and documentation IPv4", () => {
  for (const address of ["0.0.0.0","10.1.2.3","100.64.0.1","127.0.0.1","169.254.1.1",
    "172.16.0.1","192.0.2.10","192.168.1.1","198.18.0.1","198.51.100.1",
    "203.0.113.1","224.0.0.1","255.255.255.255"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1","8.8.8.8","93.184.216.34"]) assert.equal(isPublicAddress(address), true, address);
});

test("public-address classifier rejects special IPv6 and mapped private IPv4", () => {
  for (const address of ["::","::1","fc00::1","fd12::1","fe80::1","ff02::1",
    "::ffff:192.168.1.1","2001:db8::1","2001:0002::1","2002::1","2001:0000::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("egress resolver rejects mixed public and private DNS answers", async () => {
  const broker = { authorizeNetwork: () => ({ hostname: "example.com", port: 443, protocol: "https:", url: "https://example.com/" }) };
  await assert.rejects(() => resolveAuthorizedEgress(broker, "https://example.com", {
    resolver: async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]
  }), /non-public/);
});

test("egress resolver pins vetted addresses and rejects hostname reuse", async () => {
  const broker = { authorizeNetwork: () => ({ hostname: "example.com", port: 443, protocol: "https:", url: "https://example.com/" }) };
  const result = await resolveAuthorizedEgress(broker, "https://example.com", {
    resolver: async (hostname, options) => {
      assert.equal(hostname, "example.com");
      assert.equal(options.all, true);
      return [{ address: "93.184.216.34" }, { address: "2606:4700:4700::1111" }];
    }
  });
  assert.equal(result.addresses.length, 2);
  result.lookup("example.com", {}, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, "93.184.216.34");
    assert.equal(family, 4);
  });
  result.lookup("other.example", {}, error => assert.match(error.message, /another hostname/));
});
