import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import studyCards from "@/public/review/first-question-cards.png";

export function ReviewWelcome() {
  return (
    <div className="review-welcome">
      <Image
        alt=""
        aria-hidden="true"
        className="review-welcome-art"
        loading="eager"
        sizes="240px"
        src={studyCards}
      />
      <p className="review-welcome-kicker">A place for what you learn</p>
      <h2 className="review-welcome-title">
        <span>Keep what’s worth</span>
        <span>remembering.</span>
      </h2>
      <p className="review-welcome-copy">
        <span>Add your first question in Library.</span>{" "}
        <span>Waxon will bring it back when it’s time to review.</span>
      </p>
      <Link className="review-welcome-primary" href="/library">
        Open Library <ArrowRight aria-hidden="true" />
      </Link>
      <p className="review-welcome-note">
        Write a question. Recall it. Keep it.
      </p>
    </div>
  );
}
