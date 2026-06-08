export function calculateQuestionExtractionProgress(input: {
  generated: number;
  total: number;
}): number {
  const total = Math.max(1, Math.round(input.total));
  const generated = Math.max(0, Math.round(input.generated));

  return Math.min(100, Math.round((generated / total) * 100));
}
