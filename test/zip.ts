// Reads one file out of a .docx or .xlsx (both are zip packages) in tests.
import { strFromU8, unzipSync } from "fflate";

export function zipText(zip: Uint8Array, path: string): string {
  const file = unzipSync(zip, { filter: (f) => f.name === path })[path];
  if (!file) throw new Error(`${path} is not in the package`);
  return strFromU8(file);
}

export function zipNames(zip: Uint8Array): string[] {
  return Object.keys(unzipSync(zip));
}
