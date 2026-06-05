import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="legal-page">
      <article className="legal-document">
        <Link className="legal-brand" href="/">
          waxon
        </Link>
        <p className="legal-kicker">Not found</p>
        <h1>Page not found</h1>
        <p>The page you requested is not available.</p>
        <p>
          Return to <Link href="/review">review</Link> or browse your{" "}
          <Link href="/decks">decks</Link>.
        </p>
      </article>
    </main>
  );
}
