import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  linkStimuli,
  type LinkQuestion,
  type LinkStimulus,
} from "./stimuli.ts";

let order = 0;
function stim(id: string, fields: Partial<LinkStimulus> = {}): LinkStimulus {
  return {
    id,
    node_id: "l1",
    pdf_page: 10,
    order: order++,
    label: null,
    covers: null,
    ...fields,
  };
}
function q(id: string, fields: Partial<LinkQuestion> = {}): LinkQuestion {
  return {
    id,
    node_id: "l1",
    pdf_page: 10,
    order: order++,
    number: null,
    stimulus_label: null,
    ...fields,
  };
}
const links = (questions: LinkQuestion[], stimuli: LinkStimulus[]) =>
  Object.fromEntries(
    [...linkStimuli(questions, stimuli)].map(([id, l]) => [
      id,
      [l.stimulus_id, l.uncertain],
    ]),
  );

describe("linkStimuli", () => {
  test("a passage that names the questions it covers links them, even on the next page", () => {
    const passage = stim("s1", { covers: { from: "١٢", to: "14" } });
    const questions = [
      q("q12", { number: "12" }),
      q("q13", { number: "13", pdf_page: 11 }),
      q("q14", { number: "14", pdf_page: 11 }),
      q("q15", { number: "15", pdf_page: 11 }),
    ];
    assert.deepEqual(links(questions, [passage]), {
      q12: ["s1", false],
      q13: ["s1", false],
      q14: ["s1", false],
    });
  });

  test("a question naming a figure's label links to that figure", () => {
    const fig2 = stim("s2", { label: "Figure 2" });
    const fig3 = stim("s3", { label: "Figure 3" });
    assert.deepEqual(
      links([q("q1", { stimulus_label: "use figure 3" })], [fig2, fig3]),
      {
        q1: ["s3", false],
      },
    );
  });

  test("an instruction with one stimulus above links to it", () => {
    const passage = stim("s1");
    assert.deepEqual(
      links([q("q1", { stimulus_label: "اقرأ النص ثم أجب" })], [passage]),
      {
        q1: ["s1", false],
      },
    );
  });

  test("two candidate stimuli on the page: the nearest above, flagged uncertain", () => {
    const a = stim("s1");
    const b = stim("s2");
    assert.deepEqual(
      links([q("q1", { stimulus_label: "use the figure above" })], [a, b]),
      {
        q1: ["s2", true],
      },
    );
  });

  test("no hint and no range: no link", () => {
    assert.deepEqual(links([q("q1", { number: "3" })], [stim("s1")]), {});
  });

  test("stimuli in another node or pages away aren't candidates", () => {
    const far = stim("s1", { pdf_page: 2 });
    const other = stim("s2", { node_id: "l2" });
    assert.deepEqual(
      links([q("q1", { stimulus_label: "the passage" })], [far, other]),
      {},
    );
  });
});
