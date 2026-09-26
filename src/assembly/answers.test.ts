import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  answerFor,
  matchAnswerKey,
  normaliseNumber,
  type AnswerEntry,
  type AnswerQuestion,
} from "./answers.ts";

const mcqQ = (
  id: string,
  node: string,
  number: string,
  keys = ["أ", "ب", "ج", "د"],
): AnswerQuestion => ({
  id,
  node_id: node,
  number,
  type: "multiple_choice",
  options: keys.map((key) => ({ key, text: `option ${key}` })),
});

describe("normaliseNumber", () => {
  test("digits in any script and printed decoration", () => {
    assert.equal(normaliseNumber("٣"), "3");
    assert.equal(normaliseNumber("(12)"), "12");
    assert.equal(normaliseNumber("س٤-"), "4");
    assert.equal(normaliseNumber("Q 7."), "7");
    assert.equal(normaliseNumber("أ"), null);
  });
});

describe("answerFor", () => {
  test("an Arabic option letter", () => {
    assert.deepEqual(answerFor("ب", mcqQ("q", "l", "1")), {
      correct: ["ب"],
      accepted_answers: [],
    });
  });

  test("a Latin letter for Arabic options, and the reverse, when the book mixes them", () => {
    assert.deepEqual(answerFor("c", mcqQ("q", "l", "1")), {
      correct: ["ج"],
      accepted_answers: [],
    });
    assert.deepEqual(
      answerFor("(د)", mcqQ("q", "l", "1", ["a", "b", "c", "d"])),
      {
        correct: ["d"],
        accepted_answers: [],
      },
    );
  });

  test("the option's text instead of its letter", () => {
    assert.deepEqual(answerFor("option ج", mcqQ("q", "l", "1")), {
      correct: ["ج"],
      accepted_answers: [],
    });
  });

  test("true/false in words", () => {
    const tf: AnswerQuestion = {
      id: "q",
      node_id: "l",
      number: "1",
      type: "true_false",
      options: [
        { key: "صح", text: "صح" },
        { key: "خطأ", text: "خطأ" },
      ],
    };
    assert.deepEqual(answerFor("خطا", tf), {
      correct: ["خطأ"],
      accepted_answers: [],
    });
    assert.deepEqual(answerFor("True", tf), {
      correct: ["صح"],
      accepted_answers: [],
    });
  });

  test("fill in the blank takes the answer as written", () => {
    const blank: AnswerQuestion = {
      id: "q",
      node_id: "l",
      number: "1",
      type: "fill_blank",
      options: [],
    };
    assert.deepEqual(answerFor(" $9.8\\ m/s^2$ ", blank), {
      correct: [],
      accepted_answers: ["$9.8\\ m/s^2$"],
    });
  });

  test("an answer that is none of the options is no answer", () => {
    assert.equal(answerFor("هـ", mcqQ("q", "l", "1")), null);
  });
});

describe("matchAnswerKey", () => {
  const questions = [
    mcqQ("q1", "l1", "1"),
    mcqQ("q2", "l1", "2"),
    mcqQ("q1b", "l2", "1"),
  ];
  const lessonOf = (section: string | null) =>
    section === null ? null : section.includes("الثاني") ? "l2" : "l1";

  test("by lesson and question number, with mixed numbering", () => {
    const entries: AnswerEntry[] = [
      { section: "الدرس الأول", number: "١", answer: "ب" },
      { section: "الدرس الأول", number: "2", answer: "d" },
      { section: "الدرس الثاني", number: "(1)", answer: "أ" },
    ];
    assert.deepEqual(
      Object.fromEntries(matchAnswerKey(entries, questions, lessonOf).answers),
      {
        q1: { correct: ["ب"], accepted_answers: [] },
        q2: { correct: ["د"], accepted_answers: [] },
        q1b: { correct: ["أ"], accepted_answers: [] },
      },
    );
  });

  test("an answer naming no option, and an entry matching no question, are reported", () => {
    const match = matchAnswerKey(
      [
        { section: "الدرس الأول", number: "1", answer: "هـ" },
        { section: "الدرس الأول", number: "9", answer: "أ" },
      ],
      questions,
      lessonOf,
    );
    assert.deepEqual([...match.answers], []);
    assert.deepEqual([...match.mismatched], [["q1", "هـ"]]);
    assert.deepEqual(
      match.unmatched.map((e) => e.number),
      ["9"],
    );
  });

  test("without a lesson, only a number that is unique in the book matches", () => {
    const entries: AnswerEntry[] = [
      { section: null, number: "1", answer: "ب" },
      { section: null, number: "2", answer: "ج" },
    ];
    assert.deepEqual(
      Object.fromEntries(matchAnswerKey(entries, questions, lessonOf).answers),
      {
        q2: { correct: ["ج"], accepted_answers: [] },
      },
    );
  });
});
