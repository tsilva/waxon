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
  pi: "π",
  nabla: "∇",
  partial: "∂",
  cdot: "·",
  in: "∈",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  approx: "≈",
  log: "log",
  div: "÷",
  neq: "≠",
  ne: "≠",
  mid: "∣",
  sum: "∑",
  times: "×",
  theta: "θ",
  ldots: "…",
  cdots: "⋯",
  infty: "∞",
  pm: "±",
  mp: "∓",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  quad: " ",
  qquad: " ",
  ",": " ",
  ":": " ",
  ";": " ",
  " ": " ",
};

const transparentDelimiterCommands = new Set(["left", "right", "!"]);

export type LatexCommandReadResult = {
  commandName: string;
  nextIndex: number;
};

export type LatexMathParseResult = {
  content: string;
  nextIndex: number;
};

export function readLatexMathGroup(
  source: string,
  startIndex: number,
): LatexMathParseResult | null {
  if (source[startIndex] !== "{") {
    return null;
  }

  let depth = 0;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return {
          content: source.slice(startIndex + 1, index),
          nextIndex: index + 1,
        };
      }
    }
  }

  return null;
}

export function readLatexCommand(
  source: string,
  startIndex: number,
): LatexCommandReadResult | null {
  if (source[startIndex] !== "\\") {
    return null;
  }

  const letterCommand = source.slice(startIndex + 1).match(/^[A-Za-z]+/u);

  if (letterCommand) {
    return {
      commandName: letterCommand[0],
      nextIndex: startIndex + letterCommand[0].length + 1,
    };
  }

  const singleCharacterCommand = source[startIndex + 1];

  if (singleCharacterCommand && /^[,;:! ]$/u.test(singleCharacterCommand)) {
    return {
      commandName: singleCharacterCommand,
      nextIndex: startIndex + 2,
    };
  }

  return null;
}

export function readLatexMathAtom(
  source: string,
  startIndex: number,
): LatexMathParseResult {
  let atomStartIndex = startIndex;

  while (/\s/u.test(source[atomStartIndex] ?? "")) {
    atomStartIndex += 1;
  }

  const group = readLatexMathGroup(source, atomStartIndex);

  if (group) {
    return group;
  }

  const command = readLatexCommand(source, atomStartIndex);

  if (command) {
    return {
      content: source.slice(atomStartIndex, command.nextIndex),
      nextIndex: command.nextIndex,
    };
  }

  const atomMatch = source.slice(atomStartIndex).match(/^[A-Za-z0-9]+/u);

  if (atomMatch) {
    return {
      content: atomMatch[0],
      nextIndex: atomStartIndex + atomMatch[0].length,
    };
  }

  return {
    content: source[atomStartIndex] ?? "",
    nextIndex: atomStartIndex + 1,
  };
}

export function renderLatexCommandText(commandName: string): string | null {
  if (transparentDelimiterCommands.has(commandName)) {
    return null;
  }

  return mathSymbolMap[commandName] ?? commandName;
}

const doubleStruckUppercaseExceptions: Record<string, string> = {
  C: "ℂ",
  H: "ℍ",
  N: "ℕ",
  P: "ℙ",
  Q: "ℚ",
  R: "ℝ",
  Z: "ℤ",
};

export function renderLatexMathbbText(value: string): string {
  return Array.from(value, (character) => {
    const uppercaseException = doubleStruckUppercaseExceptions[character];

    if (uppercaseException) {
      return uppercaseException;
    }

    const codePoint = character.codePointAt(0);

    if (codePoint === undefined) {
      return character;
    }

    if (codePoint >= 0x41 && codePoint <= 0x5a) {
      return String.fromCodePoint(0x1d538 + codePoint - 0x41);
    }

    if (codePoint >= 0x61 && codePoint <= 0x7a) {
      return String.fromCodePoint(0x1d552 + codePoint - 0x61);
    }

    if (codePoint >= 0x30 && codePoint <= 0x39) {
      return String.fromCodePoint(0x1d7d8 + codePoint - 0x30);
    }

    return character;
  }).join("");
}

export function isUprightMathLiteral(character: string): boolean {
  return /^[\s\d()[\]{}.,;:!?=+\-*/<>|]$/u.test(character);
}

export function isCurrencyDollarSign(source: string, index: number): boolean {
  return source[index] === "$" && /^\s*(?:\d|\.\d)/u.test(source.slice(index + 1));
}

export function isInlineMathDollarDelimiter(
  source: string,
  index: number,
): boolean {
  if (
    source[index] !== "$" ||
    source[index - 1] === "\\" ||
    source[index + 1] === "$"
  ) {
    return false;
  }

  if (isCurrencyDollarSign(source, index)) {
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === "\n") {
        return false;
      }

      if (isInlineMathClosingDollarDelimiter(source, cursor)) {
        return true;
      }
    }

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
