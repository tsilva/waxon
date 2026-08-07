"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  LoaderCircle,
  LockKeyhole,
  Route,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownContent } from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";

type Manifest = {
  source: {
    id: string;
    title: string;
    kind: string;
    status: string;
    mastery: {
      status: string;
      masteredTargets: number;
      requiredTargets: number;
    };
  };
  run: { status: string; stage: string; progress: number } | null;
  learningPath: {
    id: string;
    status: "ready" | "fallback_ready" | "needs_attention" | "superseded";
    focused: boolean;
    diagnostics: string[];
    passed: number;
    total: number;
    nodes: Array<{
      id: string;
      kind: "target" | "external_prerequisite";
      moduleTitle: string;
      modulePosition: number;
      position: number;
      checkpoint: number | null;
      statement: string;
      reason: string | null;
      bridgeSourceId: string | null;
      question: { id: string; prompt: string; lifecycle: string } | null;
      state: "passed" | "locked" | "gap" | "waiting" | "next" | "needs_attention";
      lockReason: string | null;
    }>;
  } | null;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Waxon could not complete that action.");
  return body as T;
}

export function SourceLearningPathPage({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setManifest(await request<Manifest>(`/api/v2/sources/${sourceId}`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load source.");
    }
  }, [sourceId]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!manifest?.run || !["queued", "preparing", "mapping", "matching", "drafting", "criticizing", "persisting"].includes(manifest.run.status)) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [load, manifest?.run]);

  const modules = useMemo(() => {
    const grouped = new Map<number, {
      title: string;
      nodes: NonNullable<Manifest["learningPath"]>["nodes"];
    }>();
    for (const node of manifest?.learningPath?.nodes ?? []) {
      const pathModule = grouped.get(node.modulePosition) ?? {
        title: node.moduleTitle,
        nodes: [],
      };
      pathModule.nodes.push(node);
      grouped.set(node.modulePosition, pathModule);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, pathModule]) => pathModule);
  }, [manifest?.learningPath?.nodes]);

  async function action(actionName: string, extra?: Record<string, unknown>) {
    setBusy(actionName);
    setError(null);
    try {
      const result = await request<{ sourceId?: string }>(
        `/api/v2/sources/${sourceId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: actionName, ...extra }),
        },
      );
      if (actionName === "focus") {
        router.push("/review");
      } else if (actionName === "build-prerequisite" && result.sourceId) {
        router.push(`/library/sources/${result.sourceId}`);
      } else {
        await load();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update source.");
    } finally {
      setBusy(null);
    }
  }

  const path = manifest?.learningPath;
  const building = Boolean(
    manifest?.run && ["queued", "preparing", "mapping", "matching", "drafting", "criticizing", "persisting"].includes(manifest.run.status),
  );
  return (
    <main className="page">
      <section className="review-shell v2-source-path-shell">
        <ReviewToolbar />
        <div className="v2-source-path" id="library-panel">
          <Link className="v2-source-back" href="/library">
            <ArrowLeft /> Library
          </Link>
          {!manifest && error ? (
            <div className="v2-review-empty">
              <CircleAlert />
              <h1>Could not load this learning path.</h1>
              <p>{error}</p>
              <button onClick={() => void load()} type="button">Try again</button>
            </div>
          ) : !manifest ? (
            <div className="v2-review-empty">
              <LoaderCircle className="v2-spin" />
              <h1>Loading learning path…</h1>
            </div>
          ) : (
            <>
              <header className="v2-source-path-header">
                <div>
                  <span className="v2-kicker">{manifest.source.kind} source</span>
                  <h1>{manifest.source.title}</h1>
                  <p>
                    Learn prerequisites in order; Waxon continues maintaining every introduced question through Review.
                  </p>
                </div>
                {path ? (
                  <button
                    className="v2-button-primary"
                    disabled={Boolean(busy) || path.total === 0}
                    onClick={() => action(path.focused ? "unfocus" : "focus")}
                    type="button"
                  >
                    {busy ? <LoaderCircle className="v2-spin" /> : path.focused ? <Check /> : <ArrowRight />}
                    {path.focused ? "Focused" : path.passed > 0 ? "Continue source" : "Start source"}
                  </button>
                ) : null}
              </header>
              {error ? <p className="v2-error" role="alert">{error}</p> : null}
              {building ? (
                <div className="v2-path-building">
                  <LoaderCircle className="v2-spin" />
                  <div>
                    <strong>{manifest.run?.stage}</strong>
                    <span>Waxon is curating questions and their prerequisite path in the background.</span>
                  </div>
                  <div className="v2-progress-track"><span style={{ width: `${manifest.run?.progress ?? 0}%` }} /></div>
                </div>
              ) : path ? (
                <>
                  <section className="v2-path-summary">
                    <div><span>Learning path</span><strong>{path.passed}/{path.total} passed</strong></div>
                    <div><span>Current mastery</span><strong>{manifest.source.mastery.masteredTargets}/{manifest.source.mastery.requiredTargets} retained</strong></div>
                    <div><span>Ordering</span><strong>{path.status === "fallback_ready" ? "Source order" : "Prerequisite audited"}</strong></div>
                  </section>
                  {path.status === "fallback_ready" && path.diagnostics.length > 0 ? (
                    <p className="v2-path-notice"><CircleAlert /> {path.diagnostics[0]}</p>
                  ) : null}
                  <div className="v2-path-modules">
                    {modules.map((pathModule, moduleIndex) => (
                      <section className="v2-path-module" key={`${moduleIndex}:${pathModule.title}`}>
                        <header><span>{String(moduleIndex + 1).padStart(2, "0")}</span><h2>{pathModule.title}</h2></header>
                        <ol>
                          {pathModule.nodes.map((node) => (
                            <li className={`is-${node.state}`} key={node.id}>
                              <span className="v2-path-node-icon">
                                {node.state === "passed" ? <Check /> : node.state === "locked" ? <LockKeyhole /> : node.state === "waiting" ? <Clock3 /> : node.kind === "external_prerequisite" ? <Sparkles /> : <Route />}
                              </span>
                              <div>
                                <small>{node.kind === "external_prerequisite" ? "Prerequisite" : `Checkpoint ${node.checkpoint}`}</small>
                                <MarkdownContent className="v2-markdown" enableMath text={node.question?.prompt ?? node.statement} />
                                {node.lockReason ? <span>{node.lockReason}</span> : null}
                                {node.reason && node.kind === "external_prerequisite" ? <span>{node.reason}</span> : null}
                              </div>
                              {node.kind === "external_prerequisite" && node.state !== "passed" ? (
                                node.bridgeSourceId ? (
                                  <Link href={`/library/sources/${node.bridgeSourceId}`}>Open prerequisite</Link>
                                ) : (
                                  <button
                                    disabled={Boolean(busy)}
                                    onClick={() => action("build-prerequisite", { gapNodeId: node.id })}
                                    type="button"
                                  >
                                    Build prerequisite
                                  </button>
                                )
                              ) : null}
                            </li>
                          ))}
                        </ol>
                      </section>
                    ))}
                  </div>
                </>
              ) : (
                <div className="v2-review-empty">
                  <CircleAlert />
                  <h1>No learning path is available.</h1>
                  <p>Rebuild this source’s question set to prepare one.</p>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
