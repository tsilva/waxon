type NormalizedEvidence = {
  text: string;
  starts: number[];
  ends: number[];
};

function normalizeEvidence(value: string): NormalizedEvidence {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];

  function append(character: string, start: number, end: number) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      text += character.toLocaleLowerCase("und");
      starts.push(start);
      ends.push(end);
      return;
    }
    if (text && !text.endsWith(" ")) {
      text += " ";
      starts.push(start);
      ends.push(end);
    }
  }

  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    const nextIndex = index + character.length;

    if (character === "-" || character === "\u00ad") {
      let cursor = nextIndex;
      while (cursor < value.length && /\s/u.test(value[cursor] ?? "")) {
        cursor += 1;
      }
      const previous = value.slice(0, index).match(/\p{L}$/u)?.[0];
      const next = value.slice(cursor).match(/^\p{L}/u)?.[0];
      if (previous && next && cursor > nextIndex) {
        index = cursor;
        continue;
      }
    }

    const folded = character.normalize("NFKC");
    for (const foldedCharacter of folded) {
      append(foldedCharacter, index, nextIndex);
    }
    index = nextIndex;
  }

  while (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }

  return { text, starts, ends };
}

export function alignEvidenceQuote(
  source: string,
  proposedQuote: string,
): {
  quote: string;
  startOffset: number;
  endOffset: number;
} | null {
  const exactOffset = source.indexOf(proposedQuote);
  if (exactOffset >= 0) {
    return {
      quote: proposedQuote,
      startOffset: exactOffset,
      endOffset: exactOffset + proposedQuote.length,
    };
  }

  const normalizedQuote = normalizeEvidence(proposedQuote).text;
  if (
    normalizedQuote.length < 24 ||
    normalizedQuote.split(" ").filter(Boolean).length < 4
  ) {
    return null;
  }
  const normalizedSource = normalizeEvidence(source);
  const normalizedOffset = normalizedSource.text.indexOf(normalizedQuote);
  if (normalizedOffset < 0) {
    return null;
  }
  const normalizedEnd = normalizedOffset + normalizedQuote.length - 1;
  const startOffset = normalizedSource.starts[normalizedOffset];
  const endOffset = normalizedSource.ends[normalizedEnd];
  if (startOffset === undefined || endOffset === undefined) {
    return null;
  }

  return {
    quote: source.slice(startOffset, endOffset),
    startOffset,
    endOffset,
  };
}
