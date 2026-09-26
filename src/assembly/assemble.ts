// Turns page readings into the result (spec #1 §4 steps 3–9). Pure: the same
// readings, tree and offset always give the same result, and nothing here calls
// a model (hard rule 4).
//
// Every block ends up delivered, counted in `skipped`, or covered by a failure
// (hard rule 5). Headings are structure in explanation documents (they head
// chunks); a questions document counts them as `off_type`.
import type { DocumentType } from "../contract/document.ts";
import type { OutlineNode } from "../contract/outline.ts";
import { checkPages } from "../offset/fit.ts";
import { pdfToPrinted, type OffsetSegment } from "../offset/segments.ts";
import type { BlockKind, PageReading } from "../reading/blocks.ts";
import type { SolveRequest, SolvedAnswer } from "../reading/reader.ts";
import { latexValid } from "../shared/latex.ts";
import { resolveAnswers, type AnswerSources } from "./answers.ts";
import { flag, questionChecks } from "./checks.ts";
import {
  chunkSections,
  gatherSections,
  withoutFigures,
  type ChunkOptions,
} from "./chunks.ts";
import { applyJoins, type Join } from "./continuations.ts";
import {
  answerable,
  isFigure,
  itemId,
  toQuestion,
  toStimulus,
  toStoredStimulus,
  type DraftStimulus,
} from "./items.ts";
import { headingNames, place, type Placed } from "./placement.ts";
import type { ResultBody, StoredFailure, StoredImage } from "./result.ts";
import { linkStimuli } from "./stimuli.ts";
import { indexTree, type TreeIndex } from "./tree-index.ts";

export interface FailedPage {
  pdf_page: number;
  detail: string;
}

export interface AssemblyInput {
  type: DocumentType;
  tree: readonly OutlineNode[];
  segments: readonly OffsetSegment[];
  /** Every page that was read, in any order. */
  pages: readonly PageReading[];
  /** Pages whose read failed after every retry. */
  failedPages: readonly FailedPage[];
  /** Blocks re-read across a page break (step 4), replacing their halves. */
  joins?: readonly Join[];
  /**
   * The model's answers to the questions a first assembly left unanswered
   * (step 7). When given, a question still without an answer is flagged.
   */
  solved?: ReadonlyMap<string, SolvedAnswer>;
  chunking?: ChunkOptions;
}

/** The result, and the questions still without an answer for the model to solve. */
export interface Assembly {
  result: ResultBody;
  unanswered: SolveRequest[];
}

/** Which block kinds each document type delivers. The rest are `off_type`. */
const DELIVERS: Record<DocumentType, readonly BlockKind[]> = {
  questions: ["question", "passage", "answer_key"],
  explanation: ["heading", "explanation"],
  both: ["heading", "question", "passage", "answer_key", "explanation"],
};

