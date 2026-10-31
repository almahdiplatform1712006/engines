// npm run setup:env — asks for the OpenRouter key (and the voice model) and
// writes them into .env under the right names, creating .env from
// .env.example when it is missing. The key is never printed back.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setLine } from "../shared/env-file.ts";

const ENV = ".env";

async function main(): Promise<number> {
  const exists = await readFile(ENV).then(
    () => true,
    () => false,
  );
  if (!exists) await copyFile(".env.example", ENV);
  const lines = createInterface({ input: process.stdin })[
    Symbol.asyncIterator
  ]();
  const ask = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    const next = await lines.next();
    return next.done ? "" : next.value.trim();
  };
  const key = await ask("Paste your OpenRouter key (sk-or-…): ");
  if (!key.startsWith("sk-or-")) {
    console.error(
      "\nThat does not look like an OpenRouter key. Nothing was changed.",
    );
    return 1;
  }
  const model = await ask(
    "Voice model (Enter to skip; list them with `npm run video -- --models`): ",
  );
  let text = await readFile(ENV, "utf8");
  text = setLine(text, "OPENROUTER_API_KEY", key);
  if (model) text = setLine(text, "TTS_MODEL", model);
  await writeFile(ENV, text);
  console.log(
    `Saved to .env: OPENROUTER_API_KEY${model ? " and TTS_MODEL" : ""}.`,
  );
  return 0;
}

process.exitCode = await main();
