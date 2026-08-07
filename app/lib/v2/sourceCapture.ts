export type InferredSourceCapture = {
  kind: "topic" | "paste" | "url";
  title: string;
  text?: string;
  url?: string;
};

export function inferSourceCapture(value: string): InferredSourceCapture {
  const trimmed = value.trim();
  if (/^https?:\/\/\S+$/iu.test(trimmed)) {
    return { kind: "url", title: trimmed, url: trimmed };
  }
  if (trimmed.length >= 300 || trimmed.includes("\n")) {
    return {
      kind: "paste",
      title:
        trimmed.split("\n").find((line) => line.trim())?.slice(0, 300) ||
        "Pasted source",
      text: trimmed,
    };
  }
  return { kind: "topic", title: trimmed.slice(0, 300), text: trimmed };
}
