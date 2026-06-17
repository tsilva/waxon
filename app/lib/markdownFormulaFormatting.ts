const MARKDOWN_SEGMENT_PATTERN =
  /(`[^`\n]+`|\$[^$\n]+\$|\\\([^)\n]+\\\)|\\\[[\s\S]*?\\\])/gu;

const MATH_ATOM_PATTERN =
  String.raw`(?:\\?[A-Za-z]+|[A-Za-z]+)\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)|\[[^\]\n]{1,80}\]|[A-Za-z0-9]+(?:_[A-Za-z0-9]+|\^[A-Za-z0-9]+)?`;

const MATH_FORMULA_PATTERN = new RegExp(
  String.raw`(?:${MATH_ATOM_PATTERN})(?:\s*(?:[+\-*/^=<>≤≥≈])\s*(?:${MATH_ATOM_PATTERN}))+`,
  "gu",
);

function formatPlainFormulaSegment(segment: string): string {
  return segment.replace(MATH_FORMULA_PATTERN, (match) => {
    const trimmed = match.trim();

    if (!trimmed || trimmed.includes("`")) {
      return match;
    }

    const leadingWhitespace = match.match(/^\s*/u)?.[0] ?? "";
    const trailingWhitespace = match.match(/\s*$/u)?.[0] ?? "";

    return `${leadingWhitespace}\`${trimmed}\`${trailingWhitespace}`;
  });
}

export function formatFormulaMarkdown(text: string): string {
  if (!text.trim()) {
    return text;
  }

  let formatted = "";
  let lastIndex = 0;

  for (const match of text.matchAll(MARKDOWN_SEGMENT_PATTERN)) {
    const index = match.index ?? 0;

    formatted += formatPlainFormulaSegment(text.slice(lastIndex, index));
    formatted += match[0];
    lastIndex = index + match[0].length;
  }

  formatted += formatPlainFormulaSegment(text.slice(lastIndex));

  return formatted;
}
