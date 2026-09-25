// E-16: a tree drafted from each kind of syllabus: a PDF, photos, and the
// contents pages inside the book (whose upload then runs the document).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { startHarness, type Harness } from "../../test/harness.ts";
import { makePdf } from "../../test/pdf.ts";
import type { Outline } from "../contract/outline.ts";
import type { ContentsEntry } from "../outline/draft.ts";
import type { PageReader } from "../reading/reader.ts";
import { scriptedReader } from "../reading/scripted.ts";

const entry = (
  name: string,
  depth: number,
  from: number | null,
  more: Partial<ContentsEntry> = {},
): ContentsEntry => ({
  name,
  depth,
  level: depth === 1 ? "الوحدة" : "الدرس",
  from,
  to: null,
  answerKey: false,
  ...more,
});

// Every syllabus in these tests reads the same: two contents pages, and a
// third that can't be read at all.
const reader = scriptedReader({
  pages: {},
  contents: {
    1: [
      entry("الوحدة الأولى", 1, 1),
      entry("الدرس الأول", 2, 1),
      entry("الدرس الثاني", 2, 3),
    ],
    2: [entry("الوحدة الثانية", 1, 5, { to: 6 })],
  },
  contentsFailures: [3],
});

let current: PageReader = reader;
let h: Harness;
before(async () => {
  h = await startHarness({ reader: () => current });
});
after(() => h.close());

async function drafted(response: Response): Promise<Outline> {
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const { id } = JSON.parse(text) as Outline;
  // A page that can't be read is retried with the job before it counts as failed.
  for (let i = 0; i < 300; i++) {
    const outline = (await (
      await h.call("GET", `/v1/outlines/${id}`)
    ).json()) as Outline;
    if (outline.drafting?.status !== "running") return outline;
    await sleep(100);
  }
  throw new Error(`outline ${id} still drafting`);
}

const shape = (nodes: Outline["nodes"]): unknown =>
  nodes.map((n) => [
    n.name,
    n.level,
    n.printed_pages && [n.printed_pages.from, n.printed_pages.to],
    ...(n.children.length > 0 ? [shape(n.children)] : []),
  ]);

const EXPECTED = [
  [
    "الوحدة الأولى",
    "الوحدة",
    [1, 4],
    [
      ["الدرس الأول", "الدرس", [1, 2]],
      ["الدرس الثاني", "الدرس", [3, 4]],
    ],
  ],
  ["الوحدة الثانية", "الوحدة", [5, 6]],
];

const photo = (shade: number) =>
  sharp({
    create: {
      width: 600,
      height: 800,
      channels: 3,
      background: { r: shade, g: shade, b: shade },
    },
  })
    .png()
    .toBuffer();

describe("drafting a tree", () => {
  test("from a syllabus PDF: one read per page, ranges inferred, pages shown", async () => {
    const upload = await h.upload(
      makePdf(["contents 1", "contents 2"]),
      "application/pdf",
      "syllabus.pdf",
    );
    const outline = await drafted(
      await h.call("POST", "/v1/outlines", {
        source: { type: "pdf", upload_id: upload },
      }),
    );
    assert.deepEqual(outline.drafting, {
      status: "done",
      pages: 2,
      pages_read: 2,
      failures: [],
    });
    assert.deepEqual(shape(outline.nodes), EXPECTED);
    assert.equal(outline.status, "draft");
    assert.deepEqual(outline.errors, []);
    assert.equal(outline.source_pages.length, 2);
    for (const page of outline.source_pages) {
      const image = await h.app.request(
        new URL(page.image_url ?? "").pathname +
          new URL(page.image_url ?? "").search,
      );
      assert.equal(image.status, 200, "the syllabus page image is served");
    }

    const confirmed = await h.call(
      "POST",
      `/v1/outlines/${outline.id}/confirm`,
    );
    assert.equal(confirmed.status, 200);
  });

  test("from photos, in order", async () => {
    const uploads = [
      await h.upload(await photo(250), "image/png", "1.png"),
      await h.upload(await photo(240), "image/png", "2.png"),
    ];
    const outline = await drafted(
      await h.call("POST", "/v1/outlines", {
        source: { type: "images", upload_ids: uploads },
      }),
    );
    assert.equal(outline.drafting?.status, "done");
    assert.deepEqual(shape(outline.nodes), EXPECTED);
  });

  test("from the book's own contents pages; the same upload then runs the book", async () => {
    const book = await h.upload(
      makePdf(["cover", "contents 1", "contents 2", "p1", "p2", "p3", "p4"]),
      "application/pdf",
    );
    const outline = await drafted(
      await h.call("POST", "/v1/outlines", {
        source: { type: "book_pages", upload_id: book, from: 2, to: 3 },
      }),
    );
    assert.deepEqual(shape(outline.nodes), EXPECTED);
    assert.equal(
      (await h.call("POST", `/v1/outlines/${outline.id}/confirm`)).status,
      200,
    );
    const document = await h.call("POST", "/v1/documents", {
      outline_id: outline.id,
      type: "questions",
      source: { upload_id: book },
    });
    assert.equal(document.status, 202, await document.clone().text());
  });

  test("a page that can't be read is reported; the tree drafts from the rest", async () => {
    const upload = await h.upload(
      makePdf(["c1", "c2", "c3"]),
      "application/pdf",
    );
    const outline = await drafted(
      await h.call("POST", "/v1/outlines", {
        source: { type: "pdf", upload_id: upload },
      }),
    );
    assert.equal(outline.drafting?.status, "done");
    assert.equal(outline.drafting.pages_read, 3);
    assert.deepEqual(
      outline.drafting.failures.map((f) => f.page),
      [3],
    );
    assert.deepEqual(shape(outline.nodes), EXPECTED);
  });

  test("when no page can be read, drafting failed and the tree is empty to fill in", async (t) => {
    const book = await h.upload(makePdf(["a", "b", "c"]), "application/pdf");
    current = scriptedReader({ pages: {}, contentsFailures: [1] });
    t.after(() => {
      current = reader;
    });
    const outline = await drafted(
      await h.call("POST", "/v1/outlines", {
        source: { type: "book_pages", upload_id: book, from: 3, to: 3 },
      }),
    );
    assert.equal(outline.drafting?.status, "failed");
    assert.deepEqual(outline.nodes, []);
    const filled = await h.call("PUT", `/v1/outlines/${outline.id}`, {
      nodes: [{ name: "L1", printed_pages: { from: 1, to: 3 } }],
    });
    assert.equal(filled.status, 200);
  });
});

