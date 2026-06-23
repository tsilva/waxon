"use client";

import { ChevronDown, Search, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import type { ConceptTagSummary } from "@/app/lib/conceptTags";
import { libraryTagHref } from "@/app/lib/libraryTagNavigation";
import type {
  QuestionBankItem,
  QuestionBankPage,
  QuestionBankSort,
  QuestionBankStatusFilter,
} from "@/app/lib/questionBank";
import { formatFormulaMarkdown } from "@/app/lib/markdownFormulaFormatting";
import { useToolbarAccount } from "@/app/lib/useToolbarAccount";
import { MarkdownInline } from "@/app/MarkdownContent";
import { PreviousAnswerRow } from "@/app/PreviousAnswerRow";
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

const sortOptions: Array<{
  value: QuestionBankSort;
  label: string;
}> = [
  { value: "due", label: "Due date" },
  { value: "created-desc", label: "Created newest" },
  { value: "created-asc", label: "Created oldest" },
  { value: "updated-desc", label: "Updated newest" },
  { value: "updated-asc", label: "Updated oldest" },
];

const EMPTY_QUESTION_BANK: QuestionBankPage = {
  items: [],
  total: 0,
  hasMore: false,
  nextOffset: null,
};
const LIBRARY_PAGE_SIZE = 50;
const LIBRARY_TAG_SUGGESTION_LIMIT = 8;

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatNextDue(value: number, now: number): string {
  if (!Number.isFinite(value)) {
    return "unknown";
  }

  if (value <= now) {
    return "due now";
  }

  return formatDate(value);
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

function questionBankParams(input: {
  query: string;
  status: QuestionBankStatusFilter;
  tagSlugs: string[];
  sort: QuestionBankSort;
  offset: number;
}): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(LIBRARY_PAGE_SIZE),
    offset: String(Math.max(0, Math.floor(input.offset))),
  });

  if (input.query.trim()) {
    params.set("q", input.query.trim());
  }

  if (input.status !== "all") {
    params.set("status", input.status);
  }

  for (const tagSlug of input.tagSlugs) {
    if (tagSlug) {
      params.append("tag", tagSlug);
    }
  }

  if (input.sort !== "due") {
    params.set("sort", input.sort);
  }

  return params;
}

async function fetchQuestionBankPage(input: {
  query: string;
  status: QuestionBankStatusFilter;
  tagSlugs: string[];
  sort: QuestionBankSort;
  offset: number;
  signal?: AbortSignal;
}): Promise<QuestionBankPage> {
  const response = await fetch(
    `/api/question-bank?${questionBankParams(input).toString()}`,
    {
      cache: "no-store",
      signal: input.signal,
    },
  );
  const data = (await response.json()) as QuestionBankPage & {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error || "Could not load question bank.");
  }

  return data;
}

function tagSearchInputValue(query: string, tagDraft: string | null): string {
  if (tagDraft === null) {
    return query;
  }

  return `${query.trimEnd()}${query.trim() ? " " : ""}#${tagDraft}`;
}

