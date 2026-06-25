type JsonTokenKind =
  | "boolean"
  | "key"
  | "null"
  | "number"
  | "plain"
  | "punctuation"
  | "string";

type JsonToken = {
  kind: JsonTokenKind;
  text: string;
};

function parseJsonPayload(payload: string): unknown | null {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function normalizeJsonPayload(payload: string): {
  parsed: unknown | null;
  text: string;
} {
  const parsed = parseJsonPayload(payload);

  if (parsed === null) {
    return {
      parsed: null,
      text: payload,
    };
  }

  return {
    parsed,
    text: JSON.stringify(parsed, null, 2),
  };
}

function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const matcher =
    /("(?:\\.|[^"\\])*")|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text)) !== null) {
    if (match.index > cursor) {
      tokens.push({
        kind: "plain",
        text: text.slice(cursor, match.index),
      });
    }

    const token = match[0];
    const nextText = text.slice(matcher.lastIndex);
    const isKey = token.startsWith("\"") && /^\s*:/.test(nextText);
    let kind: JsonTokenKind = "plain";

    if (isKey) {
      kind = "key";
    } else if (token.startsWith("\"")) {
      kind = "string";
    } else if (/^-?\d/.test(token)) {
      kind = "number";
    } else if (token === "true" || token === "false") {
      kind = "boolean";
    } else if (token === "null") {
      kind = "null";
    } else {
      kind = "punctuation";
    }

    tokens.push({ kind, text: token });
    cursor = matcher.lastIndex;
  }

  if (cursor < text.length) {
    tokens.push({
      kind: "plain",
      text: text.slice(cursor),
    });
  }

  return tokens;
}

export function JsonSyntaxBlock({
  payload,
  className,
}: {
  payload: string;
  className: string;
}) {
  const { parsed, text } = normalizeJsonPayload(payload);
  const preClassName =
    parsed === null ? className : `${className} admin-json-payload`;

  return (
    <pre className={preClassName}>
      <code>
        {parsed === null
          ? text
          : tokenizeJson(text).map((token, index) => (
              <span
                className={`admin-json-token admin-json-token-${token.kind}`}
                key={`${token.kind}-${index}`}
              >
                {token.text}
              </span>
            ))}
      </code>
    </pre>
  );
}
