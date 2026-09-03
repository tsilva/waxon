"use client";

import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  Copy,
  Flag,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Tags,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  useAppViewCache,
  type LibraryViewState,
} from "@/app/AppViewCache";
import { MarkdownContent } from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import { QuestionBankFlagDialog } from "@/app/(app)/library/QuestionBankFlagDialog";
import type {
  V2LibraryResponse,
  V2QuestionLifecycle,
  V2Question,
  V2TagRef,
} from "@/app/lib/v2/types";
import { REVIEW_FLAG_REASON_LABELS } from "@/app/lib/v2/reviewFlag";
import {
  LIBRARY_ARCHIVE_FADE_MS,
  removeArchivedQuestionFromView,
} from "@/app/lib/libraryArchiveTransition";

const EMPTY_DATA: V2LibraryResponse = {
  questions: [],
  counts: { active: 0, flagged: 0, archived: 0 },
  nextCursor: null,
};
const FILTERS: Array<{ value: V2QuestionLifecycle | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "flagged", label: "Flagged" },
  { value: "archived", label: "Archived" },
];

const FLAG_REASON_LABELS: Record<string, string> = {
  ...REVIEW_FLAG_REASON_LABELS,
  leading_prompt: "Leading prompt",
  not_answerable: "Not answerable",
  not_atomic: "Not atomic",
  not_recall_oriented: "Not recall-oriented",
  not_self_contained: "Not self-contained",
  prompt_too_vague: "Prompt too vague",
  semantic_quality_failed: "Quality check failed",
  semantic_validation_inconclusive: "Validation inconclusive",
  semantic_validation_unavailable: "Validation unavailable",
};

function flagReasonLabel(reason: string): string {
  return FLAG_REASON_LABELS[reason] ?? reason.replaceAll("_", " ");
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error || "Waxon could not complete that action.");
  return body as T;
}

