// Verifying an Engines webhook delivery (docs/webhooks.md): the
// `Engines-Signature` header is `t=<unix seconds>,v1=<hex HMAC-SHA256 of
// "<t>.<raw body>">` under the organisation's webhook secret. Web Crypto, so
// it runs in Node, browsers and workers alike.

export const SIGNATURE_HEADER = "engines-signature";
/** Deliveries older than this are refused, against replays. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyOptions {
  /** From `GET /v1/webhook_secret`. */
  secret: string;
  /** The `Engines-Signature` header as received. */
  header: string | null | undefined;
  /** The raw request body, before parsing it. */
  body: string;
  toleranceSeconds?: number;
  now?: Date;
}

/** Whether a delivery is genuine and recent. */
export async function verifyWebhook(options: VerifyOptions): Promise<boolean> {
  const parts = new Map(
    (options.header ?? "").split(",").map((part) => {
      const [key = "", ...value] = part.trim().split("=");
      return [key, value.join("=")] as const;
    }),
  );
  const raw = parts.get("t") ?? "";
  const timestamp = Number(raw);
  const given = parts.get("v1") ?? "";
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(given))
    return false;
  const age = (options.now ?? new Date()).getTime() / 1000 - timestamp;
  if (Math.abs(age) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS))
    return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = new Uint8Array(
    given.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? [],
  );
  // `verify` compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    // Signed exactly as sent: the timestamp's own digits, then the raw body.
    encoder.encode(`${raw}.${options.body}`),
  );
}
