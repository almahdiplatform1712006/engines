import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  correctAnswerAccuracy,
  costPerPage,
  cropIoU,
  explanationCER,
  latexParseRate,
  optionSetExactMatch,
  printedPageAccuracy,
  questionPrecision,
  questionRecall,
  stimulusLinkAccuracy,
} from "./scorers.ts";
import type { PageContent, Question, Stimulus } from "./truth.ts";

function stimulus(id: string, text: string): Stimulus {
  return { id, kind: "passage", text, crop: null };
}

function question(
  overrides: Partial<Question> & Pick<Question, "id" | "text">,
): Question {
  return {
    number: null,
    type: "multiple_choice",
    options: [],
    correct: [],
    accepted_answers: [],
    answer_source: null,
    stimulus_id: null,
    math_direction: null,
    crop: null,
    ...overrides,
  };
}

function page(overrides: Partial<PageContent> = {}): PageContent {
  return {
    pdf_page: 11,
    printed_page: 7,
    stimuli: [],
    questions: [],
    explanation: [],
    ...overrides,
  };
}

const truthQuestions = [
  question({ id: "t1", text: "ما وحدة قياس القوة؟" }),
  question({ id: "t2", text: "احسب تسارع جسم كتلته 2 kg تؤثر عليه قوة 10 N" }),
  question({ id: "t3", text: "اذكر نص القانون الأول لنيوتن" }),
];

describe("question recall and precision", () => {
  test("a reader that finds two of three questions and invents one", () => {
    const truth = page({ questions: truthQuestions });
    const predicted = page({
      questions: [
        // Same question, spelling variants and Arabic-Indic digits.
        question({ id: "p1", text: "ما وحده قياس القوه؟" }),
        question({
          id: "p2",
          text: "احسب تسارع جسم كتلته ٢ kg تؤثر عليه قوة ١٠ N",
        }),
        question({ id: "p3", text: "عرّف الكتلة القصورية" }),
      ],
    });

    assert.deepEqual(questionRecall(truth, predicted), { num: 2, den: 3 });
    assert.deepEqual(questionPrecision(truth, predicted), { num: 2, den: 3 });
  });

  test("one predicted question cannot claim two truth questions", () => {
    const truth = page({
      questions: [
        question({ id: "t1", text: "اذكر نص القانون الأول لنيوتن" }),
        question({ id: "t2", text: "اذكر نص القانون الثاني لنيوتن" }),
      ],
    });
    const predicted = page({
      questions: [question({ id: "p1", text: "اذكر نص القانون الأول لنيوتن" })],
    });

    assert.deepEqual(questionRecall(truth, predicted), { num: 1, den: 2 });
    assert.deepEqual(questionPrecision(truth, predicted), { num: 1, den: 1 });
  });

  test("a page with no questions and none predicted measures nothing", () => {
    assert.deepEqual(questionRecall(page(), page()), { num: 0, den: 0 });
    assert.deepEqual(questionPrecision(page(), page()), { num: 0, den: 0 });
  });
});

const unitOptions = [
  { key: "أ", text: "نيوتن" },
  { key: "ب", text: "جول" },
  { key: "ج", text: "واط" },
];

describe("option-set exact match", () => {
  test("counts matched questions whose options are exactly the truth options", () => {
    const truth = page({
      questions: [
        question({
          id: "t1",
          text: "ما وحدة قياس القوة؟",
          options: unitOptions,
        }),
        question({
          id: "t2",
          text: "ما وحدة قياس الشغل؟",
          options: unitOptions,
        }),
      ],
    });
    const predicted = page({
      questions: [
        // Same options in another order, with a bare alef key: a match.
        question({
          id: "p1",
          text: "ما وحدة قياس القوة؟",
          options: [
            { key: "ج", text: "واط" },
            { key: "ا", text: "نيوتن" },
            { key: "ب", text: "جول" },
          ],
        }),
        // One option missing: not a match.
        question({
          id: "p2",
          text: "ما وحدة قياس الشغل؟",
          options: unitOptions.slice(0, 2),
        }),
        // A question that isn't on the page is not counted either way.
        question({
          id: "p3",
          text: "عرّف الكتلة القصورية",
          options: unitOptions,
        }),
      ],
    });

    assert.deepEqual(optionSetExactMatch(truth, predicted), { num: 1, den: 2 });
  });
});

