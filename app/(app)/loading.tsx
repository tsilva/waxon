import Image from "next/image";
import Link from "next/link";

export default function AppRouteLoading() {
  return (
    <main className="page page-route-loading">
      <section className="review-shell" aria-label="Loading Waxon view">
        <header className="reader-header">
          <div className="reader-heading">
            <Link className="reader-brand admin-brand-link" href="/" prefetch={false}>
              <Image
                className="reader-brand-mark"
                src="/brand/icon/header-mark.svg"
                alt=""
                aria-hidden="true"
                width={34}
                height={34}
              />
              <span>waxon</span>
            </Link>
            <div
              className="reader-tabs reader-tabs-route-loading"
              role="tablist"
              aria-label="Waxon views"
              aria-busy="true"
            >
              <Link className="reader-tab" href="/review" prefetch={false} role="tab">
                Review
              </Link>
              <Link className="reader-tab" href="/learn" prefetch={false} role="tab">
                Learn
              </Link>
              <Link className="reader-tab" href="/library" prefetch={false} role="tab">
                Library
              </Link>
              <Link className="reader-tab" href="/tags" prefetch={false} role="tab">
                Tags
              </Link>
            </div>
          </div>
          <div className="reader-actions reader-actions-placeholder" />
        </header>

        <div className="route-loading-stage" aria-hidden="true" />
      </section>
    </main>
  );
}
