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
