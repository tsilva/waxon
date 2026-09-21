import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MarkdownContent } from "../app/MarkdownContent.tsx";

const appStylesPath = new URL(
  "../app/(app)/app-globals.css",
  import.meta.url,
);

test("MarkdownContent renders the accuracy formula with an upright label and fraction", () => {
  const text = String.raw`Fish caught plus pieces of rubbish left behind, divided by all fish and pieces of rubbish originally in the pond: $\mathrm{accuracy}=\frac{\text{fish caught}+\text{rubbish left behind}}{\text{all original fish and rubbish}}$. Catching a fish and leaving a piece of rubbish outside the net are both correct decisions.`;
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, { className: "v2-markdown", enableMath: true, text }),
  );
  const document = new JSDOM(html).window.document;

  assert.equal(document.querySelector(".math-roman")?.textContent, "accuracy");
  assert.equal(document.querySelector(".math-fraction-numerator")?.textContent, "fish caught+rubbish left behind");
  assert.equal(document.querySelector(".math-fraction-denominator")?.textContent, "all original fish and rubbish");
  assert.doesNotMatch(document.body.textContent ?? "", /mathrm|[{}$]/u);
  assert.match(document.body.textContent ?? "", /both correct decisions\.$/u);
});

test("roman math groups preserve nested commands, fractions, and scripts", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, {
      className: "v2-markdown",
      enableMath: true,
      text: String.raw`$\mathrm {x_{i}+\frac{\alpha}{2}}+y$`,
    }),
  );
  const document = new JSDOM(html).window.document;
  const roman = document.querySelector(".math-roman");

  assert.equal(roman?.querySelector("sub")?.textContent, "i");
  assert.equal(roman?.querySelector(".math-fraction-numerator")?.textContent, "α");
  assert.equal(roman?.querySelector(".math-fraction-denominator")?.textContent, "2");
  assert.equal(roman?.textContent, "xi+α2");
  assert.equal(document.querySelector(".math-expression")?.textContent, "xi+α2+y");
});

test("MarkdownContent repairs emphasized dollar delimiters around inline math", () => {
  const text = String.raw`Using the identity **$*****\nabla_\theta P(\tau; \theta) = P(\tau; \theta) \frac{\nabla_\theta P(\tau; \theta)}{P(\tau; \theta)} = P(\tau; \theta) \nabla_\theta \log P(\tau; \theta)$***.`;
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, {
      className: "v2-markdown",
      enableMath: true,
      text,
    }),
  );

  assert.doesNotMatch(html, /\$/u);
  assert.match(html, /class="math-expression"/u);
  assert.match(html, /class="math-fraction"/u);
  assert.match(html, />∇</u);
  assert.match(html, />θ</u);
  assert.match(html, />τ</u);
});

test("MarkdownContent renders KL-divergence relation and calligraphic set commands", () => {
  const text = String.raw`$D_{KL}(P \parallel Q) = \sum_{x \in \mathcal{X}} P(x) \log\left(\frac{P(x)}{Q(x)}\right)$`;
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, {
      className: "v2-markdown",
      enableMath: true,
      text,
    }),
  );

  assert.doesNotMatch(html, /\\parallel|\\mathcal/u);
  assert.match(html, /class="math-command math-command-parallel">∥</u);
  assert.match(html, />𝒳</u);
  assert.match(html, /class="math-fraction"/u);
});

test("MarkdownContent consumes double-dollar delimiters when prose follows inline", () => {
  const text = String.raw`$$\operatorname{Attention}(Q, K, V) = \operatorname{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V$$ where the softmax is applied row-wise.`;
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, {
      className: "v2-markdown",
      enableMath: true,
      text,
    }),
  );

  assert.doesNotMatch(html, /\$/u);
  assert.match(html, /class="math-expression"/u);
  assert.match(html, />Attention</u);
  assert.match(html, / where the softmax is applied row-wise\./u);
});

test("the parallel relation uses a math font with a complete glyph", async () => {
  const styles = await readFile(appStylesPath, "utf8");
  const parallelRule = styles.match(
    /\.math-command-parallel\s*\{([^}]*)\}/u,
  )?.[1];

  assert.ok(parallelRule);
  assert.match(parallelRule, /"STIX Two Math"/u);
  assert.match(parallelRule, /"Cambria Math"/u);
});

test("inline math permits long formulas to wrap", async () => {
  const styles = await readFile(appStylesPath, "utf8");
  const expressionRule = styles.match(/\.math-expression\s*\{([^}]*)\}/u)?.[1];

  assert.ok(expressionRule);
  assert.match(expressionRule, /white-space:\s*normal;/u);
  assert.doesNotMatch(expressionRule, /white-space:\s*nowrap;/u);
});
