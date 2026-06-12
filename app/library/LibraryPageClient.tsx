"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import { isAdminEmail } from "@/app/lib/adminAccess";
import type { ConceptTagSummary } from "@/app/lib/conceptTags";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import type {
  QuestionBankItem,
  QuestionBankPage,
  QuestionBankStatusFilter,
} from "@/app/lib/questionBank";
import { MarkdownInline } from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";

type UserProfileResponse = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type LibraryPageClientProps = {
  initialQuestionBank?: QuestionBankPage | null;
  initialConceptTags?: ConceptTagSummary[] | null;
  initialUser?: {
    displayName: string;
    email: string;
    avatarUrl: string | null;
  } | null;
  showAdmin?: boolean;
};

const statusOptions: Array<{
  value: QuestionBankStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "due", label: "Due" },
  { value: "flagged", label: "Flagged" },
  { value: "untagged", label: "Untagged" },
];

const EMPTY_QUESTION_BANK: QuestionBankPage = {
  items: [],
  total: 0,
};

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "unscheduled";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function questionStatus(item: QuestionBankItem, now: number): string {
  if (item.flaggedAt) {
    return "flagged";
  }

  if (item.nextDue <= now) {
    return "due";
  }

  return "scheduled";
}

export default function LibraryPageClient({
  initialQuestionBank = null,
  initialConceptTags = null,
  initialUser,
  showAdmin = false,
}: LibraryPageClientProps) {
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const [questionBank, setQuestionBank] = useState(
    initialQuestionBank ?? EMPTY_QUESTION_BANK,
  );
  const [conceptTags, setConceptTags] = useState(initialConceptTags ?? []);
  const [currentUser, setCurrentUser] = useState(initialUser ?? null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<QuestionBankStatusFilter>("all");
  const [tagSlug, setTagSlug] = useState("");
  const [expandedQuestionId, setExpandedQuestionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(initialQuestionBank === null);
  const [isMetadataLoading, setIsMetadataLoading] = useState(
    initialConceptTags === null || initialUser === null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const accountWidgetsCustomPages = useMemo(
    () => createAccountWidgetsCustomPages(),
    [],
  );
  const now = Date.now();
  const activeTags = conceptTags.filter((tag) => tag.active);
  const dueCount = activeTags.reduce((total, tag) => total + tag.dueCount, 0);
  const canViewAdmin =
    showAdmin ||
    isAdminEmail(
      clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email,
    );
  const menuAvatarUrl = clerkUser?.imageUrl || currentUser?.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    clerkUser?.username ||
    currentUser?.displayName ||
    "Account";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email || "";
  const isLocalAuth = isLocalTestAuthEnabled();
  const isInitialQuestionBankLoading =
    isLoading && questionBank.items.length === 0 && questionBank.total === 0;

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;

    async function loadShellData() {
      setIsMetadataLoading(true);

      try {
        const [userResponse, tagsResponse] = await Promise.all([
          fetch("/api/user", { cache: "no-store", signal: controller.signal }),
          fetch("/api/concept-tags", {
            cache: "no-store",
            signal: controller.signal,
          }),
        ]);
        const userData = (await userResponse.json()) as UserProfileResponse & {
          error?: string;
        };
        const tagsData = (await tagsResponse.json()) as {
          conceptTags?: ConceptTagSummary[];
          error?: string;
        };

        if (!userResponse.ok) {
          throw new Error(userData.error || "Could not load profile.");
        }

        if (!tagsResponse.ok) {
          throw new Error(tagsData.error || "Could not load tags.");
        }

        if (isActive) {
          setCurrentUser(userData);
          setConceptTags(tagsData.conceptTags ?? []);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (isActive) {
          setMessage(error instanceof Error ? error.message : "Could not load data.");
        }
      } finally {
        if (isActive) {
          setIsMetadataLoading(false);
        }
      }
    }

    void loadShellData();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams();

      if (query.trim()) {
        params.set("q", query.trim());
      }

      if (status !== "all") {
        params.set("status", status);
      }

      if (tagSlug) {
        params.set("tag", tagSlug);
      }

      params.set("limit", "500");
      if (isActive) {
        setIsLoading(true);
        setMessage(null);
      }

      fetch(`/api/question-bank?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = (await response.json()) as QuestionBankPage & {
            error?: string;
          };

          if (!response.ok) {
            throw new Error(data.error || "Could not load question bank.");
          }

          if (isActive) {
            setQuestionBank(data);
          }
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }

          if (isActive) {
            setMessage(
              error instanceof Error ? error.message : "Could not load question bank.",
            );
          }
        })
        .finally(() => {
          if (isActive) {
            setIsLoading(false);
          }
        });
    }, 220);

    return () => {
      isActive = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, status, tagSlug]);

  return (
    <main className="page page-review page-library">
      <section className="review-shell library-shell" aria-label="Question bank">
        <ReviewToolbar
          activeTab="library"
          dueCount={dueCount}
          showAdmin={canViewAdmin}
          menuAvatarUrl={menuAvatarUrl}
          menuDisplayName={menuDisplayName}
          menuEmail={menuEmail}
          onManageAccount={() => {
            if (isLocalAuth) {
              window.location.assign("/review");
            } else {
              clerk.openUserProfile({
                customPages: accountWidgetsCustomPages,
              });
            }
          }}
          onSignOut={() => {
            if (isLocalAuth) {
              window.location.assign("/");
            } else {
              void clerk.signOut({ redirectUrl: "/" });
            }
          }}
        />

        <section
          className="queue-stage library-stage"
          aria-labelledby="library-title"
        >
          <div className="queue-toolbar library-toolbar">
            <div>
              <p className="stats-page-kicker">Question bank</p>
              <h1 id="library-title" className="tags-title">
                Library
              </h1>
            </div>
            <label className="deck-search-label library-search-label">
              <span className="sr-only">Search question bank</span>
              <span className="deck-search-shell">
                <Search aria-hidden="true" />
                <input
                  className="deck-search-input"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search questions"
                />
              </span>
            </label>
          </div>

          <div className="library-filter-row" aria-label="Question bank filters">
            <label>
              <span>Status</span>
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as QuestionBankStatusFilter)
                }
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Tag</span>
              <select
                value={tagSlug}
                onChange={(event) => setTagSlug(event.target.value)}
              >
                <option value="">Any tag</option>
                {conceptTags.map((tag) => (
                  <option key={tag.id} value={tag.slug}>
                    {tag.slug}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {message ? <p className="deck-editor-status">{message}</p> : null}

          <div className="tags-summary-strip library-summary-strip">
            <span>{questionBank.total} questions</span>
            <span>{questionBank.items.length} shown</span>
            <span>{isLoading || isMetadataLoading ? "loading" : "ready"}</span>
          </div>

          {isInitialQuestionBankLoading ? (
            <ol
              className="library-question-list library-question-list-loading"
              aria-label="Loading questions"
              aria-busy="true"
            >
              {Array.from({ length: 8 }, (_, index) => (
                <li className="library-question-row" key={index}>
                  <span className="library-question-toggle deck-skeleton-toggle" />
                  <div className="library-question-main">
                    <span className="admin-skeleton-line library-skeleton-title" />
                    <span className="admin-skeleton-line library-skeleton-copy" />
                    <div className="library-chip-row">
                      <span className="admin-skeleton-pill" />
                      <span className="admin-skeleton-pill" />
                    </div>
                  </div>
                  <div className="library-question-meta">
                    <span className="admin-skeleton-pill" />
                    <span className="admin-skeleton-line library-skeleton-date" />
                  </div>
                </li>
              ))}
            </ol>
          ) : questionBank.items.length === 0 ? (
            <p className="tags-empty">No matching questions.</p>
          ) : (
            <ol className="library-question-list">
              {questionBank.items.map((item) => {
                const isExpanded = expandedQuestionId === item.questionId;
                const statusLabel = questionStatus(item, now);

                return (
                  <li className="library-question-row" key={item.questionId}>
                    <button
                      className="library-question-toggle"
                      type="button"
                      aria-expanded={isExpanded}
                      aria-label={
                        isExpanded
                          ? `Collapse ${item.question}`
                          : `Expand ${item.question}`
                      }
                      onClick={() =>
                        setExpandedQuestionId(isExpanded ? null : item.questionId)
                      }
                    >
                      {isExpanded ? (
                        <ChevronDown aria-hidden="true" />
                      ) : (
                        <ChevronRight aria-hidden="true" />
                      )}
                    </button>
                    <div className="library-question-main">
                      <MarkdownInline
                        as="p"
                        className="library-question-text"
                        enableMath
                        text={item.question}
                      />
                      <div className="library-chip-row">
                        {item.conceptSlugs.length === 0 ? (
                          <span className="library-chip library-chip-muted">
                            untagged
                          </span>
                        ) : (
                          item.conceptSlugs.map((slug) => (
                            <span className="library-chip" key={slug}>
                              {slug}
                            </span>
                          ))
                        )}
                      </div>
                      {isExpanded ? (
                        <div className="library-question-detail">
                          {item.conciseAnswer ? (
                            <p>
                              <strong>Answer</strong>
                              <span>{item.conciseAnswer}</span>
                            </p>
                          ) : null}
                          {item.questionProvenance ? (
                            <p>
                              <strong>Source</strong>
                              <span>{item.questionProvenance}</span>
                            </p>
                          ) : null}
                          <p>
                            <strong>Created</strong>
                            <span>{formatDate(item.createdAt)}</span>
                          </p>
                        </div>
                      ) : null}
                    </div>
                    <div className="library-question-meta">
                      <span className={`library-status library-status-${statusLabel}`}>
                        {statusLabel}
                      </span>
                      <span>{formatDate(item.nextDue)}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </section>
    </main>
  );
}
