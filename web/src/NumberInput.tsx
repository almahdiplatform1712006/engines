// A whole-number input for page numbers. Numbers read left to right in either
// language, and Arabic-Indic digits (٠–٩, ۰–۹) are accepted as typed.
import { useEffect, useState } from "react";
import { parsePrintedNumber, toAsciiDigits } from "../../src/shared/text.ts";

export function NumberInput(props: {
  value: number | null;
  onChange: (value: number | null) => void;
  label: string;
  id?: string;
  invalid?: boolean;
}) {
  const [text, setText] = useState(
    props.value === null ? "" : String(props.value),
  );
  // Follows the value when it changes from outside (a reset, another field).
  useEffect(() => {
    setText((current) =>
      parsePrintedNumber(current) === props.value
        ? current
        : props.value === null
          ? ""
          : String(props.value),
    );
  }, [props.value]);
  return (
    <input
      id={props.id}
      className="number"
      dir="ltr"
      inputMode="numeric"
      autoComplete="off"
      aria-label={props.label}
      aria-invalid={props.invalid ?? false}
      value={text}
      onChange={(e) => {
        const typed = toAsciiDigits(e.target.value).replace(/\D+/g, "");
        setText(typed);
        props.onChange(parsePrintedNumber(typed));
      }}
    />
  );
}
