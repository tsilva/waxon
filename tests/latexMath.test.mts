import assert from "node:assert/strict";
import test from "node:test";
import {
  isUprightMathLiteral,
  renderLatexCommandText,
} from "../app/lib/latexMath.ts";

test("renderLatexCommandText hides transparent TeX delimiter commands", () => {
  assert.equal(renderLatexCommandText("left"), null);
  assert.equal(renderLatexCommandText("right"), null);
});

test("renderLatexCommandText maps supported math symbols and keeps unknown operators readable", () => {
  assert.equal(renderLatexCommandText("sum"), "∑");
  assert.equal(renderLatexCommandText("ln"), "ln");
  assert.equal(renderLatexCommandText("exp"), "exp");
});

test("isUprightMathLiteral identifies punctuation, operators, and digits", () => {
  assert.equal(isUprightMathLiteral("("), true);
  assert.equal(isUprightMathLiteral(")"), true);
  assert.equal(isUprightMathLiteral("/"), true);
  assert.equal(isUprightMathLiteral("1"), true);
  assert.equal(isUprightMathLiteral("x"), false);
  assert.equal(isUprightMathLiteral("θ"), false);
});
