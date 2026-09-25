// Where a webhook may go. Engines runs next to Google's metadata server and
// other private addresses; a customer's URL must never reach them (SSRF).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Refusal } from "../shared/refusal.ts";

export interface TargetPolicy {
  /** Local development and tests only: allow http and private addresses. */
  allowPrivate: boolean;
}

export function checkWebhookUrl(raw: string, policy: TargetPolicy): URL {
  const url = new URL(raw);
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
  return url;
}

/** Resolves the host and refuses private, loopback, link-local and metadata addresses. */
export async function assertPublicTarget(
  url: URL,
  policy: TargetPolicy,
): Promise<void> {
  if (policy.allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((a) => a.address);
  for (const address of addresses) {
    if (isPrivateAddress(address))
      throw new Error(`webhook host ${host} resolves to a private address`);
  }
}

export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return (
      a === "::1" ||
      a === "::" ||
      a.startsWith("fc") ||
      a.startsWith("fd") ||
      a.startsWith("fe8") ||
      a.startsWith("fe9") ||
      a.startsWith("fea") ||
      a.startsWith("feb")
    );
  }
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}
