import { isIP } from "node:net";
import { lookup as systemLookup } from "node:dns/promises";

function ipv4Number(address) {
  return address.split(".").reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

function inV4(address, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function isPublicIPv4(address) {
  const blocked = [
    ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],
    ["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],
    ["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],
    ["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]
  ];
  return !blocked.some(([base,bits]) => inV4(address,base,bits));
}

function isPublicIPv6(address) {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")
    || /^fe[89ab]/.test(value) || value.startsWith("ff")) return false;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIPv4(mapped[1]);
  return value.includes(":");
}

export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPublicIPv4(address);
  if (version === 6) return isPublicIPv6(address);
  return false;
}

/**
 * Resolve a broker-authorized egress URL and pin its vetted DNS answers.
 * Pass the returned lookup callback to node:http(s).request; do not perform a
 * second independent DNS lookup. Redirects must be re-authorized separately.
 */
export async function resolveAuthorizedEgress(broker, target, { resolver = systemLookup } = {}) {
  if (!broker || typeof broker.authorizeNetwork !== "function" || typeof resolver !== "function") {
    throw new TypeError("A capability broker and DNS resolver are required");
  }
  const authorized = broker.authorizeNetwork(target);
  const records = await resolver(authorized.hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0
    || records.some(record => !record || !isPublicAddress(record.address))) {
    throw new Error("Egress hostname resolved to a non-public or invalid address");
  }
  const pinned = Object.freeze(records.map(record => Object.freeze({
    address: record.address, family: isIP(record.address)
  })));
  let next = 0;
  const lookup = (hostname, options, callback) => {
    if (hostname.toLowerCase() !== authorized.hostname) {
      callback(new Error("Pinned egress lookup cannot be reused for another hostname"));
      return;
    }
    const opts = typeof options === "function" ? {} : options ?? {};
    const cb = typeof options === "function" ? options : callback;
    if (opts.all) {
      cb(null, pinned.map(item => ({ ...item })));
      return;
    }
    const selected = pinned[next++ % pinned.length];
    cb(null, selected.address, selected.family);
  };
  return Object.freeze({
    ...authorized,
    addresses: pinned,
    lookup
  });
}
