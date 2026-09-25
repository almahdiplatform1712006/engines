// Text with its math rendered (Temml → MathML), the same way the exports
// render it. The HTML is built from escaped text and Temml's MathML only.
import { inline, markdown } from "../../src/shared/rich-text.ts";

export function RichText(props: {
  text: string;
  rtlMath?: boolean;
  block?: boolean;
}) {
  const rtl = props.rtlMath ?? false;
  return props.block ? (
    <div
      className="rich"
      dangerouslySetInnerHTML={{ __html: markdown(props.text, rtl) }}
    />
  ) : (
    <span
      className="rich"
      dangerouslySetInnerHTML={{ __html: inline(props.text, rtl) }}
    />
  );
}
