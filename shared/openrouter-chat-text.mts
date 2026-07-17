type ChatContentPart = {
  content?: unknown;
  text?: unknown;
};

type ChatResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

export function extractChatCompletionText(response: unknown): string {
  const content = (response as ChatResponse).choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const candidate = part as ChatContentPart;
        return typeof candidate.text === "string" ? candidate.text : "";
      })
      .join("")
      .trim();
  }

  return "";
}

export function extractOpenRouterChatText(body: unknown): string {
  const content = (body as ChatResponse | null | undefined)?.choices?.[0]?.message
    ?.content;

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part === "object") {
        const candidate = part as ChatContentPart;
        return typeof candidate.text === "string"
          ? candidate.text
          : typeof candidate.content === "string"
            ? candidate.content
            : "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}
