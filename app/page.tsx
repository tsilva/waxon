import {
  BarChart3,
  Brain,
  CheckCircle2,
  Clock3,
  FileText,
  Repeat2,
  PencilLine,
  Sparkles,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { LandingAccountActions } from "./LandingAccountActions";

const howItWorksSteps = [
  {
    icon: FileText,
    title: "Answer in your own words",
    copy: "Waxon asks for recall before recognition, so the grade is based on what you can actually produce.",
  },
  {
    icon: Sparkles,
    title: "Get a compact grade",
    copy: "The evaluator scores the answer, points out the missing piece, and keeps the next action small.",
  },
  {
    icon: Repeat2,
    title: "Review when it matters",
    copy: "Cards return on a spaced schedule shaped by your last attempt instead of a fixed checklist.",
  },
];

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
    copy: "Scores and answer history make improvement visible across the knowledge base.",
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
        </nav>
        <LandingAccountActions />
      </header>

      <section
        className="landing-hero"
        aria-labelledby="landing-title"
      >
        <div className="landing-hero-copy">
          <h1 id="landing-title">Practice recall. Get graded.</h1>
          <span className="landing-red-rule" aria-hidden="true" />
          <p>
            Typed answers, model feedback, and spaced review in one quiet loop.
            Wax on, wax off.
          </p>
          <div className="landing-hero-actions">
            <Link className="landing-primary" href="/review" prefetch={false}>
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
        className="landing-section landing-how-section"
        id="how-it-works"
        aria-labelledby="how-it-works-title"
      >
        <div className="landing-section-copy">
          <p className="landing-section-kicker">How it works</p>
          <h2 id="how-it-works-title">A tighter loop for technical recall.</h2>
          <p>
            Waxon keeps the workflow close to studying: answer from memory,
            check the gap, then let the queue bring the card back at the right
            interval.
          </p>
        </div>

        <div className="landing-workflow">
          <Image
            className="landing-workflow-image"
            src="/landing/recall-workflow.png"
            alt="Paper study cards showing an answer field, a score, and spaced review intervals."
            width={1536}
            height={864}
            priority={false}
          />
          <div className="landing-workflow-steps">
            {howItWorksSteps.map((step, index) => {
              const Icon = step.icon;

              return (
                <article className="landing-workflow-step" key={step.title}>
                  <span className="landing-step-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="landing-detail-icon">
                    <Icon aria-hidden="true" />
                  </span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.copy}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section
        className="landing-section landing-features-section"
        id="features"
        aria-labelledby="features-title"
      >
        <div className="landing-section-copy">
          <p className="landing-section-kicker">Features</p>
          <h2 id="features-title">Built for repeated practice, not browsing.</h2>
        </div>

        <div className="landing-details">
          {detailItems.map((item) => {
            const Icon = item.icon;

            return (
              <article className="landing-detail" key={item.title}>
                <span className="landing-detail-icon">
                  <Icon aria-hidden="true" />
                </span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.copy}</p>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <footer className="landing-footer">
        <Link href="/privacy-policy">Privacy policy</Link>
        <Link href="/terms-and-conditions">Terms and conditions</Link>
      </footer>
    </main>
  );
}
