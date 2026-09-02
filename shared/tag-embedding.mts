function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function tagEmbeddingInput(input: {
  label: string;
  aliases: readonly string[];
  description: string;
}): string {
  const label = normalizeText(input.label);
  const seen = new Set([label.toLocaleLowerCase("en-US")]);
  const aliases = input.aliases
    .map(normalizeText)
    .filter((alias) => {
      const key = alias.toLocaleLowerCase("en-US");
      if (!alias || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const names = [...aliases, label].map((name) => `${name}.`).join(" ");
  const description = normalizeText(input.description);
  return description ? `${names}\n${description}` : names;
}
