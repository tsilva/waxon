import assert from "node:assert/strict";
import test from "node:test";
import {
  isCurrencyDollarSign,
  isInlineMathClosingDollarDelimiter,
  isInlineMathDollarDelimiter,
  isUprightMathLiteral,
  readLatexCommand,
  renderLatexCommandText,
} from "../app/lib/latexMath.ts";

test("renderLatexCommandText hides transparent TeX delimiter commands", () => {
  assert.equal(renderLatexCommandText("left"), null);
  assert.equal(renderLatexCommandText("right"), null);
});

test("renderLatexCommandText maps supported math symbols and keeps unknown operators readable", () => {
  assert.equal(renderLatexCommandText("approx"), "≈");
  assert.equal(renderLatexCommandText("sum"), "∑");
  assert.equal(renderLatexCommandText("ln"), "ln");
  assert.equal(renderLatexCommandText("exp"), "exp");
  assert.equal(renderLatexCommandText("div"), "÷");
  assert.equal(renderLatexCommandText("leq"), "≤");
  assert.equal(renderLatexCommandText("geq"), "≥");
});

test("renderLatexCommandText treats TeX spacing commands as spacing", () => {
  assert.equal(renderLatexCommandText(","), " ");
  assert.equal(renderLatexCommandText(":"), " ");
  assert.equal(renderLatexCommandText(";"), " ");
  assert.equal(renderLatexCommandText("quad"), " ");
  assert.equal(renderLatexCommandText("!"), null);
});

test("readLatexCommand reads word and spacing commands", () => {
  assert.deepEqual(readLatexCommand(String.raw`\div 4`, 0), {
    commandName: "div",
    nextIndex: 4,
  });
  assert.deepEqual(readLatexCommand(String.raw`4\,7`, 1), {
    commandName: ",",
    nextIndex: 3,
  });
  assert.deepEqual(readLatexCommand(String.raw`4\ 7`, 1), {
    commandName: " ",
    nextIndex: 3,
  });
  assert.equal(readLatexCommand(String.raw`\{x\}`, 0), null);
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

test("currency detection accepts decimal prices without treating punctuation as currency", () => {
  const text = "The fee is $.99, but the math value is $1001$.";
  const currencyIndex = text.indexOf("$.99");
  const mathOpenIndex = text.indexOf("$1001");
  const mathCloseIndex = text.lastIndexOf("$");

  assert.equal(isCurrencyDollarSign(text, currencyIndex), true);
  assert.equal(isCurrencyDollarSign(text, mathCloseIndex), false);
  assert.equal(isInlineMathDollarDelimiter(text, mathOpenIndex), true);
  assert.equal(isInlineMathClosingDollarDelimiter(text, mathCloseIndex), true);
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

test("dollar delimiter detection accepts numeric-only inline math", () => {
  const text = "Expected answer is $1001$, not a currency amount.";
  const openIndex = text.indexOf("$");
  const closeIndex = text.lastIndexOf("$");

  assert.equal(isCurrencyDollarSign(text, openIndex), true);
  assert.equal(isInlineMathDollarDelimiter(text, openIndex), true);
  assert.equal(isInlineMathClosingDollarDelimiter(text, closeIndex), true);
});
