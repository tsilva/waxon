const LEGACY_EMBEDDING_SPACE_KEY =
  "openai:text-embedding-3-small:512:topic-v1" as const;
export const ACTIVE_EMBEDDING_SPACE_KEY =
  "openai:text-embedding-3-small:512:topic-v2" as const;

export type EmbeddingSpace = {
  id: number;
  key: string;
  dimensions: number;
  metric: "cosine";
  requestModel: string;
};

const EMBEDDING_SPACES: Readonly<Record<string, EmbeddingSpace>> = {
  [LEGACY_EMBEDDING_SPACE_KEY]: {
    id: 1,
    key: LEGACY_EMBEDDING_SPACE_KEY,
    dimensions: 512,
    metric: "cosine",
    requestModel: "openai/text-embedding-3-small",
  },
  [ACTIVE_EMBEDDING_SPACE_KEY]: {
    id: 2,
    key: ACTIVE_EMBEDDING_SPACE_KEY,
    dimensions: 512,
    metric: "cosine",
    requestModel: "openai/text-embedding-3-small",
  },
};

export function activeEmbeddingSpace(): EmbeddingSpace {
  return EMBEDDING_SPACES[ACTIVE_EMBEDDING_SPACE_KEY]!;
}

export function embeddingSpaceForKey(key: string): EmbeddingSpace {
  const space = EMBEDDING_SPACES[key];
  if (!space) throw new Error("The embedding space is not supported.");
  return space;
}

export function validateEmbedding(
  value: readonly number[],
  space: EmbeddingSpace = activeEmbeddingSpace(),
): number[] {
  if (value.length !== space.dimensions) {
    throw new Error(
      `Embedding space ${space.key} requires ${space.dimensions} dimensions.`,
    );
  }
  const embedding = value.map(Number);
  if (embedding.some((item) => !Number.isFinite(item))) {
    throw new Error("Embeddings must contain only finite values.");
  }
  const magnitude = Math.sqrt(
    embedding.reduce((sum, item) => sum + item * item, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("Embeddings must have non-zero magnitude.");
  }
  return embedding.map((item) => item / magnitude);
}
