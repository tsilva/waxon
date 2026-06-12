const MIN_SLUG_WORDS = 2;

export function normalizeConceptSlug(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

export function isUsefulConceptSlug(slug: string): boolean {
  const normalized = normalizeConceptSlug(slug);

  if (normalized !== slug || normalized.length < 3) {
    return false;
  }

  const parts = slug.split("-").filter(Boolean);

  if (parts.length < MIN_SLUG_WORDS) {
    return false;
  }

  if (parts.every((part) => part.length <= 3)) {
    return false;
  }

  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug);
}

export function normalizeConceptSlugList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    const slug = normalizeConceptSlug(item);

    if (!isUsefulConceptSlug(slug) || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    normalized.push(slug);

    if (normalized.length >= 3) {
      break;
    }
  }

  return normalized;
}
