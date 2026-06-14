import Image from "next/image";
import Link from "next/link";

export function AdminStaticView() {
  return (
    <main className="page admin-page" data-admin-static>
      <section className="review-shell admin-shell" aria-label="Admin traces">
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
            <div className="reader-tabs" role="tablist" aria-label="Waxon views">
              <Link className="reader-tab" href="/review" prefetch={false} role="tab" aria-selected="false">
                Review
              </Link>
              <Link className="reader-tab" href="/learn" prefetch={false} role="tab" aria-selected="false">
                Learn
              </Link>
              <Link className="reader-tab" href="/library" prefetch={false} role="tab" aria-selected="false">
                Library
              </Link>
              <Link className="reader-tab" href="/tags" prefetch={false} role="tab" aria-selected="false">
                Tags
              </Link>
              <Link className="reader-tab reader-tab-active" href="/admin" prefetch={false} role="tab" aria-selected="true">
                Admin
              </Link>
            </div>
          </div>
          <div className="reader-actions reader-actions-placeholder" />
        </header>

        <div className="admin-stage">
          <section className="admin-heading-row">
            <div>
              <p className="admin-kicker">Observability</p>
              <h1>Admin traces</h1>
            </div>
          </section>

          <div className="admin-loading-stage" aria-busy="true" />
        </div>
      </section>
    </main>
  );
}
