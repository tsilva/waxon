import { createHash } from "node:crypto";

export function questionSlug(question: string): string {
  const slug = question
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug) {
    return slug;
  }

  return `question-${createHash("sha256")
    .update(question)
    .digest("hex")
    .slice(0, 16)}`;
}
