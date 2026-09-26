// The printable worksheet (spec #1 §1 step 8, decision Q20; E-19): a format-
// neutral model that the Word and PDF renderers both draw. Node headings in
// tree order, numbered questions, a stimulus shown once before its questions,
// explanation for entitled organisations, and an answer key at the end.
import type { OutlineNode } from "../contract/outline.ts";
import type {
  ResultBody,
  StoredChunk,
  StoredImage,
  StoredQuestion,
  StoredStimulus,
} from "../assembly/result.ts";

export interface Worksheet {
  title: string;
  lang: "ar" | "en";
  rtl: boolean;
  sections: WorksheetSection[];
  answerKey: { number: number; answer: string }[];
}

export interface WorksheetSection {
  nodeId: string;
  /** 0 for a top-level node. */
  depth: number;
  heading: string;
  entries: Entry[];
}

export type Entry =
  | { kind: "stimulus"; stimulus: StoredStimulus }
  | { kind: "question"; number: number; question: StoredQuestion }
  | { kind: "explanation"; chunk: StoredChunk };

const ARABIC = /[؀-ۿ]/;

export function buildWorksheet(input: {
  title: string;
  language: string | null;
  tree: readonly OutlineNode[];
  result: ResultBody;
  withExplanation: boolean;
}): Worksheet {
  const { result } = input;
  const stimuli = new Map(result.stimuli.map((s) => [s.id, s]));
  const texts = [
    ...result.questions.map((q) => q.text),
    ...result.explanation.map((c) => c.markdown),
  ];
  const lang =
    input.language === "ar" || input.language === "en"
      ? input.language
      : texts.some((t) => ARABIC.test(t))
        ? "ar"
        : "en";

  const sections: WorksheetSection[] = [];
  const answerKey: Worksheet["answerKey"] = [];
  let number = 0;

  const visit = (nodes: readonly OutlineNode[], depth: number): boolean => {
    let any = false;
    for (const node of nodes) {
      const section: WorksheetSection = {
        nodeId: node.id,
        depth,
        heading: node.name,
        entries: [],
      };
      sections.push(section);
      const at = sections.length - 1;

      if (input.withExplanation) {
        for (const chunk of result.explanation.filter(
          (c) => c.node_id === node.id,
        )) {
          section.entries.push({ kind: "explanation", chunk });
        }
      }
      const shown = new Set<string>();
      const questions = result.questions.filter((q) => q.node_id === node.id);
      // A passage no question points at still belongs with its node's questions.
      for (const stimulus of result.stimuli) {
        if (
          stimulus.node_id === node.id &&
          !questions.some((q) => q.stimulus_id === stimulus.id)
        ) {
          section.entries.push({ kind: "stimulus", stimulus });
          shown.add(stimulus.id);
        }
      }
      for (const question of questions) {
        const stimulus =
          question.stimulus_id === null
            ? undefined
            : stimuli.get(question.stimulus_id);
        if (stimulus && !shown.has(stimulus.id)) {
          section.entries.push({ kind: "stimulus", stimulus });
          shown.add(stimulus.id);
        }
        number++;
        section.entries.push({ kind: "question", number, question });
        answerKey.push({ number, answer: answerText(question) });
      }

      const childrenHaveContent = visit(node.children, depth + 1);
      // A node with nothing under it at any depth is left out.
      if (section.entries.length === 0 && !childrenHaveContent)
        sections.splice(at, 1);
      else any = true;
    }
    return any;
  };
  visit(input.tree, 0);

  return { title: input.title, lang, rtl: lang === "ar", sections, answerKey };
}

/** The answer as a teacher reads it in the key: option keys, or the accepted answers. */
export function answerText(question: StoredQuestion): string {
  if (question.type === "fill_blank") {
    return question.accepted_answers.length > 0
      ? question.accepted_answers.join(" / ")
      : "—";
  }
  return question.correct.length > 0 ? question.correct.join("، ") : "—";
}

/** Every image a worksheet shows, so a renderer can fetch them first. */
export function worksheetImages(worksheet: Worksheet): StoredImage[] {
  return worksheet.sections.flatMap((s) =>
    s.entries.flatMap((e) => {
      if (e.kind === "stimulus")
        return e.stimulus.image ? [e.stimulus.image] : [];
      if (e.kind === "question")
        return e.question.image ? [e.question.image] : [];
      return e.chunk.figures;
    }),
  );
}
