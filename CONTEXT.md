# Engines — domain language

The words below mean one thing each, in code, tests, tickets and docs. Spec #1 is the source; this page pins the vocabulary.

| Term                     | Meaning                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Organisation** (`org`) | A customer. Everything Engines stores carries `org_id`, and one organisation never sees another's data. Almahdi is one organisation.                                                       |
| **API key**              | A bearer key belonging to one organisation. Hashed at rest, revocable. Carries a concurrency cap and a model provider setting.                                                             |
| **Outline**              | The customer's syllabus tree for one book. `draft → confirmed → in_use`. Only a confirmed outline can run a document.                                                                      |
| **Node**                 | One entry of an outline (unit, lesson, …) with a name, a level label, a **printed** page range and a `kind` (`content` or `answer_key`). May carry the customer's `external_ref`.          |
| **Printed page**         | The page number as printed on the page (what a contents page shows). Node ranges are always printed pages.                                                                                 |
| **PDF page**             | The 1-based position of a page in the uploaded file (or the photo's position in the ordered list). Pipeline storage is keyed by PDF page.                                                  |
| **Offset segment**       | One piece of the printed → PDF mapping: from `printed_from` on, `pdf = printed + (pdf_from - printed_from)`, until the next segment. A book has one or more.                               |
| **Quick pass**           | Step 1b: reading only the printed number on ≤ ~50 sampled pages to propose offset segments before the full read.                                                                           |
| **Upload**               | Bytes put straight into storage through a resumable session. A document or a syllabus refers to it by `upload_id`.                                                                         |
| **Document**             | One job: a book run against a confirmed outline. `queued → rendering → awaiting_offset → processing →` then `completed`, `completed_with_errors` or `failed`, then gone (`410`) at day 30. |
| **Page reading**         | What the model returned for one PDF page: printed number and labelled **blocks**. Stored per page, reused by every later step.                                                             |
| **Block**                | One labelled region of a page (`heading`, `question`, `explanation`, `passage`, `answer_key` or `neither`), in reading order, with an optional crop box and continuation flags.            |
| **Pair re-read**         | Step 4: one model call over two consecutive pages whose block runs across the break.                                                                                                       |
| **Placement**            | Deciding the node for a block, by code only, from page ranges, offset segments and headings (hard rule 4).                                                                                 |
| **Stimulus**             | A passage, diagram or table stored once and referenced by several questions through `stimulus_id`.                                                                                         |
| **Answer source**        | Where a question's answer came from: `book` (answer-key node), `marked` (hand mark on the page) or `model` (Engines solved it, always flagged).                                            |
| **Explanation chunk**    | A heading-bounded piece of teaching text in Markdown + LaTeX, placed under a node. Only for organisations with the `explanation` entitlement.                                              |
| **Flag**                 | `review_required: true` plus a `review_reason` on an item. Never blocks anything.                                                                                                          |
| **Failure**              | Something attempted and not delivered, with a reason (`unmapped_page`, `offset_break`, `image_unreadable`, `incomplete_question`, `part_failed`).                                          |
| **Skipped**              | Blocks deliberately not delivered, counted: `neither` and `off_type` (for example explanation blocks in a `questions` document).                                                           |
| **Result**               | The finished document object (§3 shape). Stored as numbered **revisions**: revision 1 is the pipeline's output, each review save adds one.                                                 |
| **Credit**               | One page of processing. Granted by hand into the **credit ledger**; a finished document writes one usage entry.                                                                            |
| **Entitlement**          | A switch on an organisation (today only `explanation`).                                                                                                                                    |