describe("correct-answer accuracy", () => {
  test("counts matched questions whose correct answer equals the truth", () => {
    const truth = page({
      questions: [
        question({ id: "t1", text: "ما وحدة قياس القوة؟", correct: ["أ"] }),
        question({ id: "t2", text: "ما وحدة قياس الشغل؟", correct: ["ب"] }),
        question({
          id: "t3",
          type: "fill_blank",
          text: "وحدة قياس القدرة هي ....",
          accepted_answers: ["الواط", "واط"],
        }),
      ],
    });
    const predicted = page({
      questions: [
        question({ id: "p1", text: "ما وحدة قياس القوة؟", correct: ["ا"] }),
        question({ id: "p2", text: "ما وحدة قياس الشغل؟", correct: ["ج"] }),
        question({
          id: "p3",
          type: "fill_blank",
          text: "وحدة قياس القدرة هي ....",
          accepted_answers: ["واط", "الواط"],
        }),
      ],
    });

    assert.deepEqual(correctAnswerAccuracy(truth, predicted), {
      num: 2,
      den: 3,
    });
  });
});

describe("stimulus-link accuracy", () => {
  const passageA =
    "سقط جسم كتلته 5 kg من ارتفاع 20 m عن سطح الأرض. أجب عما يلي:";
  const passageB = "يتحرك قطار بسرعة ثابتة 72 km/h على خط مستقيم. أجب عما يلي:";

  test("links count as right when they point at the same passage, whatever its id", () => {
    const truth = page({
      stimuli: [stimulus("s_a", passageA), stimulus("s_b", passageB)],
      questions: [
        question({
          id: "t1",
          text: "احسب طاقة الوضع للجسم",
          stimulus_id: "s_a",
        }),
        question({
          id: "t2",
          text: "احسب سرعة القطار بوحدة m/s",
          stimulus_id: "s_b",
        }),
        question({
          id: "t3",
          text: "اذكر نص القانون الأول لنيوتن",
          stimulus_id: null,
        }),
        question({
          id: "t4",
          text: "احسب سرعة الجسم لحظة وصوله للأرض",
          stimulus_id: "s_a",
        }),
      ],
    });
    const predicted = page({
      // The reader's own ids, in another order.
      stimuli: [stimulus("x2", passageB), stimulus("x1", passageA)],
      questions: [
        question({
          id: "p1",
          text: "احسب طاقة الوضع للجسم",
          stimulus_id: "x1",
        }), // right
        question({
          id: "p2",
          text: "احسب سرعة القطار بوحدة m/s",
          stimulus_id: "x1",
        }), // wrong passage
        question({
          id: "p3",
          text: "اذكر نص القانون الأول لنيوتن",
          stimulus_id: null,
        }), // right: stands alone
        question({
          id: "p4",
          text: "احسب سرعة الجسم لحظة وصوله للأرض",
          stimulus_id: null,
        }), // missed link
      ],
    });

    assert.deepEqual(stimulusLinkAccuracy(truth, predicted), {
      num: 2,
      den: 4,
    });
  });

  test("a link to a passage the reader invented is wrong", () => {
    const truth = page({
      stimuli: [stimulus("s_a", passageA)],
      questions: [
        question({
          id: "t1",
          text: "احسب طاقة الوضع للجسم",
          stimulus_id: null,
        }),
      ],
    });
    const predicted = page({
      stimuli: [stimulus("x9", "نص لا يوجد في الصفحة إطلاقا ولا يشبه أي فقرة")],
      questions: [
        question({
          id: "p1",
          text: "احسب طاقة الوضع للجسم",
          stimulus_id: "x9",
        }),
      ],
    });

    assert.deepEqual(stimulusLinkAccuracy(truth, predicted), {
      num: 0,
      den: 1,
    });
  });
});

