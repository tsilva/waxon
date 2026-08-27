"use client";

import { LogOut, User, UserCog } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  reviewToolbarTabFromPathname,
  type ReviewToolbarTab,
} from "@/app/toolbarTypes";
import { useToolbarState } from "@/app/ToolbarState";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

type ReviewToolbarProps = {
  onReviewClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onAdminClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
};

type ReviewToolbarActionsProps = {
  activeTab: ReviewToolbarTab;
  className?: string;
  dueCount: number | null;
  menuAvatarUrl: string | null;
  menuDisplayName: string;
  menuEmail: string;
  onManageAccount: () => void;
  onSignOut: () => void;
};

function tabClass(isActive: boolean, isPending: boolean): string {
  return [
    "reader-tab",
    isActive ? "reader-tab-active" : "",
    isPending ? "reader-tab-loading" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function ReviewToolbar({
  onReviewClick,
  onAdminClick,
}: ReviewToolbarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const activeTab = reviewToolbarTabFromPathname(pathname);
  const { canViewAdmin } = useToolbarState();
  const [pendingTab, setPendingTab] = useState<ReviewToolbarTab | null>(null);

  useEffect(() => {
    setPendingTab(null);
  }, [activeTab]);

  function handleTabClick(
    tab: ReviewToolbarTab,
    customHandler?: (event: ReactMouseEvent<HTMLAnchorElement>) => void,
  ) {
    return (event: ReactMouseEvent<HTMLAnchorElement>) => {
      customHandler?.(event);

      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.currentTarget.target
      ) {
        return;
      }

      if (tab !== activeTab) {
        setPendingTab(tab);
      }
    };
  }

  return (
    <header
      className={`reader-header ${pendingTab ? "reader-header-loading" : ""}`}
    >
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
          className={`reader-tabs ${pendingTab ? "reader-tabs-loading" : ""}`}
          role="tablist"
          aria-label="Waxon views"
          aria-busy={pendingTab ? true : undefined}
        >
          <Link
            className={tabClass(
              activeTab === "review",
              pendingTab === "review",
            )}
            href="/review"
            prefetch={false}
            role="tab"
            id="review-tab"
            aria-selected={activeTab === "review"}
            aria-controls="review-panel"
            onClick={handleTabClick("review", onReviewClick)}
          >
            Review
          </Link>
          <Link
            className={tabClass(
              activeTab === "library",
              pendingTab === "library",
            )}
            href="/library"
            prefetch={false}
            role="tab"
            aria-selected={activeTab === "library"}
            onClick={handleTabClick("library")}
          >
            Library
          </Link>
          {canViewAdmin ? (
            <Link
              className={tabClass(
                activeTab === "admin",
                pendingTab === "admin",
              )}
              href="/admin"
              prefetch={false}
              role="tab"
              aria-selected={activeTab === "admin"}
              onClick={handleTabClick("admin", onAdminClick)}
              onFocus={() => router.prefetch("/admin")}
              onPointerEnter={() => router.prefetch("/admin")}
            >
              Admin
            </Link>
          ) : null}
        </div>
      </div>

      <div className="reader-actions reader-actions-placeholder" />
    </header>
  );
}

export function ReviewToolbarActions({
  activeTab,
  dueCount,
  menuAvatarUrl,
  menuDisplayName,
  menuEmail,
  onManageAccount,
  onSignOut,
  className = "",
}: ReviewToolbarActionsProps) {
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

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
    <div className={`reader-actions ${className}`.trim()}>
      {dueCount === null ? (
        <span className="queue-summary-placeholder" aria-hidden="true" />
      ) : (
        <Link
          className="queue-summary"
          href="/review"
          prefetch={false}
          aria-current={activeTab === "review" ? "page" : undefined}
          title="Open Review"
        >
          {dueCount} due
        </Link>
      )}
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
  );
}
