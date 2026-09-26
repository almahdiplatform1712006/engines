// Web Crypto, so the page's editor can mint node ids with the same code.
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A random id with a readable prefix, such as `doc_4fT9x2QmZbLk8wPe`. */
export function newId(prefix: string, length = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const byte of bytes) id += ALPHABET.charAt(byte % ALPHABET.length);
  return `${prefix}_${id}`;
}
