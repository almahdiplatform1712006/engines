// Where a webhook may go. Engines runs next to Google's metadata server and
// other private addresses; a customer's URL must never reach them (SSRF).
//
// The check runs on the address the connection actually uses (`pinnedLookup`
// is handed to the HTTP client), so a host that resolves to a public address
// for the check and a private one for the request (DNS rebinding) is refused.
import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Refusal } from "../shared/refusal.ts";

export interface TargetPolicy {
  /** Local development and tests only: allow http and private addresses. */
  allowPrivate: boolean;
}

export function checkWebhookUrl(raw: string, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refusal("invalid_request", "webhook_url is not a URL.");
  }
  if (
    url.protocol !== "https:" &&
    !(policy.allowPrivate && url.protocol === "http:")
  ) {
    throw new Refusal(
      "invalid_request",
      "webhook_url must be an https:// URL.",
    );
  }
  if (url.username || url.password) {
    throw new Refusal(
      "invalid_request",
      "webhook_url must not carry credentials.",
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!policy.allowPrivate && isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new Refusal(
      "invalid_request",
      "webhook_url must reach a public address.",
    );
  }
  return url;
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/**
 * Private, loopback, link-local, metadata, multicast and reserved addresses,
 * in either family, including IPv4 carried inside IPv6 (mapped
 * `::ffff:a9fe:a9fe`, compatible `::a9fe:a9fe`, NAT64 `64:ff9b::…`, 6to4
 * `2002:…`).
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  if (blocked.check(address, "ipv6")) return true;
  const embedded = embeddedIPv4(address);
  return embedded !== null && blocked.check(embedded, "ipv4");
}

function embeddedIPv4(address: string): string | null {
  const groups = expandIPv6(address);
  if (!groups) return null;
  const v4 = (hi: number, lo: number) =>
    [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].map(String).join(".");
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] =
    groups;
  const zeros = (...gs: number[]) => gs.every((g) => g === 0);
  if (zeros(g0, g1, g2, g3, g4) && (g5 === 0xffff || g5 === 0))
    return v4(g6, g7); // mapped, compatible
  if (g0 === 0x64 && g1 === 0xff9b && zeros(g2, g3, g4, g5)) return v4(g6, g7); // NAT64
  if (g0 === 0x2002) return v4(g1, g2); // 6to4
  return null;
}

function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split(".").map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [
    ...left,
    ...Array<string>(Math.max(0, fill)).fill("0"),
    ...right,
  ].map((g) => parseInt(g, 16));
  return groups.length === 8 &&
    groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/**
 * A DNS lookup for the HTTP client that refuses private addresses, so the
 * address that was checked is the address that is connected to.
 */
export function pinnedLookup(policy: TargetPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(
      hostname,
      { ...options, all: false },
      (error, address, family) => {
        if (error) {
          callback(error, "", 0);
          return;
        }
        if (!policy.allowPrivate && isPrivateAddress(address)) {
          callback(
            new Error(`webhook host ${hostname} resolves to a private address`),
            "",
            0,
          );
          return;
        }
        callback(null, address, family);
      },
    );
  };
}
