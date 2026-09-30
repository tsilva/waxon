import Image from "next/image";
import Link from "next/link";
import { LandingAccountActions } from "./LandingAccountActions";

const practiceSteps = [
  {
    title: "Add a question",
    copy: "Write a question about anything you want to remember.",
  },
  {
    title: "Answer in your own words",
    copy: "Recall what you know and get helpful feedback.",
  },
  {
    title: "Review when it is due",
    copy: "Questions return based on your answer history.",
  },
];

export default function LandingPage() {
  return (
    <main className="landing-page">
      <header className="landing-nav" aria-label="Primary navigation">
        <Link className="landing-brand" href="/" aria-label="Waxon home">
          waxon
        </Link>
        <nav className="landing-links" aria-label="Landing sections">
          <a href="#how-it-works">How it works</a>
        </nav>
        <LandingAccountActions />
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero-copy">
          <h1 id="landing-title">
            <span>Keep what </span>
            <span>
              you <em>learn.</em>
            </span>
          </h1>
          <p>
            Answer from memory. Get useful feedback.{" "}
            <br />
            Return when it matters.
          </p>
          <div className="landing-hero-actions">
            <Link className="landing-primary" href="/sign-up" prefetch={false}>
              Get started
            </Link>
            <a className="landing-text-link" href="#how-it-works">
              See how it works
            </a>
          </div>
        </div>

        <figure className="landing-hero-visual">
          <Image
            className="landing-hero-image"
            src="/landing/practice-journal-hero.png"
            alt="Paper study cards showing a question about the Moon’s phases, an answer in the learner’s own words, helpful Correct feedback, and a scheduled review."
            width={1342}
            height={1172}
            sizes="(max-width: 760px) 100vw, (max-width: 1100px) 62vw, 820px"
            loading="eager"
            fetchPriority="high"
          />
        </figure>
      </section>

      <section
        className="landing-how-section"
        id="how-it-works"
        aria-label="How Waxon works"
      >
        <ol className="landing-steps">
          {practiceSteps.map((step, index) => (
            <li className="landing-step" key={step.title}>
              <span className="landing-step-number" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h2>{step.title}</h2>
              <p>{step.copy}</p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="landing-footer">
        <Link className="landing-brand" href="/" aria-label="Waxon home">
          waxon
        </Link>
        <nav aria-label="Legal">
          <Link href="/privacy-policy">Privacy</Link>
          <Link href="/terms-and-conditions">Terms</Link>
        </nav>
      </footer>
    </main>
  );
}
