import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { cropImage } from "./crop.ts";

const page = () =>
  sharp({
    create: { width: 1000, height: 2000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();

test("crops the box with padding, clamped to the page", async () => {
  const crop = await cropImage(
    await page(),
    { x: 0.1, y: 0.1, w: 0.5, h: 0.25 },
    0.01,
  );
  assert.deepEqual(
    await sharp(crop)
      .metadata()
      .then((m) => [m.width, m.height]),
    [520, 540],
  );

  const edge = await cropImage(
    await page(),
    { x: 0, y: 0.9, w: 1, h: 0.1 },
    0.05,
  );
  assert.deepEqual(
    await sharp(edge)
      .metadata()
      .then((m) => [m.width, m.height]),
    [1000, 300],
  );
});

test("an empty box is refused", async () => {
  await assert.rejects(
    cropImage(await page(), { x: 0.5, y: 0.5, w: 0, h: 0 }, 0),
  );
});
