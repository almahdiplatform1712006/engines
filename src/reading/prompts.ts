// Instructions sent with each page image. Kept apart from the call code so the
// golden-set trial can compare prompt changes.

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
