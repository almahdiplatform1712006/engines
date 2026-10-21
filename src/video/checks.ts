// The checks a lesson passes before a person reviews it (the `auto_checked`
// step): what a script can get wrong that code can see. An error blocks the
// step; a warning goes to the reviewer.
import temml from "temml";
import { splitMath } from "../shared/math-spans.ts";
import type { Lesson, Scene } from "./schema.ts";
import { splitSentences } from "./timing.ts";

export interface Finding {
  level: "error" | "warning";
  scene_id?: string;
  message: string;
}

/** One voice take is one request; a scene past this is too long to say in one go. */
const MAX_NARRATION_CHARS = 1200;

export function checkLesson(lesson: Lesson): Finding[] {
  return lesson.scenes.flatMap(checkScene);
}

function checkScene(scene: Scene): Finding[] {
  const found: Finding[] = [];
  const add = (level: Finding["level"], message: string) => {
    found.push({ level, scene_id: scene.id, message });
  };
  const spoken = scene.narration_tts ?? scene.narration;
  if (splitSentences(spoken).length === 0)
    add("error", "The narration has nothing to say.");
  if (spoken.length > MAX_NARRATION_CHARS)
    add(
      "warning",
      "The narration is long; split the scene so each take stays short.",
    );
  const letters = spoken.match(/\p{L}/gu) ?? [];
  const latin = spoken.match(/\p{Script=Latin}/gu) ?? [];
  if (letters.length > 0 && latin.length / letters.length > 0.3)
    add(
      "warning",
      "Much of the narration is not Arabic: the voice may mispronounce it.",
    );
  if (/[$\\]/.test(spoken))
    add(
      "error",
      "The narration has maths markup; the voice would read it out.",
    );

  if (scene.type === "figure" && /^([/\\]|[a-z]:|.*\.\.)/i.test(scene.image))
    add(
      "error",
      "The figure must be a file next to the lesson, not a path outside it.",
    );
  if (scene.type === "equation_steps") {
    scene.steps.forEach((step, i) => {
      if (!latexReads(step.latex))
        add("error", `Step ${String(i + 1)} is not valid LaTeX.`);
    });
  }
  for (const text of onScreenText(scene))
    for (const piece of splitMath(text))
      if (piece.kind === "math" && !latexReads(piece.tex))
        add("error", `On-screen maths is not valid LaTeX: ${piece.tex}`);
  return found;
}

function latexReads(tex: string): boolean {
  try {
    temml.renderToString(tex, { throwOnError: true });
    return true;
  } catch {
    return false;
  }
}

function onScreenText(scene: Scene): string[] {
  switch (scene.type) {
    case "title":
      return [scene.title, ...(scene.subtitle ? [scene.subtitle] : [])];
    case "bullets":
      return [scene.title, ...scene.bullets];
    case "figure":
      return [scene.title, ...scene.callouts];
    case "equation_steps":
      return [
        scene.title,
        ...scene.steps.flatMap((s) => (s.note ? [s.note] : [])),
      ];
  }
}
