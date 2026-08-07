import { SourceLearningPathPage } from "./SourceLearningPathPage";

export default async function SourcePage({
  params,
}: {
  params: Promise<{ sourceId: string }>;
}) {
  const { sourceId } = await params;
  return <SourceLearningPathPage sourceId={sourceId} />;
}