export function assemble(input: AssemblyInput): Assembly {
  const index = indexTree(input.tree);
  const failures: StoredFailure[] = [];
  const locatorOf = (pdfPage: number) => ({
    pdf_page: pdfPage,
    printed_page: pdfToPrinted(input.segments, pdfPage),
  });
  const skipped = { neither: 0, off_type: 0 };

  for (const failed of input.failedPages) {
    failures.push({
      reason: "part_failed",
      locator: locatorOf(failed.pdf_page),
      detail: failed.detail,
    });
  }

  // Step 4: joined blocks replace their halves.
  const pages = applyJoins(input.pages, input.joins ?? []).sort(
    (a, b) => a.pdf_page - b.pdf_page,
  );
  for (const page of pages) {
    skipped.neither += page.blocks.filter((b) => b.kind === "neither").length;
  }

  // Step 3: a page whose printed number contradicts the confirmed offset is
  // held, not placed. A page with nothing to deliver loses nothing: no break.
  const held = new Set<number>();
  const breaks = new Map(
    checkPages(input.segments, pages).map((b) => [b.pdf_page, b]),
  );
  for (const page of pages) {
    const offsetBreak = breaks.get(page.pdf_page);
    if (!offsetBreak || !page.blocks.some((b) => b.kind !== "neither"))
      continue;
    held.add(page.pdf_page);
    failures.push({
      reason: "offset_break",
      locator: locatorOf(page.pdf_page),
      detail:
        offsetBreak.read === null
          ? `no printed number read; expected ${String(offsetBreak.expected)}`
          : `printed ${String(offsetBreak.read)} read; the offset expects ${String(offsetBreak.expected)}`,
    });
  }

  // Step 5: placement.
  const { placed, unmapped } = place(
    index,
    input.segments,
    pages.filter((p) => !held.has(p.pdf_page)),
  );
  for (const [pdfPage, count] of unmapped) {
    failures.push({
      reason: "unmapped_page",
      locator: locatorOf(pdfPage),
      detail: `${String(count)} block(s) on a page outside every node's range`,
    });
  }

  // Sort what was placed by what the document type delivers.
  const delivers = DELIVERS[input.type];
  const withExplanation = delivers.includes("explanation");
  const questionItems: { item: Placed; order: number }[] = [];
  const drafts: DraftStimulus[] = [];
  placed.forEach((item, order) => {
    const { kind } = item.block;
    // In an explanation document a diagram or table is a figure of its section.
    const figureOnly = input.type === "explanation" && isFigure(item.block);
    if (!delivers.includes(kind) && !figureOnly) {
      skipped.off_type++;
      return;
    }
    if (kind === "question") questionItems.push({ item, order });
    if (kind === "passage" && !figureOnly) drafts.push(toStimulus(item, order));
  });

  // Step 6: link questions to their passage or figure.
  const links = linkStimuli(
    questionItems.map(({ item, order }) => ({
      id: itemId("q", item.block.id),
      node_id: item.node.node.id,
      pdf_page: item.block.pdf_page,
      order,
      number: item.block.question?.number ?? null,
      stimulus_label: item.block.question?.stimulus_label ?? null,
    })),
    drafts.map((s) => ({
      id: s.id,
      node_id: s.node_id,
      pdf_page: s.pages[0] ?? 0,
      order: s.order,
      label: s.label,
      covers: s.covers,
    })),
  );
  const stimuli = new Map(drafts.map((s) => [s.id, s]));
  const linked = new Set([...links.values()].map((l) => l.stimulus_id));

  const questions = [];
  for (const { item } of questionItems) {
    const link = links.get(itemId("q", item.block.id));
    const flags: string[] = link?.uncertain ? ["grouping_uncertain"] : [];

    // A question that needs a figure gets it from its linked stimulus, or its
    // own box; with neither, the owner crops it by hand in review.
    let image: StoredImage | null = null;
    const stimulus = link ? stimuli.get(link.stimulus_id) : undefined;
    if (item.block.question?.needs_figure && !stimulus?.image) {
      if (item.block.box) {
        image = {
          pdf_page: item.block.pdf_page,
          box: item.block.box,
          key: null,
        };
      } else {
        flags.push("image_unreadable");
        failures.push({
          reason: "image_unreadable",
          locator: item.locator,
          detail: `question ${item.block.question.number ?? itemId("q", item.block.id)} needs a figure that could not be located; crop it from the page in review`,
        });
      }
    }

    const question = toQuestion(item, link?.stimulus_id ?? null, image, flags);
    // A question cut off at a page break, with no join, that is too broken to
    // answer is not delivered as an item: it's an incomplete_question failure.
    if (question.review_reason === "cut_off" && !answerable(question)) {
      failures.push({
        reason: "incomplete_question",
        locator: item.locator,
        detail: `question ${question.number ?? "(no number)"} is cut off at a page break: «${question.text.slice(0, 80)}»`,
      });
    } else {
      questions.push(question);
    }
  }

  // Step 7: answers, from the book's key, then a mark on the page, then the model.
  const answers = resolveAnswers(questions, {
    ...answerSources(placed, index, questionItems),
    context: new Map(
      questions.map((q) => {
        const s =
          q.stimulus_id === null ? undefined : stimuli.get(q.stimulus_id);
        const figure = q.image ?? s?.image ?? null;
        return [
          q.id,
          {
            stimulus: s?.text ?? null,
            figure: figure
              ? { pdf_page: figure.pdf_page, box: figure.box }
              : null,
          },
        ];
      }),
    ),
    solved: input.solved,
  });
  failures.push(...answers.failures);

  // Step 8: explanation, one chunk per heading-bounded section. In a `both`
  // document a diagram a question uses stays a stimulus, and the others are
  // figures of their section instead.
  const explanation = withExplanation
    ? withoutFigures(
        gatherSections(placed, input.segments),
        new Set(drafts.filter((d) => linked.has(d.id)).map((d) => d.block_id)),
      )
    : [];
  const figureBlocks = new Set(
    explanation.flatMap((s) => s.figure_blocks ?? []),
  );
  const deliveredStimuli = drafts.filter((d) => !figureBlocks.has(d.block_id));
  const chunks = chunkSections(explanation, input.chunking);

  // Step 9: checks.
  for (const question of questions) {
    for (const reason of questionChecks(question)) flag(question, reason);
  }
  for (const chunk of chunks) {
    if (!latexValid(chunk.markdown)) flag(chunk, "latex_invalid");
  }

  failures.sort((a, b) => a.locator.pdf_page - b.locator.pdf_page);
  return {
    result: {
      stimuli: deliveredStimuli.map(toStoredStimulus),
      questions,
      explanation: chunks,
      skipped,
      failures,
    },
    unanswered: answers.unanswered,
  };
}

/** Everything the answer chain reads from the placed blocks. */
function answerSources(
  placed: readonly Placed[],
  index: TreeIndex,
  questionItems: readonly { item: Placed }[],
): Omit<AnswerSources, "context" | "solved"> {
  const keyBlocks: AnswerSources["keyBlocks"][number][] = [];
  let lastHeading: string | null = null;
  for (const item of placed) {
    if (item.block.kind === "heading") lastHeading = item.block.text;
    if (item.block.kind !== "answer_key") continue;
    keyBlocks.push({
      entries: item.block.answers,
      heading: lastHeading,
      node_id: item.node.node.kind === "content" ? item.node.node.id : null,
      locator: item.locator,
    });
  }
  return {
    keyBlocks,
    // An entry's section names the deepest content node whose name it holds.
    lessonOf: (section) => {
      if (section === null) return null;
      const named = index.nodes
        .filter((n) => n.node.kind === "content" && headingNames(section, n))
        .sort((a, b) => b.depth - a.depth);
      return named[0]?.node.id ?? null;
    },
    inLesson: (questionNode, lesson) =>
      questionNode === lesson ||
      (index.byId.get(questionNode)?.ancestors.some((a) => a.id === lesson) ??
        false),
    marks: new Map(
      questionItems.map(({ item }) => [
        itemId("q", item.block.id),
        item.block.question?.marked ?? [],
      ]),
    ),
  };
}
