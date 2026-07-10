"use client";

import {
  Check,
  FileText,
  Layers,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react";
import { usePageScrollLock } from "@/app/lib/usePageScrollLock";
import type { KnowledgeEmbeddingPlot as KnowledgeEmbeddingPlotResponse } from "@/app/lib/reviewTypes";
import {
  QUESTION_GENERATION_DEFAULT_COUNT,
  QUESTION_GENERATION_MAX_COUNT,
} from "@/app/lib/questionContract";
import { MarkdownInline } from "@/app/MarkdownContent";
import { KnowledgeEmbeddingPlot } from "../review/ReviewVisualizations";

type GeneratedQuestionStatus = "new" | "selected" | "adding";

type GeneratedQuestionCandidate = {
  id: string;
  question: string;
  conciseAnswer: string;
  proposedConceptSlugs: string[];
  sourceText: string;
  status: GeneratedQuestionStatus;
};

type GeneratorContextFile = {
  id: string;
  name: string;
  content: string;
  status: "ready" | "metadata-only";
};

type GenerateQuestionsResponse =
  | {
      ok: true;
      questions: Array<{
        question: string;
        conciseAnswer?: string;
        proposedConceptSlugs?: string[];
        sourceText?: string;
      }>;
    }
  | { ok: false; error?: string };

const EMPTY_EMBEDDING_PLOT: KnowledgeEmbeddingPlotResponse = {
  model: null,
  totalQuestions: 0,
  embeddedQuestions: 0,
  points: [],
};

function createClientId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isTextContextFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();

  return (
    file.type.startsWith("text/") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".markdown") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".tex")
  );
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read context file."));
    reader.readAsText(file);
  });
}

