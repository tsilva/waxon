import assert from "node:assert/strict";
import test from "node:test";
import {
  isCurrencyDollarSign,
  isInlineMathClosingDollarDelimiter,
  isInlineMathDollarDelimiter,
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

test("dollar delimiter detection keeps currency amounts out of inline math", () => {
  const text =
    "One house sells for $320,000, and the model predicts $300,000.";

  assert.equal(isCurrencyDollarSign(text, text.indexOf("$320")), true);
  assert.equal(isCurrencyDollarSign(text, text.indexOf("$300")), true);
  assert.equal(isInlineMathDollarDelimiter(text, text.indexOf("$320")), false);
  assert.equal(isInlineMathClosingDollarDelimiter(text, text.indexOf("$300")), false);
});

test("dollar delimiter detection handles spaced currency amounts in generated choices", () => {
  const text =
    "Actual minus average: $ 320,000 - $250,000 = $70,000";

  for (const index of [
    text.indexOf("$ 320"),
    text.indexOf("$250"),
    text.indexOf("$70"),
  ]) {
    assert.equal(isCurrencyDollarSign(text, index), true);
    assert.equal(isInlineMathDollarDelimiter(text, index), false);
    assert.equal(isInlineMathClosingDollarDelimiter(text, index), false);
  }
});

test("dollar delimiter detection still accepts compact inline math", () => {
  const text = "Residual is $y - \\hat{y}$ for each point.";
  const openIndex = text.indexOf("$");
  const closeIndex = text.lastIndexOf("$");

  assert.equal(isInlineMathDollarDelimiter(text, openIndex), true);
  assert.equal(isInlineMathClosingDollarDelimiter(text, closeIndex), true);
});
