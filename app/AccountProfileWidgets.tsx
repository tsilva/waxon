"use client";

import { UserButton } from "@clerk/nextjs";
import { BarChart3, CalendarClock, Gauge, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

type ClerkCustomPage = {
  label: string;
  url: string;
  mountIcon: (el: HTMLDivElement) => void;
  unmountIcon: (el?: HTMLDivElement) => void;
  mount: (el: HTMLDivElement) => void;
  unmount: (el?: HTMLDivElement) => void;
};

const mountedRoots = new WeakMap<HTMLDivElement, Root>();

function mountReactNode(el: HTMLDivElement, node: ReactNode) {
  unmountReactNode(el);

  const root = createRoot(el);

  mountedRoots.set(el, root);
  root.render(node);
}

function unmountReactNode(el?: HTMLDivElement) {
  if (!el) {
    return;
  }

  mountedRoots.get(el)?.unmount();
  mountedRoots.delete(el);
}

function AccountWidgetsIcon() {
  return <Sparkles aria-hidden="true" />;
}

export function AccountProfileWidgets() {
  return (
    <section className="account-profile-widgets" aria-label="Study widgets">
      <div className="account-profile-widgets-header">
        <p>Study widgets</p>
        <h1>Personal review cockpit</h1>
      </div>

      <div className="account-profile-widget-grid" aria-label="Mock account widgets">
        <article className="account-profile-widget">
          <div className="account-profile-widget-icon" aria-hidden="true">
            <Gauge />
          </div>
          <div>
            <span>Review pressure</span>
            <strong>18 due</strong>
          </div>
        </article>
        <article className="account-profile-widget">
          <div className="account-profile-widget-icon" aria-hidden="true">
            <BarChart3 />
          </div>
          <div>
            <span>Recall trend</span>
            <strong>82%</strong>
          </div>
        </article>
        <article className="account-profile-widget">
          <div className="account-profile-widget-icon" aria-hidden="true">
            <CalendarClock />
          </div>
          <div>
            <span>Next focused block</span>
            <strong>Tonight</strong>
          </div>
        </article>
      </div>

      <div className="account-profile-widget-panel">
        <div>
          <span>Suggested focus</span>
          <p>
            Prioritize Deep Learning cards with stale reviews, then clear the
            newest generated probes while the source material is fresh.
          </p>
        </div>
      </div>
    </section>
  );
}

export function AccountWidgetsUserProfilePage() {
  return (
    <UserButton.UserProfilePage
      label="Study widgets"
      labelIcon={<AccountWidgetsIcon />}
      url="study-widgets"
    >
      <AccountProfileWidgets />
    </UserButton.UserProfilePage>
  );
}

export function createAccountWidgetsCustomPages(): ClerkCustomPage[] {
  return [
    {
      label: "Study widgets",
      url: "study-widgets",
      mountIcon: (el) => mountReactNode(el, <AccountWidgetsIcon />),
      unmountIcon: unmountReactNode,
      mount: (el) => mountReactNode(el, <AccountProfileWidgets />),
      unmount: unmountReactNode,
    },
  ];
}
