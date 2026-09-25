// Instructions sent with each page image. Kept apart from the call code so the
// golden-set trial can compare prompt changes.

export const READ_NUMBER = `This is one page of a book, as an image. Return the page number printed on it (usually in a corner or at the bottom centre), exactly as printed, including Arabic-Indic digits. Return null if there is no printed page number. Ignore chapter, lesson, question and figure numbers.`;

/** Step 4. The halves are described so the model knows which block to join. */
export function readPair(
  first: { page: number; kind: string; text: string },
  second: { page: number; text: string },
): string {
  return `You are reading two consecutive pages of a school book, as two images: page ${String(first.page)} then page ${String(second.page)}.

A ${first.kind} starts at the bottom of page ${String(first.page)} and continues at the top of page ${String(second.page)}.
It starts: «${first.text.slice(0, 300)}»
It continues: «${second.text.slice(0, 300)}»

Return that one ${first.kind}, whole and joined, as the only block in the entry for page ${String(first.page)}. Leave the entry for page ${String(second.page)} with no blocks. Follow the same rules as for a single page: copy text exactly, math as LaTeX, options with their printed labels, box_2d on page ${String(first.page)}.`;
}

export const SOLVE = `You are answering one question from a school book. Work it out carefully.
For a multiple-choice or true/false question, return in "correct" the key(s) of the right option(s), exactly as given. For a fill-in-the-blank question, return in "accepted_answers" the answer(s) that fill the blank, with math as LaTeX, and leave "correct" empty.`;

export function solvePrompt(question: {
  type: string;
  text: string;
  options: readonly { key: string; text: string }[];
  stimulus: string | null;
}): string {
  const parts = [];
  if (question.stimulus)
    parts.push(
      `Passage or figure the question refers to:\n${question.stimulus}`,
    );
  parts.push(`Question (${question.type}):\n${question.text}`);
  if (question.options.length > 0) {
    parts.push(
      `Options:\n${question.options.map((o) => `${o.key}) ${o.text}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export const READ_PAGE = `You are reading one page of a school book, as an image. The book may be Arabic (right-to-left), English, or both.

Return every block on the page, in reading order, labelled:
- heading: a unit, lesson or section title.
- question: one exercise a student answers (multiple choice, fill in the blank, or true/false). Put the stem in "text" and each option in "options" with its printed label.
- explanation: teaching text.
- passage: a reading passage, diagram or table that several questions share.
- answer_key: a list of answers to questions (for example at the back of the book).
- neither: anything else (headers, footers, page furniture, decorative pictures).

Rules:
- Copy text exactly as printed. Never translate, summarise or correct it.
- Write math as LaTeX inside $…$ (inline) or $$…$$ (display), copied exactly as printed, and set math_direction to the direction it is written in.
- printed_page is the page number printed on the page (often in a corner), exactly as printed, or null when there is none.
- Set continues on the last block only if it is cut off at the bottom and continues on the next page. Set continued_from on the first block only if it clearly continues from the previous page.
- In "marked", list option labels that are visibly marked by hand (circled, ticked, filled). Leave it empty when nothing is marked.
- Give a box_2d for every block you can locate: [ymin, xmin, ymax, xmax] on a 0–1000 scale.
- Fields that don't apply to a block are null or empty.`;

export const READ_CONTENTS = `You are reading one page of a school syllabus or a book's table of contents, as an image. It may be Arabic (right-to-left), English, or both.

Return every entry on the page, in reading order: each unit, chapter, lesson or section it lists.
- name: the entry's title, copied exactly as printed (without its page number or dot leaders). Never translate or correct it.
- depth: 1 for the outermost level on the page (for example a unit), 2 for entries inside it (a lesson), 3 inside those, and so on. Use indentation, numbering and type size to tell levels apart.
- level: the word the page uses for this level, such as "الوحدة", "الدرس", "Chapter" or "Lesson", or null when there is none.
- page: the page number the entry starts on, exactly as printed (Arabic-Indic digits too), or null when the page doesn't give one.
- page_to: the page it ends on, only when the page prints a range (such as "12–20"); otherwise null.
- answer_key: true only for the book's answers section (such as "الإجابات" or "Answer key").
Leave out the page's own title, headers, footers and anything that isn't an entry.`;
