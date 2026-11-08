import test from "node:test";
import assert from "node:assert/strict";
import { LinuxNetworkProvider } from "../packages/security/src/linux-network-provider.js";

test("Linux network provider creates an isolated TAP namespace with default-deny nftables", async () => {
  const calls = [];
  const provider = new LinuxNetworkProvider({
    ipPath: "/sbin/ip", nftPath: "/sbin/nft",
    run: async (command, args, input) => calls.push({ command, args, input })
  });
  const handle = await provider.provision({
    id: "12345678-1234-4234-8234-123456789abc", uid: 10001, gid: 10001
  });
  assert.equal(handle.name, "nx-1234567812");
  assert.equal(handle.tapName, "tap12345678");
  assert.equal(handle.netnsPath, "/run/netns/nx-1234567812");
  assert.deepEqual(calls[0], { command: "/sbin/ip", args: ["netns", "add", handle.name], input: undefined });
  assert.ok(calls.some(call => call.args.includes("tuntap") && call.args.includes(handle.tapName)));
  const firewall = calls.find(call => call.command === "/sbin/ip" && call.args.includes("/sbin/nft"));
  assert.match(firewall.input, /policy drop/);
  assert.match(firewall.input, /ct state established,related accept/);
  await provider.release(handle);
  assert.deepEqual(calls.at(-1).args, ["netns", "del", handle.name]);
  await provider.release(handle);
  assert.equal(calls.filter(call => call.args[0] === "netns" && call.args[1] === "del").length, 1);
});

test("Linux network provider removes a partially created namespace on setup failure", async () => {
  const calls = [];
  const provider = new LinuxNetworkProvider({
    run: async (command, args) => {
      calls.push(args);
      if (args.includes("tuntap")) throw new Error("TAP creation denied");
    }
  });
  await assert.rejects(() => provider.provision({
    id: "12345678-1234-4234-8234-123456789abc", uid: 10001, gid: 10001
  }), /TAP creation denied/);
  assert.deepEqual(calls.at(-1), ["netns", "del", "nx-1234567812"]);
});

test("Linux network provider validates identity before running host commands", async () => {
  let calls = 0;
  const provider = new LinuxNetworkProvider({ run: async () => { calls++; } });
  await assert.rejects(() => provider.provision({ id: "../escape", uid: 0, gid: 0 }), /Invalid VM identity/);
  assert.equal(calls, 0);
});
