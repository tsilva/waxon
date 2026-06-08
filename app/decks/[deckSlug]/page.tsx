import ReviewApp from "../../review/ReviewApp";
import { listDecks } from "../../lib/postgresStore";

type DeckPageProps = {
  params: Promise<{
    deckSlug: string;
  }>;
};

export default async function DeckPage({ params }: DeckPageProps) {
  const { deckSlug } = await params;
  const decks = await listDecks();

  return (
    <ReviewApp
      initialActiveTab="queue"
      initialDeckSlug={deckSlug}
      initialDecks={decks}
    />
  );
}
