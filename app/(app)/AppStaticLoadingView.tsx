import Image from "next/image";
import Link from "next/link";
import { ReviewLoadingStage } from "./review/ReviewLoading";

type AppStaticLoadingViewProps = {
  staticView?: "review" | "library" | "admin";
  showAccountPlaceholder?: boolean;
};

const staticViewAttributes = {
  review: { "data-review-static": true },
  library: { "data-library-static": true },
  admin: { "data-admin-static": true },
} as const;

const readerTabs = [
  ["Review", "/review"],
  ["Library", "/library"],
] as const;

export function AppStaticLoadingView({
  staticView,
  showAccountPlaceholder = false,
}: AppStaticLoadingViewProps) {
  const markerAttributes = staticView
    ? staticViewAttributes[staticView]
    : undefined;

  return (
    <main className="page page-route-loading" {...markerAttributes}>
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
              className="reader-tabs"
              role="tablist"
              aria-label="Waxon views"
              aria-busy="true"
            >
              {readerTabs.map(([label, href]) => (
                <Link
                  className={`reader-tab${staticView === href.slice(1) ? " reader-tab-active" : ""}`}
                  aria-selected={staticView === href.slice(1)}
                  href={href}
                  key={href}
                  prefetch={false}
                  role="tab"
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>
          <div className="reader-actions reader-actions-placeholder" aria-hidden="true">
            {showAccountPlaceholder ? <>
              <span className="queue-summary-placeholder review-skeleton" />
              <span className="review-skeleton user-menu-placeholder" />
            </> : null}
          </div>
        </header>

        {staticView === "review" ? (
          <ReviewLoadingStage />
        ) : (
          <div className="route-loading-stage" aria-hidden="true" />
        )}
      </section>
    </main>
  );
}
