import assert from "node:assert/strict";
import { test } from "node:test";
import { setLine } from "./env-file.ts";

test("an empty line is filled, a set line replaced, a missing line added", () => {
  assert.equal(setLine("A=1\nKEY=\nB=2\n", "KEY", "x"), "A=1\nKEY=x\nB=2\n");
  assert.equal(setLine("KEY=old\n", "KEY", "new"), "KEY=new\n");
  assert.equal(setLine("A=1", "KEY", "x"), "A=1\nKEY=x\n");
  assert.equal(
    setLine("KEY=a\nKEY_TWO=b\n", "KEY", "$&"),
    "KEY=$&\nKEY_TWO=b\n",
  );
});
