import ReviewApp from "../../review/ReviewApp";

type DeckPageProps = {
  params: Promise<{
    deckSlug: string;
  }>;
};

export default async function DeckPage({ params }: DeckPageProps) {
  const { deckSlug } = await params;

  return <ReviewApp initialActiveTab="queue" initialDeckSlug={deckSlug} />;
}
