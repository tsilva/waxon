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
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { MarkdownContent } from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import type {
  V2LibraryResponse,
  V2QuestionLifecycle,
  V2Question,
} from "@/app/lib/v2/types";

const EMPTY_DATA: V2LibraryResponse = {
  questions: [],
  counts: { active: 0, flagged: 0, archived: 0 },
  waitingNew: 0,
};
const FILTERS: Array<{ value: V2QuestionLifecycle | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "flagged", label: "Flagged" },
  { value: "archived", label: "Archived" },
];

const FLAG_REASON_LABELS: Record<string, string> = {
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
            ? "That question was already in your bank."
            : result.lifecycle === "flagged"
              ? "Question saved to Flagged for attention."
              : "Active Question added to your bank.",
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
            <span className="v2-kicker">Question bank</span>
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
          {question ? <p className="lean-edit-warning">Replacing creates a new Active Question with reset mastery and archives this Question with its Learning Evidence intact.</p> : null}
          {error ? <p className="v2-error" role="alert">{error}</p> : null}
          <div className="v2-dialog-actions">
            <button onClick={onClose} type="button">Cancel</button>
            <button className="v2-button-primary" disabled={saving} type="submit">
              {saving ? <LoaderCircle className="v2-spin" /> : null}
              {question ? "Replace question" : "Add to bank"}
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
        <p>Connect an agent to <code>{typeof window === "undefined" ? "/api/mcp" : `${window.location.origin}/api/mcp`}</code> with a bearer token. It can search this bank and add validated questions.</p>
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
  onEdit,
  onAction,
}: {
  question: V2Question;
  onEdit: () => void;
  onAction: (action: "archive" | "restore") => void;
}) {
  const unresolvedFlags = question.flags.filter((flag) => !flag.resolvedAt);
  return (
    <article className="lean-question-row">
      <div className="lean-question-copy">
        <div className="lean-question-meta">
          <span className={`lean-lifecycle is-${question.lifecycle}`}>{question.lifecycle[0]?.toUpperCase()}{question.lifecycle.slice(1)}</span>
          {question.dueAt ? <span><CalendarClock /> {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(question.dueAt))}</span> : null}
          {question.retrievability !== null ? <span>{Math.round(question.retrievability * 100)}% recall</span> : null}
        </div>
        <h2><MarkdownContent className="v2-markdown" enableMath text={question.prompt} /></h2>
        {question.lifecycle === "flagged" && unresolvedFlags.length > 0 ? (
          <div className="lean-flag-evidence" aria-label="Flag reasons">
            {unresolvedFlags.map((flag, flagIndex) => (
              <div key={`${flag.origin}-${flag.createdAt}-${flagIndex}`}>
                <span className="lean-flag-origin">
                  <Flag />
                  {flag.origin === "waxon_validation" ? "Waxon validation" : "Learner flag"}
                </span>
                {flag.reasons.length > 0 ? (
                  <span className="lean-flag-reasons">
                    {flag.reasons.map((reason) => (
                      <span key={reason}>{flagReasonLabel(reason)}</span>
                    ))}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <details>
          <summary>Answer standard</summary>
          <MarkdownContent className="v2-markdown" enableMath text={question.referenceAnswer} />
        </details>
      </div>
      <div className="lean-question-actions">
        <button aria-label="Replace question" onClick={onEdit} title={question.lifecycle === "flagged" ? "Replace with new Active Question" : "Replace"} type="button"><Pencil /></button>
        {question.lifecycle !== "archived" ? <button aria-label="Archive question" onClick={() => onAction("archive")} title="Archive" type="button"><Archive /></button> : null}
        {question.lifecycle !== "active" ? <button aria-label="Restore question" onClick={() => onAction("restore")} title="Restore" type="button"><ArchiveRestore /></button> : null}
      </div>
    </article>
  );
}

export default function LibraryPageClient() {
  const [data, setData] = useState(EMPTY_DATA);
  const [filter, setFilter] = useState<V2QuestionLifecycle | "all">("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<V2Question | null | undefined>(undefined);
  const [mcpOpen, setMcpOpen] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("lifecycle", filter);
    if (search.trim()) params.set("search", search.trim());
    const result = await jsonRequest<V2LibraryResponse>(`/api/v2/library?${params}`);
    setData(result);
  }, [filter, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true);
      load().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load Library.")).finally(() => setLoading(false));
    }, search ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  const total = useMemo(() => Object.values(data.counts).reduce((sum, value) => sum + value, 0), [data.counts]);

  async function questionAction(questionId: string, action: "archive" | "restore") {
    setError(null);
    await jsonRequest("/api/v2/library", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, action }),
    });
    setMessage(action === "restore" ? "Question restored." : "Question archived.");
    await load();
  }

  return (
    <main className="page">
      <section className="review-shell lean-library-shell">
        <ReviewToolbar />
        <div className="lean-library-stage" id="library-panel">
          <header className="lean-library-heading">
            <div><span className="v2-kicker">Question bank</span><h1>{total} questions</h1><p>Add what is worth remembering. Review handles the rest.</p></div>
            <div>
              <button className="lean-secondary-button" onClick={() => setMcpOpen(true)} type="button"><KeyRound /> Agent access</button>
              <button className="v2-button-primary" onClick={() => setEditing(null)} type="button"><Plus /> Add question</button>
            </div>
          </header>
          <div className="lean-library-controls">
            <label className="lean-search"><Search /><span className="sr-only">Search questions</span><input onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search questions and answers" type="search" value={search} /></label>
            <nav aria-label="Question filters">
              {FILTERS.map((item) => (
                <button aria-pressed={filter === item.value} key={item.value} onClick={() => setFilter(item.value)} type="button">
                  {item.label}<span>{item.value === "all" ? total : data.counts[item.value]}</span>
                </button>
              ))}
            </nav>
          </div>
          {filter === "flagged" ? (
            <section className="lean-attention-inbox" aria-label="Flagged Question attention inbox">
              <Flag />
              <div>
                <strong>Attention inbox</strong>
                <p>Flagged Questions needing a decision.</p>
              </div>
            </section>
          ) : null}
          {message ? <p className="lean-library-message" role="status">{message}</p> : null}
          {error ? <p className="v2-error" role="alert">{error}</p> : null}
          <div className="lean-question-list">
            {loading ? <div className="lean-library-empty"><LoaderCircle className="v2-spin" /><p>Loading questions…</p></div> : data.questions.length > 0 ? data.questions.map((question) => (
              <QuestionRow
                key={question.id}
                onAction={(action) => void questionAction(question.id, action).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not update question."))}
                onEdit={() => setEditing(question)}
                question={question}
              />
            )) : <div className="lean-library-empty"><h2>{search ? "No matching questions" : filter === "flagged" ? "No Questions need attention" : filter === "archived" ? "No Archived Questions" : "Your bank is empty"}</h2><p>{search ? "Try a different phrase or filter." : filter === "flagged" ? "Nothing is waiting for attention." : filter === "archived" ? "Nothing is out of circulation." : "Add one clear Prompt and its Answer Standard."}</p>{!search && (filter === "all" || filter === "active") ? <button className="v2-button-primary" onClick={() => setEditing(null)} type="button"><Plus /> Add your first question</button> : null}</div>}
          </div>
        </div>
      </section>
      {editing !== undefined ? <QuestionDialog question={editing} onClose={() => setEditing(undefined)} onSaved={async (nextMessage) => { setMessage(nextMessage); await load(); }} /> : null}
      {mcpOpen ? <McpDialog onClose={() => setMcpOpen(false)} /> : null}
    </main>
  );
}