function uniqueTagSlugs(slugs: string[]): string[] {
  return Array.from(
    new Set(
      slugs
        .map((slug) => slug.trim().replace(/^#+/u, ""))
        .filter(Boolean),
    ),
  );
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export default function LibraryPageClient({
  initialQuestionBank = null,
  initialConceptTags = null,
  initialUser,
  showAdmin = false,
}: LibraryPageClientProps) {
  const searchParams = useSearchParams();
  const [questionBank, setQuestionBank] = useState(
    initialQuestionBank ?? EMPTY_QUESTION_BANK,
  );
  const [conceptTags, setConceptTags] = useState(initialConceptTags ?? []);
  const [currentUser, setCurrentUser] = useState(initialUser ?? null);
  const [query, setQuery] = useState(() => searchParams.get("q")?.trim() ?? "");
  const [status, setStatus] = useState<QuestionBankStatusFilter>("all");
  const [selectedTagSlugs, setSelectedTagSlugs] = useState<string[]>(() =>
    uniqueTagSlugs(searchParams.getAll("tag")),
  );
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [activeTagOptionIndex, setActiveTagOptionIndex] = useState(0);
  const [sort, setSort] = useState<QuestionBankSort>("due");
  const [expandedQuestionId, setExpandedQuestionId] = useState<string | null>(null);
  const [selectedQuestionDetails, setSelectedQuestionDetails] =
    useState<QuestionBankItem | null>(null);
  const [isLoading, setIsLoading] = useState(initialQuestionBank === null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isMetadataLoading, setIsMetadataLoading] = useState(
    initialConceptTags === null || initialUser === null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const now = Date.now();
  const activeTags = conceptTags.filter((tag) => tag.active);
  const dueCount = activeTags.reduce((total, tag) => total + tag.dueCount, 0);
  const {
    canViewAdmin,
    menuAvatarUrl,
    menuDisplayName,
    menuEmail,
    onManageAccount,
    onSignOut,
  } = useToolbarAccount(currentUser, {
    localManageHref: "/review",
    localSignOutHref: "/",
    showAdmin,
  });
  const isInitialQuestionBankLoading =
    isLoading && questionBank.items.length === 0 && questionBank.total === 0;
  const questionCountLabel = questionBank.hasMore
    ? `${questionBank.items.length}+ questions`
    : `${questionBank.items.length} questions`;
  const matchingTagOptions = useMemo(() => {
    if (tagDraft === null) {
      return [];
    }

    const draft = tagDraft.trim().toLowerCase();

    return conceptTags
      .filter((tag) => !selectedTagSlugs.includes(tag.slug))
      .filter((tag) => !draft || tag.slug.includes(draft))
      .slice(0, LIBRARY_TAG_SUGGESTION_LIMIT);
  }, [conceptTags, selectedTagSlugs, tagDraft]);
  const safeActiveTagOptionIndex =
    matchingTagOptions.length === 0
      ? 0
      : Math.min(activeTagOptionIndex, matchingTagOptions.length - 1);
  const isTagPickerOpen = tagDraft !== null;
  const searchInputValue = tagSearchInputValue(query, tagDraft);

  useEffect(() => {
    const nextQuery = searchParams.get("q")?.trim() ?? "";
    const nextTagSlugs = uniqueTagSlugs(searchParams.getAll("tag"));

    setQuery((current) => (current === nextQuery ? current : nextQuery));
    setSelectedTagSlugs((current) =>
      stringArraysEqual(current, nextTagSlugs) ? current : nextTagSlugs,
    );
    setTagDraft(null);
    setActiveTagOptionIndex(0);
  }, [searchParams]);

  const addSelectedTag = useCallback((slug: string) => {
    setSelectedTagSlugs((current) =>
      current.includes(slug) ? current : [...current, slug],
    );
    setTagDraft(null);
    setActiveTagOptionIndex(0);
  }, []);

  const removeSelectedTag = useCallback((slug: string) => {
    setSelectedTagSlugs((current) => current.filter((item) => item !== slug));
  }, []);

  const handleSearchInputChange = useCallback((value: string) => {
    const tagTriggerMatch = value.match(/(^|\s)#([^\s#]*)$/u);

    if (tagTriggerMatch?.index !== undefined) {
      const triggerPrefix = tagTriggerMatch[1] ?? "";
      const triggerStart = tagTriggerMatch.index + triggerPrefix.length;

      setQuery(value.slice(0, triggerStart).trimEnd());
      setTagDraft(tagTriggerMatch[2] ?? "");
      setActiveTagOptionIndex(0);
      return;
    }

    setQuery(value);
    setTagDraft(null);
    setActiveTagOptionIndex(0);
  }, []);

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (tagDraft !== null) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveTagOptionIndex((current) =>
            matchingTagOptions.length === 0
              ? 0
              : (current + 1) % matchingTagOptions.length,
          );
          return;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveTagOptionIndex((current) =>
            matchingTagOptions.length === 0
              ? 0
              : (current - 1 + matchingTagOptions.length) %
                  matchingTagOptions.length,
          );
          return;
        }

        if (event.key === "Enter" || event.key === "Tab") {
          const selectedOption = matchingTagOptions[safeActiveTagOptionIndex];

          if (selectedOption) {
            event.preventDefault();
            addSelectedTag(selectedOption.slug);
          }
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          setTagDraft(null);
          setActiveTagOptionIndex(0);
        }

        return;
      }

      if (
        event.key === "Backspace" &&
        query.length === 0 &&
        selectedTagSlugs.length > 0
      ) {
        event.preventDefault();
        setSelectedTagSlugs((current) => current.slice(0, -1));
      }
    },
    [
      addSelectedTag,
      matchingTagOptions,
      query.length,
      safeActiveTagOptionIndex,
      selectedTagSlugs.length,
      tagDraft,
    ],
  );

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
      if (isActive) {
        setIsLoading(true);
        setIsLoadingMore(false);
        setMessage(null);
      }

      fetchQuestionBankPage({
        query,
        status,
        tagSlugs: selectedTagSlugs,
        sort,
        offset: 0,
        signal: controller.signal,
      })
        .then((data) => {
          if (isActive) {
            setQuestionBank(data);
            setExpandedQuestionId(null);
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
  }, [query, status, selectedTagSlugs, sort]);

  const loadMoreQuestions = useCallback(async () => {
    if (questionBank.nextOffset === null || isLoadingMore) {
      return;
    }

    setIsLoadingMore(true);
    setMessage(null);

    try {
      const data = await fetchQuestionBankPage({
        query,
        status,
        tagSlugs: selectedTagSlugs,
        sort,
        offset: questionBank.nextOffset,
      });

      setQuestionBank((current) => {
        const existingIds = new Set(
          current.items.map((item) => item.questionId),
        );
        const appendedItems = data.items.filter(
          (item) => !existingIds.has(item.questionId),
        );

        return {
          ...data,
          items: [...current.items, ...appendedItems],
        };
      });
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not load more questions.",
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    isLoadingMore,
    query,
    questionBank.nextOffset,
    selectedTagSlugs,
    status,
    sort,
  ]);

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
          onManageAccount={onManageAccount}
          onSignOut={onSignOut}
        />

        <section
          className="queue-stage library-stage"
          aria-label="Library"
        >
          <div className="library-filter-row" aria-label="Question bank filters">
            <label className="library-status-filter-label">
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
            <label className="library-sort-filter-label">
              <span>Sort</span>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as QuestionBankSort)
                }
              >
                {sortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div
              className="kb-search-label library-search-label"
              onBlur={(event) => {
                const nextTarget = event.relatedTarget as Node | null;

                if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                  setTagDraft(null);
                  setActiveTagOptionIndex(0);
                }
              }}
            >
              <label className="sr-only" htmlFor="library-question-search">
                Search question bank
              </label>
              <span
                className={`kb-search-shell library-token-search-shell${
                  isTagPickerOpen ? " library-token-search-shell-open" : ""
                }`}
              >
                <Search aria-hidden="true" />
                <span className="library-search-token-row">
                  {selectedTagSlugs.map((slug) => (
                    <button
                      className="library-search-tag-token"
                      key={slug}
                      type="button"
                      aria-label={`Remove tag ${slug}`}
                      onClick={() => removeSelectedTag(slug)}
                    >
                      <span>#{slug}</span>
                      <X aria-hidden="true" />
                    </button>
                  ))}
                  <input
                    id="library-question-search"
                    className="kb-search-input library-token-search-input"
                    type="search"
                    value={searchInputValue}
                    onChange={(event) =>
                      handleSearchInputChange(event.target.value)
                    }
                    onKeyDown={handleSearchKeyDown}
                    placeholder={
                      selectedTagSlugs.length > 0
                        ? "Search or type #"
                        : "Search questions, IDs, or type #tag"
                    }
                    role="combobox"
                    aria-expanded={isTagPickerOpen}
                    aria-controls="library-tag-suggestions"
                    aria-activedescendant={
                      isTagPickerOpen && matchingTagOptions.length > 0
                        ? `library-tag-suggestion-${matchingTagOptions[safeActiveTagOptionIndex].id}`
                        : undefined
                    }
                  />
                </span>
              </span>
              {isTagPickerOpen ? (
                <div
                  className="library-tag-suggestions"
                  id="library-tag-suggestions"
                  role="listbox"
                  aria-label="Tag suggestions"
                >
                  {matchingTagOptions.length === 0 ? (
                    <p>No matching tags</p>
                  ) : (
                    matchingTagOptions.map((tag, index) => (
                      <button
                        className={`library-tag-suggestion${
                          index === safeActiveTagOptionIndex
                            ? " library-tag-suggestion-active"
                            : ""
                        }`}
                        id={`library-tag-suggestion-${tag.id}`}
                        key={tag.id}
                        type="button"
                        role="option"
                        aria-selected={index === safeActiveTagOptionIndex}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          addSelectedTag(tag.slug);
                        }}
                      >
                        <span>#{tag.slug}</span>
                        <small>{tag.questionCount} questions</small>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {message ? <p className="kb-editor-status">{message}</p> : null}

          <div className="tags-summary-strip library-summary-strip">
            <span>{questionCountLabel}</span>
            <span>
              {isLoading || isMetadataLoading || isLoadingMore
                ? "loading"
                : "ready"}
            </span>
          </div>

          {isInitialQuestionBankLoading ? (
            <ol
              className="library-question-list library-question-list-loading"
              aria-label="Loading questions"
              aria-busy="true"
            >
              {Array.from({ length: 8 }, (_, index) => (
                <li
                  className="previous-row previous-row-placeholder library-previous-placeholder"
                  key={index}
                >
                  <div className="previous-placeholder-score" />
                  <div className="previous-placeholder-copy">
                    <span />
                    <span />
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
                const detailId = `library-question-details-${item.questionId.replace(
                  /[^A-Za-z0-9_-]/g,
                  "-",
                )}`;
                const toggleQuestion = () =>
                  setExpandedQuestionId(isExpanded ? null : item.questionId);

                return (
                  <PreviousAnswerRow
                    id={item.questionId}
                    key={item.questionId}
                    question={item.question}
                    status="resolved"
                    score={null}
                    feedback={null}
                    isExpanded={isExpanded}
                    detailId={detailId}
                    className="library-previous-row"
                    onToggle={toggleQuestion}
                    onDetailsClick={() => setSelectedQuestionDetails(item)}
                    questionLabelContent={
                      <div className="library-chip-row">
                        {item.conceptSlugs.length === 0 ? (
                          <span className="library-chip library-chip-muted">
                            untagged
                          </span>
                        ) : (
                          item.conceptSlugs.map((slug) => (
                            <Link
                              className="library-chip library-chip-link"
                              href={libraryTagHref(slug)}
                              key={slug}
                              onClick={(event) => event.stopPropagation()}
                            >
                              #{slug}
                            </Link>
                          ))
                        )}
                      </div>
                    }
                    supportingContent={null}
                    detailsContent={
                      <>
                        {item.conciseAnswer ? (
                          <div className="previous-field">
                            <span className="previous-field-label">Answer</span>
                            <MarkdownInline
                              as="p"
                              className="previous-answer"
                              enableMath
                              text={formatFormulaMarkdown(item.conciseAnswer, {
                                style: "math",
                              })}
                            />
                          </div>
                        ) : null}
                        {item.questionProvenance ? (
                          <div className="previous-field">
                            <span className="previous-field-label">Source</span>
                            <p className="previous-answer previous-answer-empty">
                              {item.questionProvenance}
                            </p>
                          </div>
                        ) : null}
                        <div className="previous-field">
                          <span className="previous-field-label">Created</span>
                          <p className="previous-answer previous-answer-empty">
                            {formatDate(item.createdAt)}
                          </p>
                        </div>
                        <div className="previous-field">
                          <span className="previous-field-label">Updated</span>
                          <p className="previous-answer previous-answer-empty">
                            {formatDate(item.updatedAt)}
                          </p>
                        </div>
                      </>
                    }
                    metaContent={
                      <>
                        <span
                          className={`library-status library-status-${statusLabel}`}
                        >
                          {statusLabel}
                        </span>
                        <span className="previous-time-control">
                          <span className="previous-time">
                            {formatNextDue(item.nextDue, now)}
                          </span>
                          <ChevronDown
                            className="previous-collapse-icon"
                            aria-hidden="true"
                          />
                        </span>
                      </>
                    }
                  />
                );
              })}
            </ol>
          )}

          {questionBank.hasMore && !isInitialQuestionBankLoading ? (
            <button
              className="library-load-more-button"
              type="button"
              disabled={isLoadingMore}
              onClick={() => void loadMoreQuestions()}
            >
              {isLoadingMore ? "Loading..." : "Load more"}
            </button>
          ) : null}
        </section>
      </section>

      {selectedQuestionDetails ? (
        <div
          className="stats-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedQuestionDetails(null);
            }
          }}
        >
          <section
            className="stats-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-details-title"
          >
            <div className="stats-modal-header">
              <div>
                <p className="stats-modal-kicker">Question details</p>
                <div id="library-details-title">
                  <MarkdownInline
                    as="h2"
                    className="stats-modal-title"
                    enableMath
                    text={selectedQuestionDetails.question}
                  />
                </div>
                <p className="stats-modal-question-id">
                  <span>Question ID:</span>
                  <code>{selectedQuestionDetails.questionId}</code>
                </p>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close question details"
                onClick={() => setSelectedQuestionDetails(null)}
              />
            </div>

            <div className="stats-grid" aria-label="Question summary">
              <div className="stats-tile">
                <span>Status</span>
                <strong>{questionStatus(selectedQuestionDetails, now)}</strong>
              </div>
              <div className="stats-tile">
                <span>Next due</span>
                <strong>
                  {formatNextDue(selectedQuestionDetails.nextDue, now)}
                </strong>
              </div>
              <div className="stats-tile">
                <span>Created</span>
                <strong>{formatDate(selectedQuestionDetails.createdAt)}</strong>
              </div>
              <div className="stats-tile">
                <span>Updated</span>
                <strong>{formatDate(selectedQuestionDetails.updatedAt)}</strong>
              </div>
            </div>

            <div className="stats-history-panel">
              <div className="stats-section-heading">
                <h3>Answer</h3>
              </div>
              {selectedQuestionDetails.conciseAnswer ? (
                <MarkdownInline
                  as="p"
                  className="previous-answer"
                  enableMath
                  text={formatFormulaMarkdown(
                    selectedQuestionDetails.conciseAnswer,
                    { style: "math" },
                  )}
                />
              ) : (
                <p className="stats-empty">No answer recorded.</p>
              )}
            </div>

            {selectedQuestionDetails.questionProvenance ? (
              <div className="stats-history-panel">
                <div className="stats-section-heading">
                  <h3>Source</h3>
                </div>
                <p className="previous-answer previous-answer-empty">
                  {selectedQuestionDetails.questionProvenance}
                </p>
              </div>
            ) : null}

            <div className="stats-history-panel">
              <div className="stats-section-heading">
                <h3>Concepts</h3>
              </div>
              {selectedQuestionDetails.conceptSlugs.length === 0 ? (
                <p className="stats-empty">No concepts tagged.</p>
              ) : (
                <div className="stats-concept-list">
                  {selectedQuestionDetails.conceptSlugs.map((slug) => (
                    <Link
                      className="stats-concept-chip stats-concept-chip-link"
                      href={libraryTagHref(slug)}
                      key={slug}
                      onClick={() => setSelectedQuestionDetails(null)}
                    >
                      #{slug}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
