import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../app/MarkdownContent.tsx";

const appStylesPath = new URL(
  "../app/(app)/app-globals.css",
  import.meta.url,
);

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
