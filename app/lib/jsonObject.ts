export function extractJsonObject(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    const match = source.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error("Model did not return JSON.");
    }

    return JSON.parse(match[0]);
  }
}
