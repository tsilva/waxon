import assert from "node:assert/strict";
import test from "node:test";
import { formatFormulaMarkdown } from "../app/lib/markdownFormulaFormatting.ts";

test("formatFormulaMarkdown wraps bare formulas in inline markdown code", () => {
  assert.equal(
    formatFormulaMarkdown(
      "Since exp(-1)<1, exp(0)+exp(-1)<2; ln is increasing, so ln(sum)<ln(2).",
    ),
    "Since `exp(-1)<1`, `exp(0)+exp(-1)<2`; ln is increasing, so `ln(sum)<ln(2)`.",
  );
});

test("formatFormulaMarkdown leaves existing markdown spans untouched", () => {
  assert.equal(
    formatFormulaMarkdown(
      "Since `exp(-1)<1`, and $ln(sum)<ln(2)$ follows.",
    ),
    "Since `exp(-1)<1`, and $ln(sum)<ln(2)$ follows.",
  );
});

test("formatFormulaMarkdown treats @ as a formula operator", () => {
  assert.equal(
    formatFormulaMarkdown("Q = x @ W_Q, K = x @ W_K, and V = x @ W_V."),
    "`Q = x @ W_Q`, `K = x @ W_K`, and `V = x @ W_V`.",
  );
});

test("formatFormulaMarkdown can render math-style correct answers", () => {
  assert.equal(
    formatFormulaMarkdown("x^{-7} (or 1/x^7)", { style: "math" }),
    "$x^{-7}$ (or $1/x^7$)",
  );
});

test("formatFormulaMarkdown converts math-like code spans in math style", () => {
  assert.equal(
    formatFormulaMarkdown("`x^{-7}` (or `1/x^7`)", { style: "math" }),
    "$x^{-7}$ (or $1/x^7$)",
  );
});

test("formatFormulaMarkdown preserves code-like matrix products in math style", () => {
  assert.equal(
    formatFormulaMarkdown("`Q = x @ W_q`", { style: "math" }),
    "`Q = x @ W_q`",
  );
});
