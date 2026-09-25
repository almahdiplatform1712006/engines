// Turns page readings into the result (spec #1 §4 steps 3–9). Pure: the same
// readings, tree and offset always give the same result, and nothing here calls
// a model (hard rule 4).
//
// Every block ends up placed, counted in `skipped`, or covered by a failure
// (hard rule 5). Headings are structure: they split shared pages, name idea
// tags and head explanation chunks.
import type { DocumentType } from "../contract/document.ts";
import type { OutlineNode } from "../contract/outline.ts";
import { checkPages } from "../offset/fit.ts";
import { pdfToPrinted, type OffsetSegment } from "../offset/segments.ts";
import type { BlockKind, PageReading } from "../reading/blocks.ts";
import { applyJoins, type Join } from "./continuations.ts";
import { place, type Placed } from "./placement.ts";
import type {
  ResultBody,
  StoredImage,
  StoredQuestion,
  StoredStimulus,
} from "./result.ts";
import { linkStimuli } from "./stimuli.ts";
import {
  answerFor,
  matchAnswerKey,
  type Answer,
  type AnswerEntry,
} from "./answers.ts";
import { flag, questionChecks } from "./checks.ts";
import { chunkSections, type ChunkOptions, type Section } from "./chunks.ts";
import { latexValid } from "../shared/latex.ts";
import { headingNames } from "./placement.ts";
import type { SolveRequest, SolvedAnswer } from "../reading/reader.ts";
import type { TreeIndex } from "./tree-index.ts";
import { indexTree } from "./tree-index.ts";

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

/** Which block kinds each document type delivers. The rest are `off_type`. */
const DELIVERS: Record<DocumentType, readonly BlockKind[]> = {
  questions: ["question", "passage", "answer_key"],
  explanation: ["explanation"],
  both: ["question", "passage", "answer_key", "explanation"],
};

/** The result, and the questions still without an answer for the model to solve. */
export interface Assembly {
  result: ResultBody;
  unanswered: SolveRequest[];
}

