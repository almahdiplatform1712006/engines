// Builds small, valid PDFs for tests: each page shows a line of text.
export function makePdf(pages: readonly string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const id = pageIds[i] ?? 0;
    const stream = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objects[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(id + 1)} 0 R >>`;
    objects[id + 1] =
      `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${String(id)} 0 obj\n${objects[id] ?? ""}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${String(objects.length)}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    body += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${String(objects.length)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
