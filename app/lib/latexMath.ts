const mathSymbolMap: Record<string, string> = {
  alpha: "α",
  beta: "β",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  eta: "η",
  gamma: "γ",
  lambda: "λ",
  mu: "μ",
  nabla: "∇",
  partial: "∂",
  cdot: "·",
  le: "≤",
  ge: "≥",
  log: "log",
  neq: "≠",
  sum: "∑",
  times: "×",
  theta: "θ",
};

const transparentDelimiterCommands = new Set(["left", "right"]);

export function renderLatexCommandText(commandName: string): string | null {
  if (transparentDelimiterCommands.has(commandName)) {
    return null;
  }

  return mathSymbolMap[commandName] ?? commandName;
}

export function isUprightMathLiteral(character: string): boolean {
  return /^[\s\d()[\]{}.,;:!?=+\-*/<>|]$/u.test(character);
}

export function isCurrencyDollarSign(source: string, index: number): boolean {
  return source[index] === "$" && /^\s*[\d.]/u.test(source.slice(index + 1));
}

export function isInlineMathDollarDelimiter(
  source: string,
  index: number,
): boolean {
  if (
    source[index] !== "$" ||
    source[index - 1] === "\\" ||
    source[index + 1] === "$" ||
    isCurrencyDollarSign(source, index)
  ) {
    return false;
  }

  return !/^\s$/u.test(source[index + 1] ?? "");
}

export function isInlineMathClosingDollarDelimiter(
  source: string,
  index: number,
): boolean {
  if (
    source[index] !== "$" ||
    source[index - 1] === "\\" ||
    source[index + 1] === "$" ||
    isCurrencyDollarSign(source, index)
  ) {
    return false;
  }

  return !/^\s$/u.test(source[index - 1] ?? "");
}
