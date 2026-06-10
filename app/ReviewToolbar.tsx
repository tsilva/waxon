"use client";

import { LogOut, User, UserCog } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

type ReviewToolbarTab = "learn" | "review" | "decks" | "stats" | "admin";

type ReviewToolbarProps = {
  activeTab: ReviewToolbarTab;
  dueCount: number;
  showAdmin: boolean;
  menuAvatarUrl: string | null;
  menuDisplayName: string;
  menuEmail: string;
  onReviewClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onLearnClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onDecksClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onStatsClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onAdminClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onManageAccount: () => void;
  onSignOut: () => void;
};

function tabClass(isActive: boolean): string {
  return `reader-tab ${isActive ? "reader-tab-active" : ""}`;
}

export function ReviewToolbar({
  activeTab,
  dueCount,
  showAdmin,
  menuAvatarUrl,
  menuDisplayName,
  menuEmail,
  onReviewClick,
  onLearnClick,
  onDecksClick,
  onStatsClick,
  onAdminClick,
  onManageAccount,
  onSignOut,
}: ReviewToolbarProps) {
  const router = useRouter();
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (showAdmin) {
      router.prefetch("/admin");
    }
  }, [router, showAdmin]);

  useEffect(() => {
    if (!isUserMenuOpen) {
      return;
    }

    function closeUserMenu(event: globalThis.MouseEvent | globalThis.TouchEvent) {
      const target = event.target;

      if (
        target instanceof Node &&
        userMenuRef.current &&
        !userMenuRef.current.contains(target)
      ) {
        setIsUserMenuOpen(false);
      }
    }

    function closeUserMenuOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setIsUserMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", closeUserMenu);
    window.addEventListener("touchstart", closeUserMenu);
    window.addEventListener("keydown", closeUserMenuOnEscape);

    return () => {
      window.removeEventListener("mousedown", closeUserMenu);
      window.removeEventListener("touchstart", closeUserMenu);
      window.removeEventListener("keydown", closeUserMenuOnEscape);
    };
  }, [isUserMenuOpen]);

  return (
    <header className="reader-header">
      <div className="reader-heading">
        <Link className="reader-brand admin-brand-link" href="/">
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
          <Link
            className={tabClass(activeTab === "learn")}
            href="/learn"
            role="tab"
            id="learn-tab"
            aria-selected={activeTab === "learn"}
            aria-controls="learn-panel"
            onClick={onLearnClick}
          >
            Learn
          </Link>
          <Link
            className={tabClass(activeTab === "review")}
            href="/review"
            role="tab"
            id="review-tab"
            aria-selected={activeTab === "review"}
            aria-controls="review-panel"
            onClick={onReviewClick}
          >
            Review
          </Link>
          <Link
            className={tabClass(activeTab === "decks")}
            href="/decks"
            role="tab"
            id="queue-tab"
            aria-selected={activeTab === "decks"}
            aria-controls="queue-panel"
            onClick={onDecksClick}
          >
            Decks
          </Link>
          {showAdmin ? (
            <Link
              className={tabClass(activeTab === "admin")}
              href="/admin"
              role="tab"
              aria-selected={activeTab === "admin"}
              onClick={onAdminClick}
              onFocus={() => router.prefetch("/admin")}
              onPointerEnter={() => router.prefetch("/admin")}
            >
              Admin
            </Link>
          ) : null}
        </div>
      </div>

      <div className="reader-actions">
        <Link
          className={`queue-summary ${
            activeTab === "stats" ? "queue-summary-active" : ""
          }`}
          href="/stats"
          aria-current={activeTab === "stats" ? "page" : undefined}
          onClick={onStatsClick}
          title="Review stats"
        >
          {dueCount} due
        </Link>
        <div className="user-menu" ref={userMenuRef}>
          <button
            className={`user-menu-trigger ${
              isUserMenuOpen ? "user-menu-trigger-active" : ""
            }`}
            type="button"
            aria-label="Open user menu"
            aria-haspopup="menu"
            aria-expanded={isUserMenuOpen}
            aria-controls="user-menu-panel"
            title="User menu"
            onClick={() => setIsUserMenuOpen((isOpen) => !isOpen)}
          >
            {menuAvatarUrl ? (
              <span
                className="user-avatar-image"
                aria-hidden="true"
                style={{ backgroundImage: `url("${menuAvatarUrl}")` }}
              />
            ) : (
              <User aria-hidden="true" />
            )}
          </button>
          {isUserMenuOpen ? (
            <div
              className="user-menu-panel"
              id="user-menu-panel"
              role="menu"
              aria-label="User menu"
            >
              <div className="user-menu-account">
                {menuAvatarUrl ? (
                  <span
                    className="user-menu-account-avatar"
                    aria-hidden="true"
                    style={{ backgroundImage: `url("${menuAvatarUrl}")` }}
                  />
                ) : (
                  <span className="user-menu-account-avatar" aria-hidden="true">
                    <User aria-hidden="true" />
                  </span>
                )}
                <div>
                  <strong>{menuDisplayName}</strong>
                  {menuEmail ? <span>{menuEmail}</span> : null}
                </div>
              </div>
              <button
                className="user-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsUserMenuOpen(false);
                  onManageAccount();
                }}
              >
                <UserCog aria-hidden="true" />
                <span>Manage accounts</span>
              </button>
              <button
                className="user-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsUserMenuOpen(false);
                  onSignOut();
                }}
              >
                <LogOut aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
