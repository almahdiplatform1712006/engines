import assert from "node:assert/strict";
import { test } from "node:test";
import { Document, Packer, Paragraph, Math as WordMath } from "docx";
import { zipText } from "../../test/zip.ts";
import { splitMath } from "../shared/latex.ts";
import { toMathML, toWordMath } from "./math.ts";

test("text and math spans come apart in order", () => {
  assert.deepEqual(splitMath("القوة $F = ma$ ثم $$a=\\frac{F}{m}$$."), [
    { kind: "text", text: "القوة " },
    { kind: "math", tex: "F = ma", display: false },
    { kind: "text", text: " ثم " },
    { kind: "math", tex: "a=\\frac{F}{m}", display: true },
    { kind: "text", text: "." },
  ]);
});

test("LaTeX becomes MathML, right-to-left where the book writes it so", () => {
  assert.match(
    toMathML("\\frac{1}{2}", { display: false, rtl: false }),
    /^<math><mfrac>/,
  );
  assert.match(
    toMathML("س + ص", { display: false, rtl: true }),
    /^<math dir="rtl"/,
  );
  assert.match(toMathML("\\frac{", { display: false, rtl: false }), /<code/);
});

test("LaTeX becomes a Word equation", async () => {
  const parts = toWordMath("v = \\sqrt{2gh} + x^{2}_{i}");
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new WordMath({ children: parts })] }),
        ],
      },
    ],
  });
  const xml = zipText(await Packer.toBuffer(doc), "word/document.xml");
  assert.match(xml, /<m:rad>/);
  assert.match(xml, /<m:sSubSup>/);
});