function QuestionDialog({
  question,
  onClose,
  onSaved,
}: {
  question: V2Question | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const payload = {
      prompt: String(form.get("prompt") ?? ""),
      referenceAnswer: String(form.get("referenceAnswer") ?? ""),
    };
    try {
      if (question) {
        const result = await jsonRequest<{
          lifecycle: V2QuestionLifecycle;
          status: "replaced" | "unchanged";
        }>("/api/v2/library", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "replace", questionId: question.id, ...payload }),
        });
        await onSaved(
          result.status === "unchanged"
            ? "No replacement was needed because the Question is unchanged."
            : result.lifecycle === "flagged"
              ? "Replacement saved to Flagged for attention. The original Question was archived."
              : "Active replacement added. The original Question was archived.",
        );
      } else {
        const result = await jsonRequest<{
          lifecycle: V2QuestionLifecycle;
          status: "created" | "existing";
        }>(
          "/api/v2/library",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              idempotencyKey: crypto.randomUUID(),
            }),
          },
        );
        await onSaved(
          result.status === "existing"
            ? "That question was already in your Library."
            : result.lifecycle === "flagged"
              ? "Question saved to Flagged for attention."
              : "Active Question added to your Library.",
        );
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save question.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="v2-dialog-backdrop" onMouseDown={onClose}>
      <div
        aria-labelledby="question-dialog-title"
        aria-modal="true"
        className="v2-dialog lean-question-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="v2-dialog-heading">
          <div>
            <span className="v2-kicker">Library</span>
            <h2 id="question-dialog-title">{question ? "Replace question" : "Add a question"}</h2>
          </div>
          <button className="v2-icon-button" onClick={onClose} type="button">×</button>
        </div>
        <form className="v2-form" onSubmit={submit}>
          <label>
            Prompt
            <textarea defaultValue={question?.prompt ?? ""} maxLength={16_384} name="prompt" required rows={4} />
          </label>
          <label>
            Answer standard
            <textarea
              defaultValue={question?.referenceAnswer ?? ""}
              maxLength={65_536}
              name="referenceAnswer"
              required
              rows={7}
            />
          </label>
          {question ? <p className="lean-edit-warning">Replacing creates a new Question with reset mastery and archives this Question with its Learning Evidence intact. Quality assessment determines whether the replacement is Active or Flagged.</p> : null}
          {error ? <p className="v2-error" role="alert">{error}</p> : null}
          <div className="v2-dialog-actions">
            <button
              className="v2-button-secondary"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button className="v2-button-primary" disabled={saving} type="submit">
              {saving ? <LoaderCircle className="v2-spin" /> : null}
              {question ? "Replace question" : "Add to Library"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function McpDialog({ onClose }: { onClose: () => void }) {
  const [credential, setCredential] = useState<{ active: boolean; createdAt: string | null } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    jsonRequest<{ active: boolean; createdAt: string | null }>("/api/v2/mcp-credentials")
      .then(setCredential)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load agent access."));
  }, []);

  async function rotate() {
    setWorking(true);
    setError(null);
    try {
      const result = await jsonRequest<{ token: string; createdAt: string }>("/api/v2/mcp-credentials", { method: "POST" });
      setToken(result.token);
      setCredential({ active: true, createdAt: result.createdAt });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create token.");
    } finally {
      setWorking(false);
    }
  }

  async function revoke() {
    setWorking(true);
    try {
      await jsonRequest("/api/v2/mcp-credentials", { method: "DELETE" });
      setToken(null);
      setCredential({ active: false, createdAt: null });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke token.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="v2-dialog-backdrop" onMouseDown={onClose}>
      <div aria-labelledby="mcp-dialog-title" aria-modal="true" className="v2-dialog lean-mcp-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <div className="v2-dialog-heading">
          <div><span className="v2-kicker">Agent access</span><h2 id="mcp-dialog-title">Add questions through MCP</h2></div>
          <button className="v2-icon-button" onClick={onClose} type="button">×</button>
        </div>
        <p>Connect an agent to <code>{typeof window === "undefined" ? "/api/mcp" : `${window.location.origin}/api/mcp`}</code> with a bearer token. It can search this Library and add validated questions.</p>
        {token ? (
          <div className="lean-token-reveal">
            <strong>Copy this token now. It will not be shown again.</strong>
            <code>{token}</code>
            <button onClick={() => navigator.clipboard.writeText(token)} type="button"><Copy /> Copy token</button>
          </div>
        ) : credential?.active ? (
          <p className="lean-token-status">An active token was created {credential.createdAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(credential.createdAt)) : "previously"}.</p>
        ) : null}
        {error ? <p className="v2-error" role="alert">{error}</p> : null}
        <div className="v2-dialog-actions">
          {credential?.active ? <button disabled={working} onClick={revoke} type="button">Revoke token</button> : null}
          <button className="v2-button-primary" disabled={working} onClick={rotate} type="button">
            {working ? <LoaderCircle className="v2-spin" /> : <KeyRound />}
            {credential?.active ? "Rotate token" : "Create token"}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuestionRow({
  question,
  isRemoving,
  onEdit,
  onFlag,
  onTagClick,
  onAction,
}: {
  question: V2Question;
  isRemoving: boolean;
  onEdit: () => void;
  onFlag: () => void;
  onTagClick: (tagId: string) => void;
  onAction: (action: "archive" | "restore") => void;
}) {
  const unresolvedFlags = question.flags.filter((flag) => !flag.resolvedAt);
  const visibleFlags = unresolvedFlags.filter(
    (flag) => flag.reasons.length > 0 || Boolean(flag.detail),
  );
  return (
    <article
      aria-busy={isRemoving ? true : undefined}
      className={`lean-question-row${isRemoving ? " lean-question-row-removing" : ""}`}
    >
      <div className="lean-question-copy">
        <div className="lean-question-meta">
          {question.lifecycle !== "flagged" ? <span className={`lean-lifecycle is-${question.lifecycle}`}>{question.lifecycle[0]?.toUpperCase()}{question.lifecycle.slice(1)}</span> : null}
          {question.relatedTags.length > 0 ? <div className="lean-question-tags" aria-label="Related Tags">{question.relatedTags.map((tag) => <button key={tag.id} onClick={() => onTagClick(tag.id)} type="button">{tag.label}</button>)}</div> : null}
          {question.dueAt ? <span><CalendarClock /> {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(question.dueAt))}</span> : null}
        </div>
        <h2><MarkdownContent className="v2-markdown" enableMath text={question.prompt} /></h2>
        {question.lifecycle === "flagged" && visibleFlags.length > 0 ? (
          <details className="lean-flag-details">
            <summary>Flag details</summary>
            <div className="lean-flag-evidence" aria-label="Flag reasons">
              {visibleFlags.map((flag, flagIndex) => (
                <div key={`${flag.origin}-${flag.createdAt}-${flagIndex}`}>
                  {flag.reasons.length > 0 ? (
                    <span className="lean-flag-reasons">
                      {flag.reasons.map((reason) => (
                        <span key={reason}>{flagReasonLabel(reason)}</span>
                      ))}
                    </span>
                  ) : null}
                  {flag.detail ? (
                    <span className="question-bank-flag-detail">{flag.detail}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <details>
          <summary>Answer standard</summary>
          <MarkdownContent className="v2-markdown" enableMath text={question.referenceAnswer} />
        </details>
      </div>
      <div className="lean-question-actions">
        <button aria-label="Replace question" disabled={isRemoving} onClick={onEdit} title={question.lifecycle === "flagged" ? "Replace with a new Question" : "Replace"} type="button"><Pencil /></button>
        {question.lifecycle === "active" ? <button aria-label="Flag question" disabled={isRemoving} onClick={onFlag} title="Flag" type="button"><Flag /></button> : null}
        {question.lifecycle !== "archived" ? <button aria-label="Archive question" disabled={isRemoving} onClick={() => onAction("archive")} title="Archive" type="button"><Archive /></button> : null}
        {question.lifecycle !== "active" ? <button aria-label="Restore question" disabled={isRemoving} onClick={() => onAction("restore")} title="Restore" type="button"><ArchiveRestore /></button> : null}
      </div>
    </article>
  );
}

export default function LibraryPageClient() {
  const router = useRouter();
  const viewCache = useAppViewCache();
  const [{ initialView, initialData }] = useState(() => {
    const cachedView = viewCache.readLibraryView();
    return {
      initialView: cachedView,
      initialData: viewCache.readLibrary(cachedView),
    };
  });
  const [data, setData] = useState(initialData ?? EMPTY_DATA);
  const [filter, setFilter] = useState<V2QuestionLifecycle | "all">(
    initialView.filter,
  );
  const [search, setSearch] = useState(initialView.search);
  const [tagIds, setTagIds] = useState<string[]>(initialView.tagIds ?? []);
  const [availableTags, setAvailableTags] = useState<V2TagRef[]>([]);
  const [tagNextCursor, setTagNextCursor] = useState<string | null>(null);
  const [loadingTags, setLoadingTags] = useState(true);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<V2Question | null | undefined>(undefined);
  const [flagging, setFlagging] = useState<V2Question | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tagFilterSearch, setTagFilterSearch] = useState("");
  const [removingQuestionIds, setRemovingQuestionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [archiveAnnouncement, setArchiveAnnouncement] = useState(0);
  const hasRenderedDataRef = useRef(Boolean(initialData));
  const tagFilterRef = useRef<HTMLDetailsElement>(null);
  const activeView = useMemo<LibraryViewState>(
    () => ({ filter, search, tagIds }),
    [filter, search, tagIds],
  );

  const load = useCallback(async () => {
    const result = await viewCache.refreshLibrary(activeView);
    hasRenderedDataRef.current = true;
    setData(result);
  }, [activeView, viewCache]);

  const replaceVisibleData = useCallback(
    (next: V2LibraryResponse) => {
      hasRenderedDataRef.current = true;
      setData(next);
      viewCache.writeLibrary(activeView, next);
    },
    [activeView, viewCache],
  );

  useEffect(() => {
    router.prefetch("/review");
    void import("../review/ReviewHydrator").then(
      ({ ReviewHydrator }) => ReviewHydrator.preload(),
    );
    void viewCache.preloadReview();
  }, [router, viewCache]);

  useEffect(() => {
    function closeTagFilter(event: PointerEvent) {
      const tagFilter = tagFilterRef.current;
      if (
        tagFilter?.open &&
        !event.composedPath().includes(tagFilter)
      ) {
        tagFilter.open = false;
        setTagFilterSearch("");
      }
    }

    document.addEventListener("pointerdown", closeTagFilter);
    return () => document.removeEventListener("pointerdown", closeTagFilter);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoadingTags(true);
      try {
        const params = new URLSearchParams();
        if (tagFilterSearch.trim()) params.set("search", tagFilterSearch.trim());
        const result = await jsonRequest<{
          tags: V2TagRef[];
          nextCursor: string | null;
        }>(`/api/v2/tags${params.size > 0 ? `?${params.toString()}` : ""}`);
        if (!cancelled) {
          setAvailableTags(result.tags);
          setTagNextCursor(result.nextCursor);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load Tags.");
        }
      } finally {
        if (!cancelled) setLoadingTags(false);
      }
    }, tagFilterSearch ? 180 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tagFilterSearch]);

  useEffect(() => {
    let cancelled = false;
    viewCache.writeLibraryView(activeView);
    const cached = viewCache.readLibrary(activeView);
    if (cached) {
      hasRenderedDataRef.current = true;
      setData(cached);
      setLoading(false);
    }

    const timer = window.setTimeout(async () => {
      if (!hasRenderedDataRef.current) setLoading(true);
      try {
        const result = await viewCache.refreshLibrary(activeView);
        if (cancelled) return;
        hasRenderedDataRef.current = true;
        setData(result);
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load Library.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, search ? 180 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeView, search, viewCache]);

  const total = useMemo(() => Object.values(data.counts).reduce((sum, value) => sum + value, 0), [data.counts]);

  async function loadMore() {
    if (!data.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("lifecycle", filter);
      if (search.trim()) params.set("search", search.trim());
      for (const tagId of tagIds) params.append("tag", tagId);
      params.set("cursor", data.nextCursor);
      const page = await jsonRequest<V2LibraryResponse>(`/api/v2/library?${params.toString()}`);
      replaceVisibleData({
        ...page,
        questions: [...data.questions, ...page.questions],
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more Questions.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadMoreTags() {
    if (!tagNextCursor || loadingTags) return;
    setLoadingTags(true);
    try {
      const params = new URLSearchParams({ cursor: tagNextCursor });
      if (tagFilterSearch.trim()) params.set("search", tagFilterSearch.trim());
      const result = await jsonRequest<{
        tags: V2TagRef[];
        nextCursor: string | null;
      }>(`/api/v2/tags?${params.toString()}`);
      setAvailableTags((current) => [
        ...current,
        ...result.tags.filter((tag) => !current.some(({ id }) => id === tag.id)),
      ]);
      setTagNextCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more Tags.");
    } finally {
      setLoadingTags(false);
    }
  }

  async function questionAction(questionId: string, action: "archive" | "restore") {
    setError(null);

    if (action === "archive") {
      const scrollLeft = window.scrollX;
      const scrollTop = window.scrollY;
      const fadeDuration =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : LIBRARY_ARCHIVE_FADE_MS;

      setRemovingQuestionIds((current) => new Set(current).add(questionId));

      try {
        await Promise.all([
          jsonRequest("/api/v2/library", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionId, action }),
          }),
          new Promise((resolve) => window.setTimeout(resolve, fadeDuration)),
        ]);
        const next = removeArchivedQuestionFromView(data, questionId);
        replaceVisibleData(next);
        void viewCache.preloadReview();
        setArchiveAnnouncement((current) => current + 1);
        setRemovingQuestionIds((current) => {
          const next = new Set(current);
          next.delete(questionId);
          return next;
        });
        window.requestAnimationFrame(() => window.scrollTo(scrollLeft, scrollTop));
      } catch (caught) {
        setRemovingQuestionIds((current) => {
          const next = new Set(current);
          next.delete(questionId);
          return next;
        });
        throw caught;
      }
      return;
    }

    await jsonRequest("/api/v2/library", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, action }),
    });
    setMessage("Question restored.");
    await load();
    void viewCache.preloadReview();
  }

  return (
    <main className="page">
      <section className="review-shell question-bank-shell">
        <ReviewToolbar />
        <div className="question-bank-stage" id="library-panel" tabIndex={-1}>
          <header className="question-bank-heading">
            <div><span className="v2-kicker">Library</span><h1>{total} questions</h1><p>Add what is worth remembering. Review handles the rest.</p></div>
            <div>
              <button className="lean-secondary-button" onClick={() => setMcpOpen(true)} type="button"><KeyRound /> Agent access</button>
              <button className="v2-button-primary" onClick={() => setEditing(null)} type="button"><Plus /> Add question</button>
            </div>
          </header>
          <div className="question-bank-controls">
            <label className="lean-search"><Search /><span className="sr-only">Search questions</span><input onChange={(event) => {
              const nextSearch = event.currentTarget.value;
              setSearch(nextSearch);
              viewCache.writeLibraryView({ filter, search: nextSearch, tagIds });
            }} placeholder="Search questions and answers" type="search" value={search} /></label>
            <nav aria-label="Question filters">
              {FILTERS.map((item) => (
                <button aria-pressed={filter === item.value} key={item.value} onClick={() => {
                  setFilter(item.value);
                  viewCache.writeLibraryView({ filter: item.value, search, tagIds });
                }} type="button">
                  {item.label}<span>{item.value === "all" ? total : data.counts[item.value]}</span>
                </button>
              ))}
            </nav>
          </div>
          {loadingTags || availableTags.length > 0 || tagIds.length > 0 ? <div className="lean-tag-filter-row">
            <details className="lean-tag-filter" onToggle={(event) => {
              if (!event.currentTarget.open) setTagFilterSearch("");
            }} ref={tagFilterRef}>
              <summary><Tags /> {tagIds.length > 0 ? `${tagIds.length} selected` : "Filter by Tags"}</summary>
              <div>
                <div className="lean-tag-filter-tools">
                  <label className="lean-tag-filter-search"><Search /><span className="sr-only">Search Tags</span><input onChange={(event) => setTagFilterSearch(event.currentTarget.value)} placeholder="Search Tags" type="search" value={tagFilterSearch} /></label>
                  {tagIds.length > 0 ? <button aria-label="Clear selected Tags" className="lean-tag-filter-clear" onClick={() => { setTagIds([]); viewCache.writeLibraryView({ filter, search, tagIds: [] }); }} title="Clear selected Tags" type="button"><X /></button> : null}
                </div>
                {availableTags.map((tag) => <label key={tag.id}><input checked={tagIds.includes(tag.id)} disabled={!tagIds.includes(tag.id) && tagIds.length >= 10} onChange={(event) => {
                  const next = event.currentTarget.checked ? [...tagIds, tag.id] : tagIds.filter((tagId) => tagId !== tag.id);
                  setTagIds(next);
                  viewCache.writeLibraryView({ filter, search, tagIds: next });
                }} type="checkbox" /><span>{tag.label}</span></label>)}
                {loadingTags ? <span className="lean-tag-loading"><LoaderCircle className="v2-spin" /> Loading Tags</span> : null}
                {tagNextCursor ? <button disabled={loadingTags} onClick={() => void loadMoreTags()} type="button">Load more Tags</button> : null}
              </div>
            </details>
          </div> : null}
          {message ? <p className="question-bank-message" role="status">{message}</p> : null}
          {error ? <p className="v2-error" role="alert">{error}</p> : null}
          <div className="lean-question-list">
            {loading ? <div className="question-bank-empty"><LoaderCircle className="v2-spin" /><p>Loading questions…</p></div> : data.questions.length > 0 ? data.questions.map((question) => (
              <QuestionRow
                isRemoving={removingQuestionIds.has(question.id)}
                key={question.id}
                onAction={(action) => void questionAction(question.id, action).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not update question."))}
                onEdit={() => setEditing(question)}
                onFlag={() => setFlagging(question)}
                onTagClick={(tagId) => { setTagIds([tagId]); viewCache.writeLibraryView({ filter, search, tagIds: [tagId] }); }}
                question={question}
              />
            )) : <div className="question-bank-empty"><h2>{search || tagIds.length > 0 ? "No matching questions" : filter === "flagged" ? "No Questions need attention" : filter === "archived" ? "No Archived Questions" : "Your Library is empty"}</h2><p>{search || tagIds.length > 0 ? "Try a different phrase or filter." : filter === "flagged" ? "Nothing is waiting for attention." : filter === "archived" ? "Nothing is out of circulation." : "Add one clear Prompt and its Answer Standard."}</p>{!search && tagIds.length === 0 && (filter === "all" || filter === "active") ? <button className="v2-button-primary" onClick={() => setEditing(null)} type="button"><Plus /> Add your first question</button> : null}</div>}
          </div>
          {data.nextCursor ? <div className="lean-load-more"><button disabled={loadingMore} onClick={() => void loadMore()} type="button">{loadingMore ? <LoaderCircle className="v2-spin" /> : null}Load more</button></div> : null}
          {archiveAnnouncement > 0 ? (
            <p className="sr-only" key={archiveAnnouncement} role="status">
              Question archived.
            </p>
          ) : null}
        </div>
      </section>
      {editing !== undefined ? <QuestionDialog question={editing} onClose={() => setEditing(undefined)} onSaved={async (nextMessage) => { setMessage(nextMessage); await load(); void viewCache.preloadReview(); }} /> : null}
      {flagging ? <QuestionBankFlagDialog
        onClose={() => setFlagging(null)}
        onCommitted={() => {
          setMessage("Question moved to Flagged for attention.");
          document.getElementById("library-panel")?.focus();
        }}
        onFlag={async ({ reasons, detail }) => {
          setError(null);
          await jsonRequest("/api/v2/library", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "flag",
              questionId: flagging.id,
              reasons,
              detail,
            }),
          });
          void viewCache.preloadReview();
        }}
        onRefresh={load}
        onRefreshError={setError}
      /> : null}
      {mcpOpen ? <McpDialog onClose={() => setMcpOpen(false)} /> : null}
    </main>
  );
}
