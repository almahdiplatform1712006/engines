// Webhook signatures (E-13). Each organisation has a secret; every delivery
// carries `Engines-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>` over
// `<t>.<raw body>`. `verifyWebhook` is what a receiver runs (docs/webhooks.md);
// the typed client re-exports it (E-21).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "engines-signature";

/** Deliveries older than this are refused by `verifyWebhook`, against replays. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export function signWebhook(
  secret: string,
  body: string,
  timestamp: number,
): string {
  const mac = createHmac("sha256", secret)
    .update(`${String(timestamp)}.${body}`)
    .digest("hex");
  return `t=${String(timestamp)},v1=${mac}`;
}

/**
 * Whether a delivery is genuine: its signature matches the raw body under the
 * organisation's secret, and it isn't older than `toleranceSeconds`.
 */
export function verifyWebhook(options: {
  secret: string;
  header: string | null | undefined;
  body: string;
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  const parts = new Map(
    (options.header ?? "").split(",").map((part) => {
      const [k = "", ...v] = part.trim().split("=");
      return [k, v.join("=")] as const;
    }),
  );
  const timestamp = Number(parts.get("t"));
  const given = parts.get("v1");
  if (!Number.isInteger(timestamp) || !given) return false;
  const age = (options.now ?? new Date()).getTime() / 1000 - timestamp;
  if (Math.abs(age) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS))
    return false;
  const expected = Buffer.from(
    signWebhook(options.secret, options.body, timestamp).split("v1=")[1] ?? "",
  );
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