export function assemble(input: AssemblyInput): Assembly {
  const index = indexTree(input.tree);
  const result: ResultBody = {
    stimuli: [],
    questions: [],
    explanation: [],
    skipped: { neither: 0, off_type: 0 },
    failures: [],
  };
  const locatorOf = (pdfPage: number) => ({
    pdf_page: pdfPage,
    printed_page: pdfToPrinted(input.segments, pdfPage),
  });

  for (const failed of input.failedPages) {
    result.failures.push({
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
    result.skipped.neither += page.blocks.filter(
      (b) => b.kind === "neither",
    ).length;
  }

  // Step 3: a page whose printed number contradicts the confirmed offset is
  // held, not placed. A page with nothing to deliver loses nothing, so it is no break.
  const breaks = new Map(
    checkPages(input.segments, pages).map((b) => [b.pdf_page, b]),
  );
  const held = new Set<number>();
  for (const page of pages) {
    const offsetBreak = breaks.get(page.pdf_page);
    if (!offsetBreak || !page.blocks.some((b) => b.kind !== "neither"))
      continue;
    held.add(page.pdf_page);
    result.failures.push({
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
    result.failures.push({
      reason: "unmapped_page",
      locator: locatorOf(pdfPage),
      detail: `${String(count)} block(s) on a page outside every node's range`,
    });
  }

  const delivers = DELIVERS[input.type];
  const questionItems: { item: Placed; order: number }[] = [];
  const drafts: DraftStimulus[] = [];
  const stimulusOrder = new Map<string, number>();
  const explanationOnly = input.type === "explanation";
  const sections = new SectionBuilder(input.segments);
  placed.forEach((item, order) => {
    const kind = item.block.kind;
    if (delivers.includes("explanation")) sections.add(item);
    if (kind === "heading") return;
    // In an explanation document a diagram or table is a figure of its section.
    if (
      explanationOnly &&
      kind === "passage" &&
      item.block.stimulus?.kind !== "passage" &&
      item.block.box !== null
    )
      return;
    if (kind === "explanation" && delivers.includes(kind)) return;
    if (!delivers.includes(kind)) {
      result.skipped.off_type++;
      return;
    }
    if (kind === "question") questionItems.push({ item, order });
    if (kind === "passage") {
      const stimulus = toStimulus(item);
      drafts.push(stimulus);
      stimulusOrder.set(stimulus.id, order);
    }
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
      order: stimulusOrder.get(s.id) ?? 0,
      label: s.label,
      covers: s.covers,
    })),
  );
  const stimuli = new Map(drafts.map((s) => [s.id, s]));
  result.stimuli = drafts.map(toStoredStimulus);

  for (const { item } of questionItems) {
    const link = links.get(itemId("q", item.block.id));
    const flags: string[] = link?.uncertain ? ["grouping_uncertain"] : [];

    // A question that needs a figure gets it from its linked stimulus, or its
    // own box; with neither, the owner crops it by hand in review.
    let image: StoredImage | null = null;
    const linked = link ? stimuli.get(link.stimulus_id) : undefined;
    if (item.block.question?.needs_figure && !linked?.image) {
      if (item.block.box) {
        image = {
          pdf_page: item.block.pdf_page,
          box: item.block.box,
          key: null,
        };
      } else {
        flags.push("image_unreadable");
        result.failures.push({
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
      result.failures.push({
        reason: "incomplete_question",
        locator: item.locator,
        detail: `question ${question.number ?? "(no number)"} is cut off at a page break: «${question.text.slice(0, 80)}»`,
      });
    } else {
      result.questions.push(question);
    }
  }

  // Step 7: answers, from the book's key, then a mark on the page, then the model.
  const marks = new Map(
    questionItems.map(({ item }) => [
      itemId("q", item.block.id),
      item.block.question?.marked ?? [],
    ]),
  );
  const unanswered = applyAnswers(
    result.questions,
    answerEntries(placed),
    index,
    drafts,
    marks,
    input.solved,
  );

  // Step 8: explanation, one chunk per heading-bounded section.
  result.explanation = chunkSections(sections.sections(), input.chunking);

  // Step 9: checks.
  for (const question of result.questions) {
    for (const reason of questionChecks(question)) flag(question, reason);
  }
  for (const chunk of result.explanation) {
    if (!latexValid(chunk.markdown)) flag(chunk, "latex_invalid");
  }

  result.failures.sort((a, b) => a.locator.pdf_page - b.locator.pdf_page);
  return { result, unanswered };
}

/** A stable item id from the block it came from: `q_93_2` for block 2 of PDF page 93. */
export function itemId(prefix: string, blockId: string): string {
  return `${prefix}_${blockId.slice(1).replace("#", "_")}`;
}

function toQuestion(
  item: Placed,
  stimulusId: string | null,
  image: StoredImage | null,
  extraFlags: readonly string[],
): StoredQuestion {
  const { block, node } = item;
  const q = block.question;
  if (q === null)
    throw new Error(`block ${block.id} is a question without question fields`);
  const flags = [
    // A block still flagged as running across a page break was never joined.
    block.continues || block.continued_from ? "cut_off" : null,
    item.flag,
    ...extraFlags,
    block.repaired === null ? null : "repaired",
  ].filter((f) => f !== null);
  return {
    id: itemId("q", block.id),
    type: q.type,
    number: q.number,
    text: block.text,
    options: q.options,
    correct: [],
    accepted_answers: [],
    answer_source: null,
    node_id: node.node.id,
    node_path: node.path,
    external_ref: node.node.external_ref,
    stimulus_id: stimulusId,
    locator: item.locator,
    idea_tag: item.idea_tag,
    math_direction: block.math_direction,
    image,
    review_required: flags.length > 0,
    review_reason: flags[0] ?? null,
    confidence: block.confidence,
  };
}

/** A stimulus, with what linking needs kept aside (`label`, `covers`) until the result is written. */
type DraftStimulus = StoredStimulus & {
  label: string | null;
  covers: { from: string; to: string } | null;
};

function toStoredStimulus(draft: DraftStimulus): StoredStimulus {
  return {
    id: draft.id,
    kind: draft.kind,
    text: draft.text,
    node_id: draft.node_id,
    pages: draft.pages,
    image: draft.image,
  };
}

function toStimulus(item: Placed): DraftStimulus {
  const { block, node } = item;
  const kind = block.stimulus?.kind ?? "passage";
  return {
    id: itemId("s", block.id),
    kind,
    text: block.text,
    node_id: node.node.id,
    pages:
      block.continues_on === undefined
        ? [block.pdf_page]
        : [block.pdf_page, block.continues_on],
    // Diagrams and tables are delivered as a crop of the page too.
    image:
      kind !== "passage" && block.box
        ? { pdf_page: block.pdf_page, box: block.box, key: null }
        : null,
    label: block.stimulus?.label ?? null,
    covers: block.stimulus?.covers ?? null,
  };
}

/** Enough of a question survives to answer it: a stem, and options where its type needs them. */
function answerable(question: StoredQuestion): boolean {
  if (question.text.trim() === "") return false;
  if (question.type === "multiple_choice") return question.options.length >= 2;
  return true;
}

/**
 * Answer-key entries in reading order. An entry without a section takes the
 * last heading before it (an answers page headed "الدرس الثالث"); failing
 * that, the node its block was placed in (answers printed at a lesson's end).
 */
function answerEntries(placed: readonly Placed[]): AnswerEntry[] {
  const entries: AnswerEntry[] = [];
  let lastHeading: string | null = null;
  for (const item of placed) {
    if (item.block.kind === "heading") lastHeading = item.block.text;
    if (item.block.kind !== "answer_key") continue;
    for (const answer of item.block.answers) {
      entries.push({
        ...answer,
        section: answer.section ?? lastHeading,
        node_id: item.node.node.kind === "content" ? item.node.node.id : null,
      });
    }
  }
  return entries;
}

/** Fills every question's answer and returns those left for the model. */
function applyAnswers(
  questions: StoredQuestion[],
  entries: readonly AnswerEntry[],
  index: TreeIndex,
  stimuli: readonly DraftStimulus[],
  marks: ReadonlyMap<string, readonly string[]>,
  solved: ReadonlyMap<string, SolvedAnswer> | undefined,
): SolveRequest[] {
  const lessonOf = (section: string | null): string | null => {
    if (section === null) return null;
    const named = index.nodes
      .filter((n) => n.node.kind === "content" && headingNames(section, n))
      .sort((a, b) => b.depth - a.depth);
    return named[0]?.node.id ?? null;
  };
  const inLesson = (questionNode: string, lesson: string) =>
    questionNode === lesson ||
    (index.byId.get(questionNode)?.ancestors.some((a) => a.id === lesson) ??
      false);
  const book = matchAnswerKey(entries, questions, lessonOf, inLesson);

  const unanswered: SolveRequest[] = [];
  for (const question of questions) {
    const set = (answer: Answer, source: StoredQuestion["answer_source"]) => {
      question.correct = answer.correct;
      question.accepted_answers = answer.accepted_answers;
      question.answer_source = source;
    };
    const fromBook = book.get(question.id);
    if (fromBook) {
      set(fromBook, "book");
      continue;
    }
    const fromMarks = markedAnswer(question, marks.get(question.id) ?? []);
    if (fromMarks) {
      set(fromMarks, "marked");
      continue;
    }
    const fromModel = solved?.get(question.id);
    if (fromModel) {
      set(
        {
          correct: fromModel.correct,
          accepted_answers: fromModel.accepted_answers,
        },
        "model",
      );
      flag(question, "model_answer");
      continue;
    }
    if (solved) {
      flag(question, "no_answer");
      continue;
    }
    const stimulus =
      question.stimulus_id === null
        ? undefined
        : stimuli.find((s) => s.id === question.stimulus_id);
    unanswered.push({
      question_id: question.id,
      number: question.number,
      type: question.type,
      text: question.text,
      options: question.options,
      stimulus: stimulus?.text ?? null,
    });
  }
  return unanswered;
}

/** A hand mark on the page (a circle, tick or fill), when it names the question's options. */
function markedAnswer(
  question: StoredQuestion,
  marks: readonly string[],
): Answer | null {
  if (marks.length === 0) return null;
  const answers = marks.map((mark) => answerFor(mark, question));
  if (answers.some((a) => a === null)) return null;
  return {
    correct: [...new Set(answers.flatMap((a) => a?.correct ?? []))],
    accepted_answers: [
      ...new Set(answers.flatMap((a) => a?.accepted_answers ?? [])),
    ],
  };
}

/**
 * Gathers heading-bounded sections of explanation in reading order. A heading
 * opens a section in its node; explanation in another node than the open
 * section's opens a section headed by that node's name. Diagrams and tables
 * in an explanation document become the section's figures. Sections with no
 * text are dropped (a lesson title followed only by questions).
 */
class SectionBuilder {
  private readonly all: Section[] = [];
  private current: Section | null = null;
  private pendingHeading: { text: string; node_id: string } | null = null;
  private readonly segments: readonly OffsetSegment[];

  constructor(segments: readonly OffsetSegment[]) {
    this.segments = segments;
  }

  add(item: Placed): void {
    const { block, node } = item;
    if (block.kind === "heading") {
      this.pendingHeading = { text: block.text, node_id: node.node.id };
      this.current = null;
      return;
    }
    const isFigure =
      block.kind === "passage" &&
      block.stimulus?.kind !== "passage" &&
      block.box !== null;
    if (block.kind !== "explanation" && !isFigure) return;

    if (this.current?.node_id !== node.node.id) {
      const heading =
        this.pendingHeading?.node_id === node.node.id
          ? this.pendingHeading.text
          : node.node.name;
      this.pendingHeading = null;
      this.current = {
        id: itemId("c", block.id),
        node_id: node.node.id,
        node_path: node.path,
        external_ref: node.node.external_ref,
        heading,
        markdown: "",
        math_direction: null,
        figures: [],
        pdf_pages: [],
        printed_pages: [],
      };
      this.all.push(this.current);
    }
    const section = this.current;
    if (isFigure && block.box) {
      section.figures.push({
        pdf_page: block.pdf_page,
        box: block.box,
        key: null,
      });
    } else {
      section.markdown =
        section.markdown === ""
          ? block.text
          : `${section.markdown}\n\n${block.text}`;
      section.math_direction ??= block.math_direction;
    }
    if (!section.pdf_pages.includes(block.pdf_page))
      section.pdf_pages.push(block.pdf_page);
    const printed = pdfToPrinted(this.segments, block.pdf_page);
    if (printed !== null && !section.printed_pages.includes(printed))
      section.printed_pages.push(printed);
  }

  sections(): Section[] {
    return this.all.filter((s) => s.markdown.trim() !== "");
  }
}
