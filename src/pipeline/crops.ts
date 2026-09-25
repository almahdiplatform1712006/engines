// Cuts every figure a result needs from the stored page images and stores it
// with the results (E-10). A figure that can't be cut becomes an
// `image_unreadable` failure; its item is flagged, never dropped.
import type { ResultBody, StoredImage } from "../assembly/result.ts";
import { cropImage } from "../render/crop.ts";
import type { PipelineDeps } from "./deps.ts";

export async function cutCrops(
  deps: Pick<PipelineDeps, "db" | "store">,
  documentId: string,
  result: ResultBody,
  revision = 1,
): Promise<void> {
  const pages = new Map<number, Promise<Buffer>>();
  const pageImage = (pdfPage: number) => {
    let image = pages.get(pdfPage);
    if (!image) {
      image = deps.db
        .query<{ image_key: string }>(
          "SELECT image_key FROM pages WHERE document_id = $1 AND pdf_page = $2",
          [documentId, pdfPage],
        )
        .then(({ rows }) => {
          const key = rows[0]?.image_key;
          if (!key) throw new Error(`no image for page ${String(pdfPage)}`);
          return deps.store.get(key);
        });
      pages.set(pdfPage, image);
    }
    return image;
  };

  const cut = async (image: StoredImage, name: string): Promise<boolean> => {
    if (image.key !== null) return true;
    try {
      const png = await cropImage(await pageImage(image.pdf_page), image.box);
      const key = `results/${documentId}/crops/${name}-r${String(revision)}.png`;
      await deps.store.put(key, png, "image/png");
      image.key = key;
      return true;
    } catch (error) {
      result.failures.push({
        reason: "image_unreadable",
        locator: { pdf_page: image.pdf_page, printed_page: null },
        detail: `${name}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  };

  for (const stimulus of result.stimuli) {
    if (stimulus.image && !(await cut(stimulus.image, stimulus.id)))
      stimulus.image = null;
  }
  for (const question of result.questions) {
    if (question.image && !(await cut(question.image, question.id))) {
      question.image = null;
      question.review_required = true;
      question.review_reason ??= "image_unreadable";
    }
  }
  for (const chunk of result.explanation) {
    const kept: StoredImage[] = [];
    for (const [i, figure] of chunk.figures.entries()) {
      if (await cut(figure, `${chunk.id}-${String(i)}`)) kept.push(figure);
      else {
        chunk.review_required = true;
        chunk.review_reason ??= "image_unreadable";
      }
    }
    chunk.figures = kept;
  }
}