describe("crop IoU", () => {
  test("sums intersection-over-union for matched questions that both have a crop", () => {
    const truth = page({
      questions: [
        question({
          id: "t1",
          text: "ما وحدة قياس القوة؟",
          crop: { x: 0, y: 0, w: 0.5, h: 0.2 },
        }),
        question({
          id: "t2",
          text: "ما وحدة قياس الشغل؟",
          crop: { x: 0, y: 0.5, w: 0.5, h: 0.2 },
        }),
        question({
          id: "t3",
          text: "ما وحدة قياس القدرة؟",
          crop: { x: 0, y: 0.8, w: 0.5, h: 0.2 },
        }),
      ],
    });
    const predicted = page({
      questions: [
        // Exact box: IoU 1.
        question({
          id: "p1",
          text: "ما وحدة قياس القوة؟",
          crop: { x: 0, y: 0, w: 0.5, h: 0.2 },
        }),
        // Shifted right by half its width: overlap 0.25×0.2 = 0.05, union 0.15 → IoU 1/3.
        question({
          id: "p2",
          text: "ما وحدة قياس الشغل؟",
          crop: { x: 0.25, y: 0.5, w: 0.5, h: 0.2 },
        }),
        // No crop at all: IoU 0.
        question({ id: "p3", text: "ما وحدة قياس القدرة؟", crop: null }),
      ],
    });

    const { num, den } = cropIoU(truth, predicted);
    assert.equal(den, 3);
    assert.ok(Math.abs(num - (1 + 1 / 3)) < 1e-9, `num was ${String(num)}`);
  });

  test("also scores stimulus crops", () => {
    const box = { x: 0.1, y: 0.1, w: 0.8, h: 0.3 };
    const truth = page({
      stimuli: [
        { ...stimulus("s_a", "نص الفقرة الأولى في الصفحة"), crop: box },
      ],
    });
    const predicted = page({
      stimuli: [{ ...stimulus("x1", "نص الفقرة الأولى في الصفحة"), crop: box }],
    });

    const { num, den } = cropIoU(truth, predicted);
    assert.equal(den, 1);
    assert.ok(Math.abs(num - 1) < 1e-9, `num was ${String(num)}`);
  });
});

describe("explanation CER", () => {
  test("compares the page's explanation text after Arabic normalisation", () => {
    const truth = page({
      explanation: [
        {
          heading: "القانون الثاني",
          markdown: "القوة = الكتلة × التسارع",
          crop: null,
        },
      ],
    });
    const predicted = page({
      explanation: [
        // Tatweel costs nothing; one letter is wrong (س → ص).
        {
          heading: "القانـــون الثاني",
          markdown: "القوة = الكتلة × التصارع",
          crop: null,
        },
      ],
    });

    // "القانون الثاني" (14) + line break (1) + "القوة = الكتلة × التسارع" (24) = 39.
    assert.deepEqual(explanationCER(truth, predicted), { num: 1, den: 39 });
  });

  test("a page with no explanation measures nothing", () => {
    assert.deepEqual(explanationCER(page(), page()), { num: 0, den: 0 });
  });
});

describe("printed-page-number accuracy", () => {
  test("is right when the reader read the printed number", () => {
    assert.deepEqual(
      printedPageAccuracy(page({ printed_page: 7 }), page({ printed_page: 7 })),
      {
        num: 1,
        den: 1,
      },
    );
  });

  test("is wrong when it misread or missed it", () => {
    assert.deepEqual(
      printedPageAccuracy(page({ printed_page: 7 }), page({ printed_page: 1 })),
      {
        num: 0,
        den: 1,
      },
    );
    assert.deepEqual(
      printedPageAccuracy(
        page({ printed_page: 7 }),
        page({ printed_page: null }),
      ),
      {
        num: 0,
        den: 1,
      },
    );
  });

  test("an unnumbered page read as unnumbered is right", () => {
    assert.deepEqual(
      printedPageAccuracy(
        page({ printed_page: null }),
        page({ printed_page: null }),
      ),
      { num: 1, den: 1 },
    );
  });
});

describe("LaTeX KaTeX-parse rate", () => {
  test("counts every math span the reader wrote, and how many KaTeX parses", () => {
    const predicted = page({
      stimuli: [stimulus("x1", "إذا كانت $v = 20\\ \\text{m/s}$ فأجب")], // parses
      questions: [
        question({
          id: "p1",
          text: "احسب $\\frac{1}{2} m v^2$ عندما", // parses
          options: [
            { key: "أ", text: "$5\\ \\text{m/s}^2$" }, // parses
            { key: "ب", text: "$\\frac{1}{$" }, // broken
            { key: "ج", text: "السعر \\$5 فقط" }, // an escaped dollar, not math
          ],
        }),
      ],
      explanation: [
        {
          heading: "القانون الثاني",
          // Display math parses; \( \) inline math uses an unknown command.
          markdown: "$$F = ma$$ ثم \\(\\notacommand{x}\\)",
          crop: null,
        },
      ],
    });

    assert.deepEqual(latexParseRate(predicted), { num: 4, den: 6 });
  });

  test("a page without math measures nothing", () => {
    assert.deepEqual(latexParseRate(page()), { num: 0, den: 0 });
  });
});

describe("cost per page", () => {
  test("adds one page's logged cost", () => {
    assert.deepEqual(
      costPerPage({ input_tokens: 1800, output_tokens: 600, cost_usd: 0.0042 }),
      {
        num: 0.0042,
        den: 1,
      },
    );
  });
});
