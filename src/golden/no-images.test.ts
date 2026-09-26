// Golden page images are copyright and must never be committed (E-03).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const IMAGE = /\.(png|jpe?g|webp|tiff?|gif|bmp|pdf)$/i;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

describe("golden set images", () => {
  test("no image or PDF under golden/ is tracked by git", () => {
    const tracked = git("ls-files", "golden")
      .split("\n")
      .filter((path) => IMAGE.test(path));
    assert.deepEqual(tracked, []);
  });

  test("git ignores a page image dropped into a book folder", () => {
    for (const path of [
      "golden/physics-g10/images/p011.png",
      "golden/physics-g10/images/scan",
      "golden/physics-g10/p011.jpg",
      "golden/physics-g10/sheet.html",
    ]) {
      // check-ignore exits non-zero (and execFileSync throws) when the path is not ignored.
      assert.doesNotThrow(
        () => git("check-ignore", "--no-index", "-q", path),
        `${path} is not ignored`,
      );
    }
  });
});
