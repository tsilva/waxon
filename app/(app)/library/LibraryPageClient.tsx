"use client";

import {
  Archive,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  FolderSearch,
  Link2,
  LoaderCircle,
  Merge,
  MoreHorizontal,
  Pause,
  Pencil,
  Plus,
  RotateCcw,
  Route,
  Search,
  Sparkles,
  Split,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { MarkdownContent } from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import { inferSourceCapture } from "@/app/lib/v2/sourceCapture";
import type {
  V2LibraryResponse,
  V2Lifecycle,
  V2Question,
} from "@/app/lib/v2/types";

type LibraryView =
  | "all"
  | V2Lifecycle
  | "sources"
  | "concepts"
  | "attention";
type CaptureKind = "source" | "question";
type SourceManifest = {
  targets: Array<{
    id: string;
    type: string;
    statement: string;
    status: "covered" | "weak" | "missing" | "ignored" | "unresolved";
    requirement: "required" | "optional" | "excluded" | "unsupported";
    confidence: number | null;
    mastered: boolean;
    ignoreReason: string | null;
    evidenceQuote: string | null;
    questions: Array<{
      id: string;
      prompt: string;
      lifecycle: V2Lifecycle;
    }>;
  }>;
};

const EMPTY_LIBRARY: V2LibraryResponse = {
  questions: [],
  sources: [],
  counts: {
    draft: 0,
    new: 0,
    learning: 0,
    review: 0,
    paused: 0,
    archived: 0,
    suspended: 0,
    trash: 0,
    superseded: 0,
  },
  concepts: [],
  waitingNew: 0,
  healthCount: 0,
};

const QUESTION_VIEWS: Array<{
  value: LibraryView;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "new", label: "Waiting" },
  { value: "learning", label: "Learning" },
  { value: "review", label: "Reviewing" },
  { value: "attention", label: "Needs attention" },
  { value: "paused", label: "Paused" },
  { value: "trash", label: "Trash" },
];

const ACTIVE_GENERATION_RUNS = new Set([
  "queued",
  "preparing",
  "mapping",
  "matching",
  "drafting",
  "criticizing",
  "persisting",
]);
const SOURCE_BUILD_MESSAGE =
  "Waxon is building a mastery question set in the background.";

function viewCount(data: V2LibraryResponse, view: LibraryView): number | null {
  if (view === "all") {
    return Object.entries(data.counts)
      .filter(([lifecycle]) => lifecycle !== "trash" && lifecycle !== "superseded")
      .reduce((sum, [, count]) => sum + count, 0);
  }
  if (view === "sources") {
    return data.sources.length;
  }
  if (view === "concepts") {
    return data.concepts.length;
  }
  if (view === "attention") {
    return data.healthCount;
  }
  return data.counts[view];
}

async function jsonRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error || "Waxon could not complete that action.");
  }
  return body as T;
}

function relativeDue(value: string | null): string {
  if (!value) {
    return "Not introduced";
  }
  const milliseconds = new Date(value).getTime() - Date.now();
  if (milliseconds <= 0) {
    return "Due now";
  }
  const hours = Math.ceil(milliseconds / 3_600_000);
  if (hours < 24) {
    return `Due in ${hours}h`;
  }
  return `Due in ${Math.ceil(hours / 24)}d`;
}

function lifecycleLabel(value: V2Lifecycle): string {
  return value === "new"
    ? "Waiting"
    : value === "draft"
      ? "Inbox"
      : value[0].toUpperCase() + value.slice(1);
}

