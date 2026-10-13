import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

const isPrivate = (address: string) => {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  return v4
    ? blocked.check(v4, "ipv4")
    : blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
};

/**
 * The hub's outgoing fetch: it reaches addresses agents give it, so it refuses private,
 * loopback, link-local and unique-local ones. Workers can't reach those anyway.
 */
export const publicFetch: typeof fetch = async (input, init) => {
  const { hostname } = new URL(input instanceof Request ? input.url : input);
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((found) => found.address);
  if (addresses.some(isPrivate)) throw new Error(`${hostname} is a private address`);
  return fetch(input, init);
};
