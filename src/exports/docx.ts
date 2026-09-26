// The worksheet as a Word document (E-19): right-to-left paragraphs for
// Arabic, the Arabic font embedded, math as Word's own equations (so a teacher
// can edit it), figures inline, and the answer key at the end.
import { readFile } from "node:fs/promises";
import {
  AlignmentType,
  CharacterSet,
  Document,
  HeadingLevel,
  ImageRun,
  Math as WordMath,
  Packer,
  Paragraph,
  TextRun,
  type ParagraphChild,
} from "docx";
import sharp from "sharp";
import type { StoredImage } from "../assembly/result.ts";
import { splitMath } from "../shared/latex.ts";
import { toWordMath } from "./math.ts";
import type { Entry, Worksheet } from "./worksheet.ts";

const FONT = "Noto Naskh Arabic";
const FONT_URL = new URL(
  "../../assets/fonts/NotoNaskhArabic.ttf",
  import.meta.url,
);
/** Figures are scaled to at most this width, in pixels at 96 DPI (about 15 cm). */
const MAX_IMAGE_WIDTH = 560;
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
];
const ANSWERS = { ar: "مفتاح الإجابات", en: "Answer key" } as const;

export async function worksheetDocx(
  worksheet: Worksheet,
  images: ReadonlyMap<string, Buffer>,
): Promise<Buffer> {
  const rtl = worksheet.rtl;
  const paragraph = (
    children: ParagraphChild[],
    extra: Partial<ConstructorParameters<typeof Paragraph>[0] & object> = {},
  ) =>
    new Paragraph({
      children,
      bidirectional: rtl,
      alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
      ...extra,
    });
  const run = (text: string, bold = false) =>
    new TextRun({ text, bold, rightToLeft: rtl, font: FONT });
  const rich = (text: string, bold = false): ParagraphChild[] =>
    splitMath(text).map((piece) =>
      piece.kind === "text"
        ? run(piece.text, bold)
        : new WordMath({ children: toWordMath(piece.tex) }),
    );
  const picture = async (stored: StoredImage | null): Promise<Paragraph[]> => {
    const bytes = stored?.key ? images.get(stored.key) : undefined;
    if (!bytes) return [];
    const { width, height } = await sharp(bytes).metadata();
    const scale = Math.min(1, MAX_IMAGE_WIDTH / width);
    return [
      paragraph([
        new ImageRun({
          type: "png",
          data: bytes,
          transformation: {
            width: Math.round(width * scale),
            height: Math.round(height * scale),
          },
        }),
      ]),
    ];
  };

  const entry = async (e: Entry): Promise<Paragraph[]> => {
    if (e.kind === "stimulus") {
      const s = e.stimulus;
      const text = s.text
        .split(/\n\s*\n/)
        .filter((p) => p.trim() !== "")
        .map((p) => paragraph(rich(p), { shading: { fill: "F2F2F2" } }));
      return [...text, ...(await picture(s.image))];
    }
    if (e.kind === "question") {
      const q = e.question;
      return [
        paragraph([run(`${String(e.number)}. `, true), ...rich(q.text)], {
          spacing: { before: 160 },
        }),
        ...(await picture(q.image)),
        ...q.options.map((o) =>
          paragraph([run(`${o.key}) `), ...rich(o.text)], {
            indent: { start: 360 },
          }),
        ),
      ];
    }
    const c = e.chunk;
    const blocks = c.markdown
      .split(/\n\s*\n/)
      .filter((b) => b.trim() !== "" && !b.startsWith("> "))
      .map((b) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(b.trim());
        return heading?.[1] !== undefined
          ? paragraph(rich(heading[1], true))
          : paragraph(rich(b.replace(/\n/g, " ")));
      });
    const figures = (await Promise.all(c.figures.map(picture))).flat();
    return [
      paragraph([run(c.heading, true)], { spacing: { before: 160 } }),
      ...blocks,
      ...figures,
    ];
  };

  const children: Paragraph[] = [
    paragraph([run(worksheet.title)], { heading: HeadingLevel.TITLE }),
  ];
  for (const section of worksheet.sections) {
    children.push(
      paragraph([run(section.heading)], {
        heading: HEADINGS[Math.min(section.depth, 3)] ?? HeadingLevel.HEADING_4,
      }),
    );
    for (const e of section.entries) children.push(...(await entry(e)));
  }
  children.push(
    paragraph([run(ANSWERS[worksheet.lang])], {
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
    }),
  );
  for (const answer of worksheet.answerKey) {
    children.push(
      paragraph([
        run(`${String(answer.number)}. `, true),
        ...rich(answer.answer),
      ]),
    );
  }

  const doc = new Document({
    title: worksheet.title,
    fonts: [
      {
        name: FONT,
        data: await readFile(FONT_URL),
        characterSet: CharacterSet.ARABIC,
      },
    ],
    styles: {
      default: {
        document: { run: { font: FONT, size: 24, rightToLeft: rtl } },
      },
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
