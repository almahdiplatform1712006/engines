/** A text field's value from a submitted form, trimmed unless asked not to ("" when missing). */
export function field(
  form: HTMLFormElement | FormData,
  name: string,
  trim = true,
): string {
  const data = form instanceof FormData ? form : new FormData(form);
  const value = data.get(name);
  if (typeof value !== "string") return "";
  return trim ? value.trim() : value;
}
