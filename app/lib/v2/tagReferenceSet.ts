import referenceSet from "../../../reference/semantic-tag-reference-set.json";
import { getV2Client } from "../../db/v2/client.ts";
import type { V2TagRef } from "./types.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const parsedReferenceSet = referenceSet as {
  questions: Array<{ questionId: string; expectedTagIds: string[] }>;
};
const expectedTagIdsByQuestion = new Map(
  parsedReferenceSet.questions.flatMap((entry) =>
    UUID_PATTERN.test(entry.questionId) &&
    entry.expectedTagIds.every((tagId) => UUID_PATTERN.test(tagId))
      ? [[entry.questionId, [...new Set(entry.expectedTagIds)]] as const]
      : [],
  ),
);

/**
 * Loads evaluation-only reference judgments. These do not participate in Tag
 * retrieval, filtering, Question lifecycle, or Review scheduling.
 */
export async function referenceTags(input: {
  learnerId: string;
  questionIds: readonly string[];
}): Promise<Map<string, V2TagRef[] | null>> {
  const questionIds = [...new Set(input.questionIds)];
  const output = new Map<string, V2TagRef[] | null>(
    questionIds.map((questionId) => [questionId, null]),
  );
  const judged = questionIds.flatMap((questionId) => {
    const tagIds = expectedTagIdsByQuestion.get(questionId);
    return tagIds ? [{ questionId, tagIds }] : [];
  });
  if (judged.length === 0) return output;

  const referencedTagIds = [
    ...new Set(judged.flatMap(({ tagIds }) => tagIds)),
  ];
  const tags = referencedTagIds.length === 0
    ? []
    : (
        await getV2Client().pool.query<V2TagRef>(
          `SELECT id, label
             FROM waxon_v2.tags
            WHERE user_id = $1
              AND id = ANY($2::uuid[])
              AND deleted_at IS NULL`,
          [input.learnerId, referencedTagIds],
        )
      ).rows;
  const tagById = new Map(tags.map((tag) => [tag.id, tag]));

  for (const { questionId, tagIds } of judged) {
    output.set(
      questionId,
      tagIds.flatMap((tagId) => {
        const tag = tagById.get(tagId);
        return tag ? [tag] : [];
      }),
    );
  }
  return output;
}
