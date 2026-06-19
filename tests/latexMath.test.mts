import assert from "node:assert/strict";
import test from "node:test";
import { renderLatexCommandText } from "../app/lib/latexMath.ts";

test("renderLatexCommandText hides transparent TeX delimiter commands", () => {
  assert.equal(renderLatexCommandText("left"), null);
  assert.equal(renderLatexCommandText("right"), null);
});

test("renderLatexCommandText maps supported math symbols and keeps unknown operators readable", () => {
  assert.equal(renderLatexCommandText("sum"), "∑");
  assert.equal(renderLatexCommandText("ln"), "ln");
  assert.equal(renderLatexCommandText("exp"), "exp");
});
