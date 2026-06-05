import {
  BarChart3,
  Brain,
  CheckCircle2,
  Clock3,
  PencilLine,
} from "lucide-react";
import Link from "next/link";

const detailItems = [
  {
    icon: PencilLine,
    title: "Write what you know",
    copy: "Free-text recall keeps the review focused on what you can actually explain.",
  },
  {
    icon: Brain,
    title: "Get concise feedback",
    copy: "Model-graded answers surface what is right, what is missing, and what to fix.",
  },
  {
    icon: Clock3,
    title: "Review what is due",
    copy: "Spaced intervals bring back the right cards without turning study into guesswork.",
  },
  {
    icon: BarChart3,
    title: "Track progress over time",
    copy: "Scores and answer history make improvement visible across the deck.",
  },
];

const timelineSteps = [
  { label: "1d", status: "New" },
  { label: "3d", status: "Review" },
  { label: "7d", status: "Review" },
  { label: "21d+", status: "Review" },
];

export default function LandingPage() {
  return (
    <main className="landing-page">
      <header className="landing-nav" aria-label="Primary navigation">
        <Link className="landing-brand" href="/">
          waxon
        </Link>
        <nav className="landing-links" aria-label="Landing sections">
          <a href="#how-it-works">How it works</a>
          <a href="#features">Features</a>
          <Link href="/admin">Admin</Link>
        </nav>
        <Link className="landing-nav-action" href="/review">
          Get started
        </Link>
      </header>

      <section
        className="landing-hero"
        id="how-it-works"
        aria-labelledby="landing-title"
      >
        <div className="landing-hero-copy">
          <h1 id="landing-title">Practice recall. Get graded.</h1>
          <span className="landing-red-rule" aria-hidden="true" />
          <p>
            Typed answers, model feedback, and spaced review in one quiet loop.
          </p>
          <div className="landing-hero-actions">
            <Link className="landing-primary" href="/review">
              Get started
            </Link>
            <span>Free to start. No card limits.</span>
          </div>
        </div>

        <div className="landing-hero-visual" aria-hidden="true">
          <div className="landing-paper landing-paper-back" />
          <div className="landing-paper landing-question-card">
            <span>Question</span>
            <p>Why can data augmentation improve generalization?</p>
            <p>Provide examples and, if relevant, use equations.</p>
          </div>
          <div className="landing-paper landing-answer-card">
            <span>Your answer</span>
            <i />
            <b />
            <b />
            <b />
          </div>
          <div className="landing-score">
            <strong>8/10</strong>
            <span>
              <CheckCircle2 aria-hidden="true" />
              Good
            </span>
          </div>
          <ol className="landing-timeline">
            {timelineSteps.map((step) => (
              <li key={step.label}>
                <span />
                <strong>{step.label}</strong>
                <em>{step.status}</em>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        className="landing-details"
        id="features"
        aria-label="Product details"
      >
        {detailItems.map((item) => {
          const Icon = item.icon;

          return (
            <article className="landing-detail" key={item.title}>
              <span className="landing-detail-icon">
                <Icon aria-hidden="true" />
              </span>
              <div>
                <h2>{item.title}</h2>
                <p>{item.copy}</p>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
