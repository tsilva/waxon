import ReviewApp from "../review/ReviewApp";
import { listDecks } from "../lib/postgresStore";

export default async function DecksPage() {
  const decks = await listDecks();

  return <ReviewApp initialActiveTab="queue" initialDecks={decks} />;
}