function CaptureDialog({
  onClose,
  onCaptured,
}: {
  onClose: () => void;
  onCaptured: (message: string) => void;
}) {
  const [kind, setKind] = useState<CaptureKind>("source");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      prior?.focus();
    };
  }, [isSaving, onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      if (kind === "question") {
        await jsonRequest("/api/v2/library", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: form.get("prompt"),
            referenceAnswer: form.get("referenceAnswer"),
            target: form.get("target"),
            answerMode: form.get("answerMode"),
          }),
        });
        onCaptured("Question saved. Waxon is checking its quality and overlap.");
      } else if (file) {
        const upload = new FormData();
        upload.set("file", file);
        await jsonRequest("/api/v2/sources/upload", {
          method: "POST",
          body: upload,
        });
        onCaptured(SOURCE_BUILD_MESSAGE);
      } else {
        const sourceInput = String(form.get("sourceInput") ?? "").trim();
        if (!sourceInput) {
          throw new Error(
            "Enter a topic, paste source material, add a URL, or attach a file.",
          );
        }
        const source = inferSourceCapture(sourceInput);
        await jsonRequest("/api/v2/sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(source),
        });
        onCaptured(SOURCE_BUILD_MESSAGE);
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="v2-dialog-backdrop" onMouseDown={onClose}>
      <div
        aria-labelledby="capture-title"
        aria-modal="true"
        className="v2-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="v2-dialog-heading">
          <div>
            <span className="v2-kicker">Build your bank</span>
            <h2 id="capture-title">What do you want to learn?</h2>
          </div>
          <button
            aria-label="Close"
            className="v2-icon-button"
            disabled={isSaving}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div
          className="v2-capture-tabs is-compact"
          role="tablist"
          aria-label="Capture type"
        >
          {(
            [
              ["source", "Topic or source", BookOpen],
              ["question", "One question", Sparkles],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              aria-selected={kind === value}
              className={kind === value ? "is-active" : ""}
              disabled={isSaving}
              key={value}
              onClick={() => {
                setKind(value);
                setError(null);
              }}
              role="tab"
              type="button"
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        <form className="v2-form" onSubmit={submit}>
          {kind === "question" ? (
            <>
              <label>
                Question
                <textarea
                  autoFocus
                  maxLength={16_384}
                  name="prompt"
                  placeholder="e.g. Why does self-attention divide logits by √dₖ?"
                  required
                  rows={3}
                />
              </label>
              <label>
                Reference answer
                <textarea
                  maxLength={65_536}
                  name="referenceAnswer"
                  placeholder="The complete answer you want to retrieve."
                  required
                  rows={5}
                />
              </label>
              <label>
                Atomic recall target
                <input
                  maxLength={4_000}
                  name="target"
                  placeholder="What single thing should this test?"
                />
              </label>
              <label>
                Evaluation
                <select defaultValue="semantic" name="answerMode">
                  <option value="semantic">Meaning (recommended)</option>
                  <option value="rubric">Rubric / multi-point</option>
                  <option value="exact">Exact form</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                Topic, request, URL, or pasted material
                <textarea
                  autoFocus
                  disabled={Boolean(file)}
                  maxLength={1_000_000}
                  name="sourceInput"
                  placeholder={
                    "Proximal Policy Optimization\n\n—or paste notes, a paper section, or a public URL"
                  }
                  required={!file}
                  rows={8}
                />
              </label>
              <div className="v2-source-divider"><span>or</span></div>
              <label className="v2-file-picker is-compact">
                <Upload aria-hidden="true" />
                <strong>{file?.name ?? "Attach a PDF or text file"}</strong>
                <span>PDF, Markdown, CSV, or plain text · up to 20 MB</span>
                <input
                  accept=".pdf,.txt,.md,.markdown,.csv,application/pdf,text/plain,text/markdown,text/csv"
                  name="file"
                  onChange={(event) => {
                    setFile(event.currentTarget.files?.[0] ?? null);
                    setError(null);
                  }}
                  type="file"
                />
              </label>
              {file ? (
                <button
                  className="v2-clear-file"
                  onClick={() => setFile(null)}
                  type="button"
                >
                  <X /> Use text instead
                </button>
              ) : null}
              <p className="v2-form-note">
                Waxon maps the smallest question set that demonstrates mastery,
                checks it against your existing bank, and only adds clear,
                well-supported questions. For a topic, it can use model knowledge
                and research when freshness matters.
              </p>
            </>
          )}
          {error ? <p className="v2-error" role="alert">{error}</p> : null}
          <div className="v2-dialog-actions">
            <button
              className="v2-button-secondary"
              disabled={isSaving}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button className="v2-button-primary" disabled={isSaving} type="submit">
              {isSaving ? <LoaderCircle className="v2-spin" /> : <Plus />}
              {kind === "question" ? "Save question" : "Build question set"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function QuestionRow({
  question,
  onAction,
}: {
  question: V2Question;
  onAction: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<"details" | "edit" | "split">("details");
  const [busy, setBusy] = useState(false);

  async function action(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await onAction({ questionId: question.id, ...body });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`v2-question-row ${expanded ? "is-expanded" : ""}`}>
      <button
        aria-expanded={expanded}
        className="v2-question-main"
        onClick={() => {
          setExpanded((value) => !value);
          setMode("details");
        }}
        type="button"
      >
        <span className={`v2-lifecycle-dot is-${question.lifecycle}`} />
        <span>
          <strong>{question.prompt}</strong>
          <small>
            {lifecycleLabel(question.lifecycle)} · {relativeDue(question.dueAt)}
            {question.concepts.length > 0
              ? ` · ${question.concepts.slice(0, 3).join(", ")}`
              : ""}
          </small>
        </span>
        {question.quality !== "distinct" ? (
          <span className={`v2-quality is-${question.quality}`}>
            {question.quality === "pending" ? "Checking" : question.quality}
          </span>
        ) : null}
        <ChevronDown aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="v2-question-details">
          {mode === "details" ? (
            <>
              <div className="v2-answer-block">
                <span>Reference answer</span>
                <MarkdownContent
                  className="v2-markdown"
                  enableMath
                  text={question.referenceAnswer}
                />
              </div>
              <dl className="v2-metadata-grid">
                <div>
                  <dt>Recall target</dt>
                  <dd>{question.target}</dd>
                </div>
                <div>
                  <dt>Evaluation</dt>
                  <dd>{question.answerMode}</dd>
                </div>
                <div>
                  <dt>Sources</dt>
                  <dd>{question.sourceTitles.join(", ") || "Learner attestation"}</dd>
                </div>
                <div>
                  <dt>Recall estimate</dt>
                  <dd>
                    {question.retrievability === null
                      ? "Not measured"
                      : `${Math.round(question.retrievability * 100)}%`}
                  </dd>
                </div>
              </dl>
              {question.qualityReasons.length > 0 ? (
                <div className="v2-health-note">
                  <CircleAlert aria-hidden="true" />
                  <span>{question.qualityReasons.join(" ")}</span>
                </div>
              ) : null}
              <div className="v2-row-actions">
                {question.lifecycle === "draft" &&
                question.quality === "distinct" ? (
                  <button
                    disabled={busy}
                    onClick={() => action({ action: "accept" })}
                    type="button"
                  >
                    <Check /> Accept into bank
                  </button>
                ) : null}
                <button onClick={() => setMode("edit")} type="button">
                  <Pencil /> Edit
                </button>
                <button onClick={() => setMode("split")} type="button">
                  <Split /> Split
                </button>
                {question.duplicateOfQuestionId ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      action({
                        action: "merge",
                        canonicalQuestionId: question.duplicateOfQuestionId,
                        redundantQuestionId: question.id,
                      })
                    }
                    type="button"
                  >
                    <Merge /> Merge into match
                  </button>
                ) : null}
                {question.lifecycle === "paused" ||
                question.lifecycle === "archived" ||
                question.lifecycle === "trash" ? (
                  <button
                    disabled={busy}
                    onClick={() => action({ action: "restore" })}
                    type="button"
                  >
                    <RotateCcw /> Restore
                  </button>
                ) : (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => action({ action: "pause" })}
                      type="button"
                    >
                      <Pause /> Pause
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => action({ action: "archive" })}
                      type="button"
                    >
                      <Archive /> Archive
                    </button>
                    <button
                      className="is-danger"
                      disabled={busy}
                      onClick={() => action({ action: "trash" })}
                      type="button"
                    >
                      <Trash2 /> Trash
                    </button>
                  </>
                )}
              </div>
            </>
          ) : mode === "edit" ? (
            <form
              className="v2-inline-editor"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                await action({
                  action: "edit",
                  prompt: form.get("prompt"),
                  referenceAnswer: form.get("referenceAnswer"),
                  target: form.get("target"),
                  answerMode: form.get("answerMode"),
                });
                setMode("details");
              }}
            >
              <label>
                Question
                <textarea defaultValue={question.prompt} name="prompt" required rows={3} />
              </label>
              <label>
                Reference answer
                <textarea
                  defaultValue={question.referenceAnswer}
                  name="referenceAnswer"
                  required
                  rows={5}
                />
              </label>
              <label>
                Recall target
                <input defaultValue={question.target} name="target" required />
              </label>
              <label>
                Evaluation
                <select defaultValue={question.answerMode} name="answerMode">
                  <option value="semantic">Meaning</option>
                  <option value="rubric">Rubric</option>
                  <option value="exact">Exact</option>
                </select>
              </label>
              <p>
                Changing the recall target resets mastery. Wording-only edits
                preserve it.
              </p>
              <div className="v2-dialog-actions">
                <button onClick={() => setMode("details")} type="button">
                  Cancel
                </button>
                <button className="v2-button-primary" disabled={busy} type="submit">
                  Save revision
                </button>
              </div>
            </form>
          ) : (
            <form
              className="v2-inline-editor"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                await action({
                  action: "split",
                  children: [0, 1].map((index) => ({
                    prompt: form.get(`prompt-${index}`),
                    referenceAnswer: form.get(`answer-${index}`),
                    target: form.get(`target-${index}`),
                    answerMode: question.answerMode,
                  })),
                });
              }}
            >
              <p>
                Replace this broad question with two atomic questions. Its
                history remains immutable; mastery does not transfer.
              </p>
              {[0, 1].map((index) => (
                <fieldset key={index}>
                  <legend>Child question {index + 1}</legend>
                  <label>
                    Question
                    <input name={`prompt-${index}`} required />
                  </label>
                  <label>
                    Reference answer
                    <textarea name={`answer-${index}`} required rows={3} />
                  </label>
                  <label>
                    Recall target
                    <input name={`target-${index}`} required />
                  </label>
                </fieldset>
              ))}
              <div className="v2-dialog-actions">
                <button onClick={() => setMode("details")} type="button">
                  Cancel
                </button>
                <button className="v2-button-primary" disabled={busy} type="submit">
                  Create split
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </article>
  );
}

