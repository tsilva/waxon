"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  FileText,
  GitMerge,
  Pencil,
  Search,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { useMemo, useState } from "react";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import type {
  ConceptTaggedQuestionSummary,
  ConceptTagSummary,
} from "@/app/lib/conceptTags";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { ReviewToolbar } from "@/app/ReviewToolbar";

type TagsPageClientProps = {
  initialConceptTags: ConceptTagSummary[];
  initialUser: {
    displayName: string;
    email: string;
    avatarUrl: string | null;
  };
  showAdmin: boolean;
};

type ConceptTagMutationResponse =
  | {
      ok: true;
      conceptTag: ConceptTagSummary;
    }
  | {
      ok: false;
      error?: string;
    };

type ConceptTaggedQuestionsResponse = {
  questions: ConceptTaggedQuestionSummary[];
};

async function patchConceptTag(payload: Record<string, unknown>) {
  const response = await fetch("/api/concept-tags", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as ConceptTagMutationResponse;

  if (!response.ok || !data.ok) {
    throw new Error(data.ok ? "Could not update concept tag." : data.error);
  }

  return data.conceptTag;
}

export default function TagsPageClient({
  initialConceptTags,
  initialUser,
  showAdmin,
}: TagsPageClientProps) {
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const [conceptTags, setConceptTags] = useState(initialConceptTags);
  const [query, setQuery] = useState("");
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [draftSlug, setDraftSlug] = useState("");
  const [mergeSourceSlug, setMergeSourceSlug] = useState<string | null>(null);
  const [mergeTargetSlug, setMergeTargetSlug] = useState("");
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [questionsBySlug, setQuestionsBySlug] = useState(
    new Map<string, ConceptTaggedQuestionSummary[]>(),
  );
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const accountWidgetsCustomPages = useMemo(
    () => createAccountWidgetsCustomPages(),
    [],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleTags = conceptTags.filter((tag) =>
    normalizedQuery ? tag.slug.includes(normalizedQuery) : true,
  );
  const activeTags = visibleTags.filter((tag) => tag.active);
  const mutedTags = visibleTags.filter((tag) => !tag.active);
  const dueCount = conceptTags
    .filter((tag) => tag.active)
    .reduce((total, tag) => total + tag.dueCount, 0);
  const menuAvatarUrl = clerkUser?.imageUrl || initialUser.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    clerkUser?.username ||
    initialUser.displayName ||
    "Account";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress || initialUser.email || "";
  const isLocalAuth = isLocalTestAuthEnabled();

  function replaceConceptTag(nextTag: ConceptTagSummary) {
    setConceptTags((currentTags) => {
      const withoutUpdated = currentTags.filter((tag) => tag.id !== nextTag.id);

      return [...withoutUpdated, nextTag].sort((a, b) =>
        a.slug.localeCompare(b.slug),
      );
    });
  }

  async function toggleTag(tag: ConceptTagSummary) {
    setBusySlug(tag.slug);
    setMessage(null);

    try {
      replaceConceptTag(
        await patchConceptTag({
          action: "set-active",
          slug: tag.slug,
          active: !tag.active,
        }),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update tag.");
    } finally {
      setBusySlug(null);
    }
  }

  async function renameTag(slug: string) {
    setBusySlug(slug);
    setMessage(null);

    try {
      replaceConceptTag(
        await patchConceptTag({
          action: "rename",
          slug,
          toSlug: draftSlug,
        }),
      );
      setEditingSlug(null);
      setDraftSlug("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not rename tag.");
    } finally {
      setBusySlug(null);
    }
  }

  async function mergeTag(slug: string) {
    setBusySlug(slug);
    setMessage(null);

    try {
      const mergedTag = await patchConceptTag({
        action: "merge",
        slug,
        toSlug: mergeTargetSlug,
      });

      setConceptTags((currentTags) =>
        currentTags
          .filter((tag) => tag.slug !== slug && tag.id !== mergedTag.id)
          .concat(mergedTag)
          .sort((a, b) => a.slug.localeCompare(b.slug)),
      );
      setMergeSourceSlug(null);
      setMergeTargetSlug("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not merge tag.");
    } finally {
      setBusySlug(null);
    }
  }

  async function toggleQuestions(tag: ConceptTagSummary) {
    if (expandedSlug === tag.slug) {
      setExpandedSlug(null);
      return;
    }

    setExpandedSlug(tag.slug);

    if (questionsBySlug.has(tag.slug)) {
      return;
    }

    setBusySlug(tag.slug);
    setMessage(null);

    try {
      const response = await fetch(
        `/api/concept-tags?slug=${encodeURIComponent(tag.slug)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as ConceptTaggedQuestionsResponse & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error || "Could not load tagged questions.");
      }

      setQuestionsBySlug((current) => {
        const next = new Map(current);

        next.set(tag.slug, data.questions);
        return next;
      });
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not load tagged questions.",
      );
    } finally {
      setBusySlug(null);
    }
  }

  function renderTagRows(tags: ConceptTagSummary[]) {
    if (tags.length === 0) {
      return <p className="tags-empty">No matching concept tags.</p>;
    }

    return (
      <ol className="tags-list">
        {tags.map((tag) => {
          const isBusy = busySlug === tag.slug;
          const isEditing = editingSlug === tag.slug;
          const isMerging = mergeSourceSlug === tag.slug;
          const isExpanded = expandedSlug === tag.slug;
          const taggedQuestions = questionsBySlug.get(tag.slug) ?? [];

          return (
            <li className="tags-row" key={tag.id}>
              <button
                className={`tags-active-toggle ${
                  tag.active ? "tags-active-toggle-on" : ""
                }`}
                type="button"
                aria-pressed={tag.active}
                aria-label={
                  tag.active ? `Mute ${tag.slug}` : `Activate ${tag.slug}`
                }
                disabled={isBusy}
                onClick={() => void toggleTag(tag)}
              >
                {tag.active ? (
                  <ToggleRight aria-hidden="true" />
                ) : (
                  <ToggleLeft aria-hidden="true" />
                )}
              </button>

              <div className="tags-row-main">
                {isEditing ? (
                  <form
                    className="tags-inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void renameTag(tag.slug);
                    }}
                  >
                    <input
                      className="tags-input"
                      value={draftSlug}
                      onChange={(event) => setDraftSlug(event.target.value)}
                      aria-label={`Rename ${tag.slug}`}
                      disabled={isBusy}
                    />
                    <button
                      className="tags-small-button"
                      type="submit"
                      disabled={isBusy}
                    >
                      Save
                    </button>
                  </form>
                ) : (
                  <p className="tags-slug">{tag.slug}</p>
                )}

                {isMerging ? (
                  <form
                    className="tags-inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mergeTag(tag.slug);
                    }}
                  >
                    <input
                      className="tags-input"
                      value={mergeTargetSlug}
                      onChange={(event) => setMergeTargetSlug(event.target.value)}
                      placeholder="target-slug"
                      aria-label={`Merge ${tag.slug} into`}
                      disabled={isBusy}
                    />
                    <button
                      className="tags-small-button"
                      type="submit"
                      disabled={isBusy}
                    >
                      Merge
                    </button>
                  </form>
                ) : null}
              </div>

              <div className="tags-row-meta">
                <span>{tag.dueCount} due</span>
                <span>{tag.questionCount} questions</span>
              </div>

              <div className="tags-row-actions">
                <button
                  className="deck-icon-button"
                  type="button"
                  title={`View questions tagged ${tag.slug}`}
                  aria-label={`View questions tagged ${tag.slug}`}
                  disabled={isBusy}
                  onClick={() => void toggleQuestions(tag)}
                >
                  <FileText aria-hidden="true" />
                </button>
                <button
                  className="deck-icon-button"
                  type="button"
                  title={`Rename ${tag.slug}`}
                  aria-label={`Rename ${tag.slug}`}
                  disabled={isBusy}
                  onClick={() => {
                    setEditingSlug(isEditing ? null : tag.slug);
                    setDraftSlug(tag.slug);
                    setMergeSourceSlug(null);
                  }}
                >
                  <Pencil aria-hidden="true" />
                </button>
                <button
                  className="deck-icon-button"
                  type="button"
                  title={`Merge ${tag.slug}`}
                  aria-label={`Merge ${tag.slug}`}
                  disabled={isBusy}
                  onClick={() => {
                    setMergeSourceSlug(isMerging ? null : tag.slug);
                    setMergeTargetSlug("");
                    setEditingSlug(null);
                  }}
                >
                  <GitMerge aria-hidden="true" />
                </button>
              </div>

              {isExpanded ? (
                <div className="tags-question-panel">
                  {taggedQuestions.length === 0 ? (
                    <p className="tags-empty">No active questions for this tag.</p>
                  ) : (
                    <ol>
                      {taggedQuestions.map((question) => (
                        <li key={question.questionId}>
                          <span>{question.question}</span>
                          <small>
                            due{" "}
                            {new Intl.DateTimeFormat(undefined, {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            }).format(new Date(question.nextDue))}
                          </small>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <main className="page page-review page-tags">
      <section className="review-shell tags-shell" aria-label="Concept tags">
        <ReviewToolbar
          activeTab="tags"
          dueCount={dueCount}
          showAdmin={showAdmin}
          menuAvatarUrl={menuAvatarUrl}
          menuDisplayName={menuDisplayName}
          menuEmail={menuEmail}
          onManageAccount={() => {
            if (!isLocalAuth) {
              clerk.openUserProfile({
                customPages: accountWidgetsCustomPages,
              });
            }
          }}
          onSignOut={() => void clerk.signOut({ redirectUrl: "/" })}
        />

        <section className="queue-stage tags-stage" aria-labelledby="tags-title">
          <div className="queue-toolbar">
            <div>
              <p className="stats-page-kicker">Concept tags</p>
              <h1 id="tags-title" className="tags-title">
                Review controls
              </h1>
            </div>
            <label className="deck-search-label tags-search-label">
              <span className="sr-only">Search concept tags</span>
              <span className="deck-search-shell">
                <Search aria-hidden="true" />
                <input
                  className="deck-search-input"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search tags"
                />
              </span>
            </label>
          </div>

          {message ? <p className="deck-editor-status">{message}</p> : null}

          <div className="tags-summary-strip">
            <span>{conceptTags.length} tags</span>
            <span>{activeTags.length} active</span>
            <span>{mutedTags.length} muted</span>
          </div>

          <section className="tags-section" aria-label="Active tags">
            <h2>Active</h2>
            {renderTagRows(activeTags)}
          </section>

          <section className="tags-section" aria-label="Muted tags">
            <h2>Muted</h2>
            {renderTagRows(mutedTags)}
          </section>
        </section>
      </section>
    </main>
  );
}
