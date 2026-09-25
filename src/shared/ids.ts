import { randomBytes } from "node:crypto";

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A random id with a readable prefix, such as `doc_4fT9x2QmZbLk8wPe`. */
export function newId(prefix: string, length = 16): string {
  const bytes = randomBytes(length);
  let id = "";
  for (const byte of bytes) id += ALPHABET.charAt(byte % ALPHABET.length);
  return `${prefix}_${id}`;
}
