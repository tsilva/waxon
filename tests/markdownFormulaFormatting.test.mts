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
