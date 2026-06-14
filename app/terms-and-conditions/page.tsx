export default function TermsAndConditionsPage() {
  return (
    <main className="legal-page">
      <article className="legal-document">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a className="legal-brand" href="/">
          waxon
        </a>
        <p className="legal-kicker">Terms and conditions</p>
        <h1>Terms and conditions</h1>
        <p>
          <span>
            Waxon is provided as a study tool for free-text recall practice.{" "}
          </span>
          <span>
            You are responsible for the material you add and for deciding
            whether the feedback is suitable for your use.
          </span>
        </p>
        <p>
          Model-generated grades and feedback can be incomplete or incorrect, so
          they should be treated as study assistance rather than authoritative
          advice.
        </p>
        <p>
          Access may change over time as the product evolves.
        </p>
      </article>
    </main>
  );
}
