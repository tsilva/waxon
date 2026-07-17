export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
