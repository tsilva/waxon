export function extractJsonObject(source) {
  const parseAttempts = (candidate) => {
    try {
      return JSON.parse(candidate);
    } catch {
      return JSON.parse(escapeControlCharactersInJsonStrings(candidate));
    }
  };

  try {
    return parseAttempts(source);
  } catch {
    const match = extractFirstBalancedObject(source);

    if (!match) {
      throw new Error("Model did not return JSON.");
    }

    return parseAttempts(match);
  }
}

function extractFirstBalancedObject(source) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function escapeControlCharactersInJsonStrings(source) {
  let escaped = "";
  let inString = false;
  let isEscaped = false;

  for (const character of source) {
    if (!inString) {
      escaped += character;
      if (character === "\"") {
        inString = true;
      }
      continue;
    }

    if (isEscaped) {
      escaped += character;
      isEscaped = false;
      continue;
    }

    if (character === "\\") {
      escaped += character;
      isEscaped = true;
      continue;
    }

    if (character === "\"") {
      escaped += character;
      inString = false;
      continue;
    }

    if (character === "\n") {
      escaped += "\\n";
      continue;
    }

    if (character === "\r") {
      escaped += "\\r";
      continue;
    }

    if (character === "\t") {
      escaped += "\\t";
      continue;
    }

    if (character.charCodeAt(0) < 0x20) {
      escaped += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }

    escaped += character;
  }

  return escaped;
}
