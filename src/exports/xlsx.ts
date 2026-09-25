// The result as a spreadsheet (E-19): a Questions sheet, a Tree sheet and, for
// entitled organisations, an Explanation sheet. Sheets read right-to-left when
// the document is Arabic. Math stays LaTeX, exactly as printed.
import ExcelJS from "exceljs";
import type { OutlineNode } from "../contract/outline.ts";
import type { ResultBody } from "../assembly/result.ts";
import { walk } from "../outline/tree.ts";
import { answerText } from "./worksheet.ts";

export async function resultXlsx(input: {
  rtl: boolean;
  tree: readonly OutlineNode[];
  result: ResultBody;
  withExplanation: boolean;
}): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = "Engines";
  const views = [
    { rightToLeft: input.rtl, state: "frozen" as const, ySplit: 1 },
  ];
  const header = (sheet: ExcelJS.Worksheet) => {
    sheet.getRow(1).font = { bold: true };
  };

  const questions = book.addWorksheet("Questions", { views });
  questions.columns = [
    { header: "Node path", key: "path", width: 36 },
    { header: "Number", key: "number", width: 8 },
    { header: "Type", key: "type", width: 16 },
    { header: "Question", key: "text", width: 60 },
    { header: "Options", key: "options", width: 50 },
    { header: "Correct answer", key: "answer", width: 18 },
    { header: "Answer source", key: "source", width: 14 },
    { header: "Stimulus", key: "stimulus", width: 12 },
    { header: "PDF page", key: "pdf", width: 10 },
    { header: "Printed page", key: "printed", width: 12 },
    { header: "Flag", key: "flag", width: 22 },
    { header: "External ref", key: "ref", width: 16 },
    { header: "Id", key: "id", width: 14 },
  ];
  header(questions);
  for (const q of input.result.questions) {
    questions.addRow({
      path: q.node_path.join(" › "),
      number: q.number,
      type: q.type,
      text: q.text,
      options: q.options.map((o) => `${o.key}) ${o.text}`).join("\n"),
      answer: answerText(q),
      source: q.answer_source ?? "",
      stimulus: q.stimulus_id ?? "",
      pdf: q.locator.pdf_page,
      printed: q.locator.printed_page,
      flag: q.review_reason ?? "",
      ref: q.external_ref ?? "",
      id: q.id,
    });
  }
  questions.getColumn("options").alignment = {
    wrapText: true,
    vertical: "top",
  };
  questions.getColumn("text").alignment = { wrapText: true, vertical: "top" };

  const tree = book.addWorksheet("Tree", { views });
  tree.columns = [
    { header: "Node", key: "name", width: 44 },
    { header: "Level", key: "level", width: 12 },
    { header: "Printed from", key: "from", width: 12 },
    { header: "Printed to", key: "to", width: 12 },
    { header: "Kind", key: "kind", width: 12 },
    { header: "External ref", key: "ref", width: 16 },
    { header: "Id", key: "id", width: 14 },
  ];
  header(tree);
  for (const { node, ancestors } of walk(input.tree)) {
    const row = tree.addRow({
      name: node.name,
      level: node.level ?? "",
      from: node.printed_pages?.from ?? null,
      to: node.printed_pages?.to ?? null,
      kind: node.kind,
      ref: node.external_ref ?? "",
      id: node.id,
    });
    row.getCell("name").alignment = { indent: ancestors.length * 2 };
  }

  if (input.withExplanation) {
    const explanation = book.addWorksheet("Explanation", { views });
    explanation.columns = [
      { header: "Node path", key: "path", width: 36 },
      { header: "Heading", key: "heading", width: 30 },
      { header: "Markdown", key: "markdown", width: 90 },
      { header: "PDF pages", key: "pdf", width: 12 },
      { header: "Printed pages", key: "printed", width: 14 },
      { header: "Id", key: "id", width: 14 },
    ];
    header(explanation);
    for (const c of input.result.explanation) {
      explanation.addRow({
        path: c.node_path.join(" › "),
        heading: c.heading,
        markdown: c.markdown,
        pdf: c.pages.pdf.join(", "),
        printed: c.pages.printed.join(", "),
        id: c.id,
      });
    }
    explanation.getColumn("markdown").alignment = {
      wrapText: true,
      vertical: "top",
    };
  }

  return Buffer.from(await book.xlsx.writeBuffer());
}
