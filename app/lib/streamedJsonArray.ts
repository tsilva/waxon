export function extractCompleteJsonObjectsFromArrayProperty(
  text: string,
  propertyName: string,
): unknown[] {
  const escapedPropertyName = propertyName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const arrayMatch = new RegExp(`"${escapedPropertyName}"\\s*:\\s*\\[`, "u").exec(
    text,
  );

  if (!arrayMatch) {
    return [];
  }

  const objects: unknown[] = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (
    let index = arrayMatch.index + arrayMatch[0].length;
    index < text.length;
    index += 1
  ) {
    const char = text[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (depth === 0 && char === "]") {
      break;
    }

    if (char === "{") {
      if (depth === 0) {
        objectStart = index;
      }

      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;

      if (depth === 0 && objectStart >= 0) {
        try {
          objects.push(JSON.parse(text.slice(objectStart, index + 1)));
        } catch {
          // Partial streams can contain a complete-looking object before it is valid.
        }

        objectStart = -1;
      }
    }
  }

  return objects;
}
