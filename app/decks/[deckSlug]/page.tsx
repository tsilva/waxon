import { redirect } from "next/navigation";

type DeckPageProps = {
  params: Promise<{
    deckSlug: string;
  }>;
};

export default async function DeckPage({ params }: DeckPageProps) {
  await params;
  redirect("/tags");
}
