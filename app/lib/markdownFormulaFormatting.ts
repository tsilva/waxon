const MARKDOWN_SEGMENT_PATTERN =
  /(`[^`\n]+`|\$[^$\n]+\$|\\\([^)\n]+\\\)|\\\[[\s\S]*?\\\])/gu;

const MATH_ATOM_PATTERN =
  String.raw`(?:\\?[A-Za-z]+|[A-Za-z]+)\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)|\[[^\]\n]{1,80}\]|[A-Za-z0-9]+(?:_[A-Za-z0-9]+|\^[A-Za-z0-9]+)?`;

const MATH_FORMULA_PATTERN = new RegExp(
  String.raw`(?:${MATH_ATOM_PATTERN})(?:\s*(?:[+\-*/^=<>≤≥≈@])\s*(?:${MATH_ATOM_PATTERN}))+`,
  "gu",
);

const COMPACT_MATH_TOKEN_PATTERN =
  /\b(?:[A-Za-z]+(?:_\{?[-A-Za-z0-9]+\}?|\^\{?[-A-Za-z0-9]+\}?)+|\d+\s*\/\s*[A-Za-z]+(?:_\{?[-A-Za-z0-9]+\}?|\^\{?[-A-Za-z0-9]+\}?)*)/gu;

type FormulaMarkdownStyle = "code" | "math";

type FormulaMarkdownOptions = {
  style?: FormulaMarkdownStyle;
};

function wrapFormula(formula: string, style: FormulaMarkdownStyle): string {
  return style === "math" ? `$${formula}$` : `\`${formula}\``;
}

function isMathLikeInlineCode(value: string): boolean {
  if (/[`$]/u.test(value) || /[@[\].]/u.test(value)) {
    return false;
  }

  MATH_FORMULA_PATTERN.lastIndex = 0;
  COMPACT_MATH_TOKEN_PATTERN.lastIndex = 0;

  return (
    MATH_FORMULA_PATTERN.test(value) ||
    COMPACT_MATH_TOKEN_PATTERN.test(value) ||
    /\\[A-Za-z]+/u.test(value)
  );
}

function formatCompactMathTokens(segment: string): string {
  return segment.replace(COMPACT_MATH_TOKEN_PATTERN, (match) => {
    const trimmed = match.trim();

    if (!trimmed || trimmed.includes("$")) {
      return match;
    }

    const leadingWhitespace = match.match(/^\s*/u)?.[0] ?? "";
    const trailingWhitespace = match.match(/\s*$/u)?.[0] ?? "";

    return `${leadingWhitespace}${wrapFormula(trimmed, "math")}${trailingWhitespace}`;
  });
}

function formatCompactMathOutsideMathSpans(segment: string): string {
  let formatted = "";
  let lastIndex = 0;

  for (const match of segment.matchAll(/\$[^$\n]+\$/gu)) {
    const index = match.index ?? 0;

    formatted += formatCompactMathTokens(segment.slice(lastIndex, index));
    formatted += match[0];
    lastIndex = index + match[0].length;
  }

  formatted += formatCompactMathTokens(segment.slice(lastIndex));

  return formatted;
}

function formatPlainFormulaSegment(
  segment: string,
  style: FormulaMarkdownStyle,
): string {
  const formatted = segment.replace(MATH_FORMULA_PATTERN, (match) => {
    const trimmed = match.trim();

    if (!trimmed || trimmed.includes("`")) {
      return match;
    }

    const leadingWhitespace = match.match(/^\s*/u)?.[0] ?? "";
    const trailingWhitespace = match.match(/\s*$/u)?.[0] ?? "";

    return `${leadingWhitespace}${wrapFormula(trimmed, style)}${trailingWhitespace}`;
  });

  if (style !== "math") {
    return formatted;
  }

  return formatCompactMathOutsideMathSpans(formatted);
}

function formatMarkdownSegment(
  segment: string,
  style: FormulaMarkdownStyle,
): string {
  if (style !== "math" || !segment.startsWith("`") || !segment.endsWith("`")) {
    return segment;
  }

  const codeText = segment.slice(1, -1);

  if (!isMathLikeInlineCode(codeText)) {
    return segment;
  }

  return wrapFormula(codeText, "math");
}

export function formatFormulaMarkdown(
  text: string,
  options: FormulaMarkdownOptions = {},
): string {
  const style = options.style ?? "code";

  MATH_FORMULA_PATTERN.lastIndex = 0;
  COMPACT_MATH_TOKEN_PATTERN.lastIndex = 0;

  if (!text.trim()) {
    return text;
  }

  let formatted = "";
  let lastIndex = 0;

  for (const match of text.matchAll(MARKDOWN_SEGMENT_PATTERN)) {
    const index = match.index ?? 0;

    formatted += formatPlainFormulaSegment(text.slice(lastIndex, index), style);
    formatted += formatMarkdownSegment(match[0], style);
    lastIndex = index + match[0].length;
  }

  formatted += formatPlainFormulaSegment(text.slice(lastIndex), style);

  return formatted;
}
