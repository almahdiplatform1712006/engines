// Builders for stored results in tests.
import type {
  ResultBody,
  StoredChunk,
  StoredQuestion,
  StoredStimulus,
} from "../src/assembly/result.ts";

export function question(
  id: string,
  node: string,
  fields: Partial<StoredQuestion> = {},
): StoredQuestion {
  return {
    id,
    type: "multiple_choice",
    number: id,
    text: `question ${id}`,
    options: [
      { key: "أ", text: "$F = ma$" },
      { key: "ب", text: "صفر" },
    ],
    correct: ["أ"],
    accepted_answers: [],
    answer_source: "book",
    node_id: node,
    node_path: [node],
    external_ref: null,
    stimulus_id: null,
    locator: { pdf_page: 1, printed_page: 1 },
    idea_tag: null,
    math_direction: "ltr",
    image: null,
    review_required: false,
    review_reason: null,
    confidence: 0.9,
    ...fields,
  };
}

export function stimulus(
  id: string,
  node: string,
  fields: Partial<StoredStimulus> = {},
): StoredStimulus {
  return {
    id,
    kind: "passage",
    text: `passage ${id}`,
    node_id: node,
    pages: [1],
    image: null,
    ...fields,
  };
}

export function chunk(
  id: string,
  node: string,
  fields: Partial<StoredChunk> = {},
): StoredChunk {
  return {
    id,
    node_id: node,
    node_path: [node],
    external_ref: null,
    heading: `heading ${id}`,
    markdown: `> ${node}\n\nالشرح $a = \\frac{F}{m}$`,
    math_direction: "ltr",
    figures: [],
    pages: { pdf: [1], printed: [1] },
    review_required: false,
    review_reason: null,
    ...fields,
  };
}

export function result(fields: Partial<ResultBody> = {}): ResultBody {
  return {
    stimuli: [],
    questions: [],
    explanation: [],
    skipped: { neither: 0, off_type: 0 },
    failures: [],
    ...fields,
  };
}
