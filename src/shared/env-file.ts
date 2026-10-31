// Editing a .env file's text: set one `NAME=value` line.

/** Replaces the `NAME=` line (even an empty one), or adds it at the end. */
export function setLine(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(text)
    ? text.replace(pattern, () => line)
    : `${text.replace(/\n*$/, "\n")}${line}\n`;
}