export function LibraryManagementTools({
  existingQuestions,
  onQuestionsAdded,
}: {
  existingQuestions: string[];
  onQuestionsAdded: () => void;
}) {
  const [isGeneratorOpen, setIsGeneratorOpen] = useState(false);
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isMapLoading, setIsMapLoading] = useState(false);
  const [embeddingPlot, setEmbeddingPlot] =
    useState<KnowledgeEmbeddingPlotResponse>(EMPTY_EMBEDDING_PLOT);
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [questionCount, setQuestionCount] = useState(
    QUESTION_GENERATION_DEFAULT_COUNT,
  );
  const [files, setFiles] = useState<GeneratorContextFile[]>([]);
  const [generatedQuestions, setGeneratedQuestions] = useState<
    GeneratedQuestionCandidate[]
  >([]);
  const [generatorMessage, setGeneratorMessage] = useState<string | null>(null);
  const isReviewStep = generatedQuestions.length > 0;
  const hasContext = scope.trim().length > 0 || files.length > 0;
  const counts = useMemo(
    () =>
      generatedQuestions.reduce(
        (result, item) => {
          result[item.status] += 1;
          return result;
        },
        { new: 0, selected: 0, adding: 0 } satisfies Record<
          GeneratedQuestionStatus,
          number
        >,
      ),
    [generatedQuestions],
  );

  usePageScrollLock(isGeneratorOpen || isMapOpen);

  const resetGenerator = useCallback(() => {
    setScope("");
    setQuestionCount(QUESTION_GENERATION_DEFAULT_COUNT);
    setFiles([]);
    setGeneratedQuestions([]);
    setGeneratorMessage(null);
  }, []);

  const closeGenerator = useCallback(() => {
    if (isGenerating) {
      return;
    }

    setIsGeneratorOpen(false);
    resetGenerator();
  }, [isGenerating, resetGenerator]);

  useEffect(() => {
    if (!isGeneratorOpen && !isMapOpen) {
      return;
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (isGeneratorOpen) {
        if (isGenerating) {
          event.preventDefault();
          return;
        }
        closeGenerator();
      } else {
        setIsMapOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeGenerator, isGenerating, isGeneratorOpen, isMapOpen]);

  async function addContextFiles(selectedFiles: File[]) {
    const contextFiles = await Promise.all(
      selectedFiles.map(async (file): Promise<GeneratorContextFile> => {
        if (!isTextContextFile(file)) {
          return {
            id: createClientId("context-file"),
            name: file.name,
            content: `${file.name} (${file.type || "file"})`,
            status: "metadata-only",
          };
        }

        try {
          return {
            id: createClientId("context-file"),
            name: file.name,
            content: await readFileAsText(file),
            status: "ready",
          };
        } catch {
          return {
            id: createClientId("context-file"),
            name: file.name,
            content: file.name,
            status: "metadata-only",
          };
        }
      }),
    );

    setFiles((current) => [...current, ...contextFiles]);
    setGeneratorMessage(null);
  }

  async function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (!isGenerating) {
      await addContextFiles(Array.from(event.dataTransfer.files ?? []));
    }
  }

  async function generateQuestions() {
    if (!hasContext || isGenerating) {
      return;
    }

    setIsGenerating(true);
    setGeneratorMessage(null);

    try {
      const response = await fetch("/api/questions/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          files,
          count: Math.min(
            QUESTION_GENERATION_MAX_COUNT,
            Math.max(1, questionCount),
          ),
          difficulty: "Mixed",
          existingQuestions,
        }),
      });
      const data = (await response.json()) as GenerateQuestionsResponse;

      if (!response.ok || !data.ok) {
        throw new Error(
          !data.ok && data.error ? data.error : "Could not generate questions.",
        );
      }

      const candidates = data.questions.map((item) => ({
        id: createClientId("generated-question"),
        question: item.question,
        conciseAnswer: item.conciseAnswer ?? "",
        proposedConceptSlugs: item.proposedConceptSlugs ?? [],
        sourceText: item.sourceText ?? scope,
        status: "new" as const,
      }));

      setGeneratedQuestions(candidates);
      setGeneratorMessage(
        candidates.length > 0 ? null : "OpenRouter returned no new questions.",
      );
    } catch (error) {
      setGeneratorMessage(
        error instanceof Error ? error.message : "Could not generate questions.",
      );
    } finally {
      setIsGenerating(false);
    }
  }

  function toggleQuestion(questionId: string) {
    setGeneratedQuestions((current) =>
      current.map((item) =>
        item.id === questionId && item.status !== "adding"
          ? {
              ...item,
              status: item.status === "selected" ? "new" : "selected",
            }
          : item,
      ),
    );
    setGeneratorMessage(null);
  }

  async function addSelectedQuestions() {
    const selected = generatedQuestions.filter(
      (item) => item.status === "selected",
    );

    if (selected.length === 0) {
      return;
    }

    const selectedIds = new Set(selected.map((item) => item.id));
    setGeneratedQuestions((current) =>
      current.map((item) =>
        selectedIds.has(item.id) ? { ...item, status: "adding" } : item,
      ),
    );
    setGeneratorMessage(null);

    try {
      const response = await fetch("/api/questions/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questions: selected.map((item) => ({
            question: item.question,
            conciseAnswer: item.conciseAnswer,
            proposedConceptSlugs: item.proposedConceptSlugs,
            sourceText: item.sourceText,
          })),
        }),
      });
      const data = (await response.json()) as
        | { ok: true; added: number; rejected?: number }
        | { ok: false; error?: string };

      if (!response.ok || !data.ok) {
        throw new Error(
          !data.ok && data.error ? data.error : "Could not add questions.",
        );
      }

      setGeneratedQuestions((current) =>
        current.filter((item) => !selectedIds.has(item.id)),
      );
      setGeneratorMessage(
        data.added > 0
          ? `${data.added} ${data.added === 1 ? "question" : "questions"} added${
              data.rejected ? `, ${data.rejected} duplicates rejected` : ""
            }.`
          : "Selected questions already exist or were rejected as duplicates.",
      );
      onQuestionsAdded();

      if (data.added > 0) {
        closeGenerator();
      }
    } catch (error) {
      setGeneratorMessage(
        error instanceof Error ? error.message : "Could not add questions.",
      );
      setGeneratedQuestions((current) =>
        current.map((item) =>
          selectedIds.has(item.id) ? { ...item, status: "selected" } : item,
        ),
      );
    }
  }

  async function openMap() {
    setIsMapOpen(true);
    setIsMapLoading(true);
    setMapMessage(null);

    try {
      const response = await fetch("/api/knowledge-embedding-plot?limit=2000", {
        cache: "no-store",
      });
      const data = (await response.json()) as KnowledgeEmbeddingPlotResponse & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Could not load the knowledge map.");
      }

      setEmbeddingPlot(data);
    } catch (error) {
      setMapMessage(
        error instanceof Error ? error.message : "Could not load the knowledge map.",
      );
    } finally {
      setIsMapLoading(false);
    }
  }

  return (
    <>
      <div className="queue-action-group library-action-group">
        <button
          className="queue-generate-trigger"
          type="button"
          onClick={() => {
            resetGenerator();
            setIsGeneratorOpen(true);
          }}
        >
          <Sparkles aria-hidden="true" />
          <span>Generate</span>
        </button>
        <button className="queue-map-trigger" type="button" onClick={() => void openMap()}>
          <Layers aria-hidden="true" />
          <span>Map</span>
        </button>
      </div>

      {isGeneratorOpen ? (
        <div
          className="generator-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeGenerator();
            }
          }}
        >
          <section
            className="generator-modal"
            role="dialog"
            aria-modal="true"
            aria-busy={isGenerating}
            aria-labelledby="library-generator-title"
          >
            {isGenerating ? (
              <div className="generator-progress-mask" role="status">
                <div className="generator-progress-content">
                  <Sparkles aria-hidden="true" />
                  <strong>Generating questions</strong>
                  <span>Please wait...</span>
                </div>
              </div>
            ) : null}
            <div className="generator-modal-header">
              <div>
                <p className="generator-modal-kicker">
                  {isReviewStep ? "Step 2 of 2" : "Step 1 of 2"}
                </p>
                <h2 className="generator-modal-title" id="library-generator-title">
                  {isReviewStep ? "Review questions" : "Generate questions"}
                </h2>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close generator"
                disabled={isGenerating}
                onClick={closeGenerator}
              />
            </div>
            <div
              className={`generator-modal-grid ${
                isReviewStep
                  ? "generator-modal-grid-review"
                  : "generator-modal-grid-scope"
              }`}
            >
              {!isReviewStep ? (
                <section className="generator-scope-panel" aria-label="Generation scope">
                  <div className="generator-field">
                    <label htmlFor="library-generator-scope">Cover</label>
                    <div
                      className="generator-scope-shell"
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = isGenerating ? "none" : "copy";
                      }}
                      onDrop={(event) => void handleFileDrop(event)}
                    >
                      <textarea
                        id="library-generator-scope"
                        className="generator-scope-input"
                        value={scope}
                        disabled={isGenerating}
                        onChange={(event) => {
                          setScope(event.target.value);
                          setGeneratorMessage(null);
                        }}
                        placeholder="Core ideas from the attached lecture notes"
                        rows={7}
                      />
                      <p className="generator-drop-hint">
                        Drop files here to add them as context.
                      </p>
                      {files.length > 0 ? (
                        <ul className="generator-file-list" aria-label="Context files">
                          {files.map((file) => (
                            <li className="generator-file-chip" key={file.id}>
                              <FileText aria-hidden="true" />
                              <span>{file.name}</span>
                              {file.status === "metadata-only" ? <em>name only</em> : null}
                              <button
                                type="button"
                                aria-label={`Remove ${file.name}`}
                                onClick={() =>
                                  setFiles((current) =>
                                    current.filter((item) => item.id !== file.id),
                                  )
                                }
                              >
                                <X aria-hidden="true" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                  <div className="generator-controls">
                    <label className="generator-slider-field">
                      <span className="generator-slider-header">
                        <span>Questions</span>
                        <output>{questionCount}</output>
                      </span>
                      <input
                        className="generator-count-slider"
                        type="range"
                        min={1}
                        max={QUESTION_GENERATION_MAX_COUNT}
                        step={1}
                        value={questionCount}
                        onChange={(event) => setQuestionCount(Number(event.target.value))}
                      />
                      <span className="generator-slider-scale" aria-hidden="true">
                        <span>1</span>
                        <span>{QUESTION_GENERATION_MAX_COUNT}</span>
                      </span>
                    </label>
                  </div>
                  <div className="generator-scope-footer">
                    <p aria-live="polite">{generatorMessage}</p>
                    <button
                      className="generator-primary-action"
                      type="button"
                      disabled={!hasContext || isGenerating}
                      onClick={() => void generateQuestions()}
                    >
                      <Sparkles aria-hidden="true" />
                      <span>{isGenerating ? "Generating..." : "Generate"}</span>
                    </button>
                  </div>
                </section>
              ) : (
                <section className="generator-review-panel" aria-label="Generated questions">
                  <ol className="generator-question-list">
                    {generatedQuestions.map((item) => (
                      <li
                        className={`generator-question-row generator-question-${item.status}`}
                        key={item.id}
                      >
                        <button
                          className="generator-question-status"
                          type="button"
                          aria-label={
                            item.status === "new"
                              ? `Select question for adding: ${item.question}`
                              : item.status === "selected"
                                ? `Remove question from add selection: ${item.question}`
                                : "Adding question"
                          }
                          disabled={item.status === "adding"}
                          onClick={() => toggleQuestion(item.id)}
                        >
                          {item.status === "selected" ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <Plus aria-hidden="true" />
                          )}
                        </button>
                        <div className="generator-question-copy">
                          <MarkdownInline as="p" className="generator-question-text" text={item.question} />
                        </div>
                      </li>
                    ))}
                  </ol>
                  <div className="generator-review-footer">
                    <p aria-live="polite">
                      {generatorMessage ? `${generatorMessage} · ` : ""}
                      {counts.selected} selected · {counts.new} available
                      {counts.adding > 0 ? ` · ${counts.adding} adding` : ""}
                    </p>
                    <button
                      className="generator-primary-action"
                      type="button"
                      disabled={counts.selected === 0 || counts.adding > 0}
                      onClick={() => void addSelectedQuestions()}
                    >
                      {counts.adding > 0 ? "Adding..." : "Add"}
                    </button>
                  </div>
                </section>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {isMapOpen ? (
        <div
          className="embedding-map-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsMapOpen(false);
            }
          }}
        >
          <section
            className="embedding-map-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-map-title"
          >
            <div className="embedding-map-modal-header">
              <div>
                <p className="embedding-map-modal-kicker">Question bank map</p>
                <h2 className="embedding-map-modal-title" id="library-map-title">
                  Question bank
                </h2>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close embedding map"
                onClick={() => setIsMapOpen(false)}
              />
            </div>
            <div className="embedding-map-modal-body">
              {isMapLoading ? <p className="stats-empty">Loading map...</p> : null}
              {mapMessage ? <p className="stats-empty">{mapMessage}</p> : null}
              {!isMapLoading && !mapMessage ? (
                <KnowledgeEmbeddingPlot plot={embeddingPlot} reviewQueue={[]} />
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