describe("what's refused", () => {
  test("a syllabus PDF over 30 pages, contents pages past the book's end, a photo as a PDF", async () => {
    const big = await h.upload(
      makePdf(Array.from({ length: 31 }, (_, i) => `p${String(i)}`)),
      "application/pdf",
    );
    const tooBig = await h.call("POST", "/v1/outlines", {
      source: { type: "pdf", upload_id: big },
    });
    assert.equal(tooBig.status, 413);

    const book = await h.upload(makePdf(["a", "b"]), "application/pdf");
    const past = await h.call("POST", "/v1/outlines", {
      source: { type: "book_pages", upload_id: book, from: 2, to: 4 },
    });
    assert.equal(past.status, 400);

    const png = await h.upload(await photo(200), "image/png", "p.png");
    const wrong = await h.call("POST", "/v1/outlines", {
      source: { type: "pdf", upload_id: png },
    });
    assert.equal(wrong.status, 400);

    const inverted = await h.call("POST", "/v1/outlines", {
      source: { type: "book_pages", upload_id: book, from: 2, to: 1 },
    });
    assert.equal(inverted.status, 400);
  });

  test("editing or confirming while drafting runs is 409; a confirmed outline is frozen", async () => {
    const created = await h.call("POST", "/v1/outlines", {
      source: {
        type: "manual",
        nodes: [{ name: "L1", printed_pages: { from: 1, to: 2 } }],
      },
    });
    const { id } = (await created.json()) as Outline;
    await h.db.query("UPDATE outlines SET drafting = 'running' WHERE id = $1", [
      id,
    ]);
    const put = await h.call("PUT", `/v1/outlines/${id}`, {
      nodes: [{ name: "L2" }],
    });
    assert.equal(put.status, 409);
    assert.equal(
      (await h.call("POST", `/v1/outlines/${id}/confirm`)).status,
      409,
    );

    await h.db.query("UPDATE outlines SET drafting = 'done' WHERE id = $1", [
      id,
    ]);
    assert.equal(
      (await h.call("POST", `/v1/outlines/${id}/confirm`)).status,
      200,
    );
    const frozen = await h.call("PUT", `/v1/outlines/${id}`, {
      nodes: [{ name: "L2" }],
    });
    assert.equal(frozen.status, 409);
  });
});

test("a starting tree keeps its external_ref through edits", async () => {
  const created = (await (
    await h.call("POST", "/v1/outlines", {
      source: {
        type: "manual",
        nodes: [
          {
            id: "u1",
            name: "Unit",
            external_ref: "almahdi:unit:7",
            children: [
              { id: "l1", name: "Lesson", external_ref: "almahdi:lesson:9" },
            ],
          },
        ],
      },
    })
  ).json()) as Outline;
  assert.equal(created.nodes[0]?.external_ref, "almahdi:unit:7");
  const [unit] = created.nodes;
  assert.ok(unit);
  const edited = (await (
    await h.call("PUT", `/v1/outlines/${created.id}`, {
      nodes: [
        {
          ...unit,
          name: "Unit, renamed",
          printed_pages: { from: 1, to: 9 },
          children: [
            { ...unit.children[0], printed_pages: { from: 1, to: 5 } },
            { name: "A new lesson", printed_pages: { from: 6, to: 9 } },
          ],
        },
      ],
    })
  ).json()) as Outline;
  const [renamed] = edited.nodes;
  assert.equal(renamed?.external_ref, "almahdi:unit:7");
  assert.equal(renamed.children[0]?.external_ref, "almahdi:lesson:9");
  assert.equal(renamed.children[1]?.external_ref, null);
});

test("drafting needs credits for its pages, and at most three run at once", async () => {
  const broke = await h.newKey("No credits", 0);
  const pdf = makePdf(["c1"]);
  const created = await h.call(
    "POST",
    "/v1/uploads",
    { filename: "s.pdf", content_type: "application/pdf", size: pdf.length },
    broke.key,
  );
  const { id, upload_url } = (await created.json()) as {
    id: string;
    upload_url: string;
  };
  await h.app.request(
    new URL(upload_url).pathname + new URL(upload_url).search,
    {
      method: "PUT",
      body: pdf,
    },
  );
  const refused = await h.call(
    "POST",
    "/v1/outlines",
    { source: { type: "pdf", upload_id: id } },
    broke.key,
  );
  assert.equal(refused.status, 402);

  await h.db.query(
    "UPDATE outlines SET drafting = 'running' WHERE id IN (SELECT id FROM outlines WHERE org_id = $1 AND drafting = 'done' LIMIT 3)",
    [h.orgId],
  );
  const busy = await h.call("POST", "/v1/outlines", {
    source: { type: "pdf", upload_id: await h.upload(pdf, "application/pdf") },
  });
  assert.equal(busy.status, 429);
});
