import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { draftBook } from "./draft.ts";
import { stubReader } from "./reader.ts";
import { PageTruth } from "./truth.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "engines-golden-"));
  await mkdir(join(root, "physics-g10", "images"), { recursive: true });
  await writeFile(
    join(root, "physics-g10", "manifest.json"),
    JSON.stringify({
      book: "physics-g10",
      title: "الفيزياء — الصف الأول الثانوي",
      pages: [
        { id: "p011", pdf_page: 11, image: "p011.png" },
        { id: "p093", pdf_page: 93, image: "p093.png" },
      ],
    }),
  );
  // Stand-in bytes: the stub reader never looks inside the image.
  await writeFile(
    join(root, "physics-g10", "images", "p011.png"),
    "not a real page",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readTruth(pageId: string): Promise<PageTruth> {
  const raw = await readFile(
    join(root, "physics-g10", "truth", `${pageId}.json`),
    "utf8",
  );
  return PageTruth.parse(JSON.parse(raw));
}

describe("draftBook", () => {
  test("writes a draft truth file for a sample page with the stub reader", async () => {
    const report = await draftBook({
      root,
      book: "physics-g10",
      reader: stubReader,
    });

    const truth = await readTruth("p011");
    assert.equal(truth.status, "draft");
    assert.equal(truth.pdf_page, 11);
    assert.deepEqual(report.written, ["p011"]);
  });

  test("reports a page whose image is missing instead of skipping it silently", async () => {
    const report = await draftBook({
      root,
      book: "physics-g10",
      reader: stubReader,
    });

    assert.deepEqual(report.failures, [
      { page: "p093", reason: "image_missing" },
    ]);
  });

  test("never overwrites a truth file the owner has corrected", async () => {
    await draftBook({ root, book: "physics-g10", reader: stubReader });
    const corrected = {
      ...(await readTruth("p011")),
      status: "corrected",
      printed_page: 7,
    };
    await writeFile(
      join(root, "physics-g10", "truth", "p011.json"),
      JSON.stringify(corrected),
    );

    const report = await draftBook({
      root,
      book: "physics-g10",
      reader: stubReader,
      force: true,
    });

    assert.deepEqual(report.kept, ["p011"]);
    assert.equal((await readTruth("p011")).printed_page, 7);
  });

  test("keeps an existing draft unless forced, since the owner may be halfway through it", async () => {
    await draftBook({ root, book: "physics-g10", reader: stubReader });

    assert.deepEqual(
      (await draftBook({ root, book: "physics-g10", reader: stubReader })).kept,
      ["p011"],
    );
    assert.deepEqual(
      (
        await draftBook({
          root,
          book: "physics-g10",
          reader: stubReader,
          force: true,
        })
      ).written,
      ["p011"],
    );
  });

  test("reads a truth file saved with a byte-order mark, as Windows editors do", async () => {
    await draftBook({ root, book: "physics-g10", reader: stubReader });
    const corrected = { ...(await readTruth("p011")), status: "corrected" };
    await writeFile(
      join(root, "physics-g10", "truth", "p011.json"),
      String.fromCodePoint(0xfeff) + JSON.stringify(corrected),
    );

    assert.deepEqual(
      (
        await draftBook({
          root,
          book: "physics-g10",
          reader: stubReader,
          force: true,
        })
      ).kept,
      ["p011"],
    );
  });

  test("leaves a broken truth file alone and reports it, naming the file", async () => {
    await mkdir(join(root, "physics-g10", "truth"), { recursive: true });
    await writeFile(
      join(root, "physics-g10", "truth", "p011.json"),
      "{ not json",
    );

    const report = await draftBook({
      root,
      book: "physics-g10",
      reader: stubReader,
      force: true,
    });

    const failure = report.failures.find((f) => f.page === "p011");
    assert.ok(failure);
    assert.equal(failure.reason, "invalid_truth");
    assert.match(failure.detail ?? "", /p011\.json/);
    assert.equal(
      await readFile(join(root, "physics-g10", "truth", "p011.json"), "utf8"),
      "{ not json",
    );
  });

  test("refuses a manifest that doesn't match the format", async () => {
    await writeFile(
      join(root, "physics-g10", "manifest.json"),
      JSON.stringify({ book: "physics-g10" }),
    );

    await assert.rejects(
      draftBook({ root, book: "physics-g10", reader: stubReader }),
      /manifest/,
    );
  });
});