export default function LibraryPageClient() {
  const [data, setData] = useState(EMPTY_LIBRARY);
  const [view, setView] = useState<LibraryView>("all");
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const [sourceManifests, setSourceManifests] = useState<
    Record<string, SourceManifest>
  >({});

  const load = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (
      view !== "all" &&
      view !== "sources" &&
      view !== "concepts" &&
      view !== "attention"
    ) {
      params.set("lifecycle", view);
    }
    if (query.trim()) {
      params.set("search", query.trim());
    }
    const next = await jsonRequest<V2LibraryResponse>(
      `/api/v2/library?${params.toString()}`,
      { signal },
    );
    setData(next);
    setError(null);
  }, [query, view]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setIsLoading(true);
      load(controller.signal)
        .catch((caught) => {
          if (!controller.signal.aborted) {
            setError(caught instanceof Error ? caught.message : "Could not load Library.");
          }
        })
        .finally(() => setIsLoading(false));
    }, query ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, query]);

  useEffect(() => {
    const needsPolling =
      data.sources.some(
        (source) =>
          (source.run && ACTIVE_GENERATION_RUNS.has(source.run.status)) ||
          ["captured", "processing"].includes(source.status),
      ) ||
      data.questions.some(
        (question) => question.quality === "pending",
      );
    if (!needsPolling) {
      return;
    }
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [data.questions, data.sources, load]);

  useEffect(() => {
    if (
      message === SOURCE_BUILD_MESSAGE &&
      data.sources.length > 0 &&
      !data.sources.some(
        (source) =>
          source.run && ACTIVE_GENERATION_RUNS.has(source.run.status),
      )
    ) {
      setMessage(null);
    }
  }, [data.sources, message]);

  const visibleQuestions = useMemo(
    () =>
      view === "attention"
        ? data.questions.filter(
            (question) =>
              question.lifecycle === "draft" ||
              question.lifecycle === "suspended" ||
              question.quality === "uncertain" ||
              question.quality === "duplicate" ||
              question.quality === "rejected",
          )
        : data.questions,
    [data.questions, view],
  );
  const readyDraftIds = useMemo(
    () =>
      visibleQuestions
        .filter(
          (question) =>
            question.lifecycle === "draft" &&
            question.quality === "distinct",
        )
        .slice(0, 50)
        .map((question) => question.id),
    [visibleQuestions],
  );

  async function questionAction(body: Record<string, unknown>) {
    setError(null);
    try {
      await jsonRequest("/api/v2/library", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setMessage("Library updated.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update.");
    }
  }

  async function sourceAction(sourceId: string, action: string) {
    setError(null);
    try {
      if (action === "retry") {
        setExpandedSourceId(null);
        setSourceManifests({});
      }
      if (action === "erase") {
        const preview = await jsonRequest<{
          sourceTitle: string;
          evidenceLinks: number;
          questionsLosingLastSource: number;
        }>(`/api/v2/sources/${sourceId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview-erase" }),
        });
        if (
          !window.confirm(
            `Erase “${preview.sourceTitle}” and ${preview.evidenceLinks} evidence links? ${preview.questionsLosingLastSource} question(s) will lose their last source and be suspended. This cannot be undone.`,
          )
        ) {
          return;
        }
      }
      await jsonRequest(`/api/v2/sources/${sourceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update source.");
    }
  }

  async function toggleManifest(sourceId: string) {
    if (expandedSourceId === sourceId) {
      setExpandedSourceId(null);
      return;
    }
    setExpandedSourceId(sourceId);
    if (sourceManifests[sourceId]) {
      return;
    }
    try {
      const manifest = await jsonRequest<SourceManifest>(
        `/api/v2/sources/${sourceId}`,
      );
      setSourceManifests((current) => ({
        ...current,
        [sourceId]: manifest,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load coverage.");
    }
  }

  return (
    <main className="page">
      <section className="review-shell v2-library-shell">
        <ReviewToolbar />
        <div className="v2-library-layout" id="library-panel">
          <aside className="v2-library-sidebar">
            <button
              className="v2-add-button"
              onClick={() => setCaptureOpen(true)}
              type="button"
            >
              <Plus aria-hidden="true" />
              Add knowledge
            </button>
            <nav aria-label="Question bank views">
              <span className="v2-sidebar-label">Bank</span>
              {QUESTION_VIEWS.map((item) => (
                <button
                  aria-current={view === item.value ? "page" : undefined}
                  className={view === item.value ? "is-active" : ""}
                  key={item.value}
                  onClick={() => setView(item.value)}
                  type="button"
                >
                  <span>{item.label}</span>
                  <small>{viewCount(data, item.value)}</small>
                </button>
              ))}
              <span className="v2-sidebar-label">Organize</span>
              <button
                className={view === "sources" ? "is-active" : ""}
                onClick={() => setView("sources")}
                type="button"
              >
                <span><BookOpen /> Sources</span>
                <small>{data.sources.length}</small>
              </button>
              <button
                className={view === "concepts" ? "is-active" : ""}
                onClick={() => setView("concepts")}
                type="button"
              >
                <span><Tags /> Concepts</span>
                <small>{data.concepts.length}</small>
              </button>
            </nav>
          </aside>
          <section className="v2-library-content">
            <header className="v2-library-heading">
              <div>
                <span className="v2-kicker">One adaptive question bank</span>
                <h1>
                  {view === "all"
                    ? "Your knowledge"
                    : view === "sources"
                      ? "Sources"
                      : view === "concepts"
                        ? "Concepts"
                        : view === "attention"
                          ? "Needs attention"
                          : lifecycleLabel(view)}
                </h1>
                <p>
                  {view === "attention"
                    ? "Resolve ambiguity, weak questions, and likely overlap before they reach Review."
                    : view === "sources"
                      ? "See what each source covers—and what remains unresolved."
                      : view === "concepts"
                        ? "Concepts organize one shared bank; nothing needs a deck."
                        : `${viewCount(data, view) ?? 0} questions in this view.`}
                </p>
              </div>
              {view !== "sources" && view !== "concepts" ? (
                <div className="v2-library-tools">
                  <label className="v2-search">
                    <Search aria-hidden="true" />
                    <span className="sr-only">Search Library</span>
                    <input
                      onChange={(event) => setQuery(event.currentTarget.value)}
                      placeholder="Search questions, answers, targets…"
                      type="search"
                      value={query}
                    />
                  </label>
                  {readyDraftIds.length > 0 ? (
                    <button
                      disabled={isLoading}
                      onClick={() =>
                        questionAction({
                          action: "batch-accept",
                          questionIds: readyDraftIds,
                        })
                      }
                      type="button"
                    >
                      <Check /> Accept {readyDraftIds.length} ready
                    </button>
                  ) : null}
                </div>
              ) : null}
            </header>
            {message ? (
              <div className="v2-toast" role="status">
                {message}
                <button aria-label="Dismiss" onClick={() => setMessage(null)} type="button">
                  <X />
                </button>
              </div>
            ) : null}
            {error ? <p className="v2-error" role="alert">{error}</p> : null}
            {view === "sources" ? (
              <div className="v2-source-grid">
                {data.sources.map((source) => {
                  const total = Object.values(source.coverage).reduce(
                    (sum, count) => sum + count,
                    0,
                  );
                  const isBuilding = Boolean(
                    source.run && ACTIVE_GENERATION_RUNS.has(source.run.status),
                  );
                  const canRetry =
                    !isBuilding &&
                    source.status !== "disabled" &&
                    (source.questionSetStatus === "needs_attention" ||
                      source.status === "failed" ||
                      source.status === "cancelled");
                  return (
                    <article className="v2-source-card" key={source.id}>
                      <div className="v2-source-card-heading">
                        <span className={`v2-source-icon is-${source.kind}`}>
                          {source.kind === "url" ? <Link2 /> : <FileText />}
                        </span>
                        <div>
                          <strong>{source.title}</strong>
                          <small>
                            {source.kind.toUpperCase()} · {isBuilding
                              ? source.run?.stage
                              : source.questionSetStatus === "ready"
                                ? "Question set ready"
                                : "Needs attention"}
                          </small>
                        </div>
                        {isBuilding ? (
                          <LoaderCircle className="v2-spin" />
                        ) : (
                          <MoreHorizontal />
                        )}
                      </div>
                      {isBuilding ? (
                        <div className="v2-progress-track">
                          <span style={{ width: `${source.progress}%` }} />
                        </div>
                      ) : null}
                      <div className="v2-source-outcomes">
                        <div>
                          <span>Question set</span>
                          <strong>
                            {source.questionSetStatus === "ready"
                              ? "Ready"
                              : source.questionSetStatus === "building"
                                ? "Building"
                                : "Needs attention"}
                          </strong>
                        </div>
                        <div>
                          <span>Mastery</span>
                          <strong>
                            {source.mastery.requiredTargets === 0
                              ? "Not practiced"
                              : `${source.mastery.masteredTargets}/${source.mastery.requiredTargets} targets`}
                          </strong>
                        </div>
                      </div>
                      <dl className="v2-coverage-grid">
                        <div><dt>Covered</dt><dd>{source.coverage.covered}</dd></div>
                        <div><dt>Weak</dt><dd>{source.coverage.weak}</dd></div>
                        <div><dt>Missing</dt><dd>{source.coverage.missing}</dd></div>
                        <div><dt>Unresolved</dt><dd>{source.coverage.unresolved}</dd></div>
                      </dl>
                      {total === 0 && source.status === "ready" ? (
                        <p>No auditable targets were extracted.</p>
                      ) : null}
                      {source.error ? <p className="v2-error">{source.error}</p> : null}
                      <div className="v2-row-actions">
                        {canRetry ? (
                          <button
                            onClick={() => sourceAction(source.id, "retry")}
                            type="button"
                          >
                            <RotateCcw /> Rebuild question set
                          </button>
                        ) : null}
                        {isBuilding ? (
                          <button
                            onClick={() => sourceAction(source.id, "cancel")}
                            type="button"
                          >
                            <X /> Cancel
                          </button>
                        ) : null}
                        {source.questionSetStatus !== "building" ||
                        source.status === "disabled" ? (
                          <>
                            {source.learningPath ? (
                              <Link href={`/library/sources/${source.id}`}>
                                <Route /> Learning path
                              </Link>
                            ) : null}
                            <button
                              onClick={() => toggleManifest(source.id)}
                              type="button"
                            >
                              <BookOpen />
                              {expandedSourceId === source.id
                                ? "Hide manifest"
                                : "View manifest"}
                            </button>
                            <button
                              onClick={() =>
                                sourceAction(
                                  source.id,
                                  source.status === "disabled"
                                    ? "enable"
                                    : "disable",
                                )
                              }
                              type="button"
                            >
                              {source.status === "disabled" ? (
                                <RotateCcw />
                              ) : (
                                <Pause />
                              )}
                              {source.status === "disabled"
                                ? "Enable"
                                : "Disable"}
                            </button>
                          </>
                        ) : null}
                        <button
                          className="is-danger"
                          onClick={() => sourceAction(source.id, "erase")}
                          type="button"
                        >
                          <Trash2 /> Erase provenance
                        </button>
                      </div>
                      {expandedSourceId === source.id ? (
                        <div className="v2-source-manifest">
                          {sourceManifests[source.id] ? (
                            sourceManifests[source.id].targets.length > 0 ? (
                              sourceManifests[source.id].targets.map((target) => (
                                <details key={target.id}>
                                  <summary>
                                    <span className={`is-${target.status}`}>
                                      {target.mastered ? "mastered" : target.status}
                                    </span>
                                    {target.statement}
                                  </summary>
                                  <p>
                                    {target.requirement} · {target.type}
                                    {target.confidence === null
                                      ? ""
                                      : ` · ${Math.round(target.confidence * 100)}% confidence`}
                                  </p>
                                  {target.evidenceQuote ? (
                                    <blockquote>{target.evidenceQuote}</blockquote>
                                  ) : (
                                    <p>No exact evidence span is mapped yet.</p>
                                  )}
                                  {target.questions.length > 0 ? (
                                    <ul>
                                      {target.questions.map((question) => (
                                        <li key={question.id}>
                                          {question.prompt} <small>({lifecycleLabel(question.lifecycle)})</small>
                                        </li>
                                      ))}
                                    </ul>
                                  ) : (
                                    <p>No active question covers this target yet.</p>
                                  )}
                                </details>
                              ))
                            ) : (
                              <p>No coverage targets are available.</p>
                            )
                          ) : (
                            <LoaderCircle className="v2-spin" />
                          )}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {data.sources.length === 0 ? (
                  <div className="v2-empty">
                    <FolderSearch />
                    <h2>No sources yet</h2>
                    <p>Add a paper, page, or notes. Waxon will map coverage before drafting practice.</p>
                    <button className="v2-button-primary" onClick={() => setCaptureOpen(true)} type="button">
                      Add your first source
                    </button>
                  </div>
                ) : null}
              </div>
            ) : view === "concepts" ? (
              <div className="v2-concept-grid">
                {data.concepts.map((concept) => (
                  <article key={concept.id}>
                    <Tags aria-hidden="true" />
                    <strong>{concept.name}</strong>
                    <span>{concept.count} questions</span>
                  </article>
                ))}
                {data.concepts.length === 0 ? (
                  <div className="v2-empty">
                    <Tags />
                    <h2>Concepts appear automatically</h2>
                    <p>They are non-exclusive labels over one shared question bank.</p>
                  </div>
                ) : null}
              </div>
            ) : (
              <div
                aria-busy={isLoading}
                className={`v2-question-list ${isLoading ? "is-loading" : ""}`}
              >
                {visibleQuestions.map((question) => (
                  <QuestionRow
                    key={question.id}
                    onAction={questionAction}
                    question={question}
                  />
                ))}
                {!isLoading && visibleQuestions.length === 0 ? (
                  <div className="v2-empty">
                    <Sparkles />
                    <h2>Nothing here</h2>
                    <p>
                      Add one clear question or throw in source material. The
                      bank will organize itself around evidence and concepts.
                    </p>
                    <button className="v2-button-primary" onClick={() => setCaptureOpen(true)} type="button">
                      Add knowledge
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </section>
      {captureOpen ? (
        <CaptureDialog
          onCaptured={(nextMessage) => {
            setMessage(nextMessage);
            setExpandedSourceId(null);
            setSourceManifests({});
            void load();
          }}
          onClose={() => setCaptureOpen(false)}
        />
      ) : null}
    </main>
  );
}
