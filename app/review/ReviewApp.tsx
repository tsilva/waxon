"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { isAdminEmail } from "@/app/lib/adminAccess";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FileText,
  LogOut,
  Mic,
  PencilLine,
  Plus,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Upload,
  User,
  UserCog,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  Fragment,
  KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type NextQuestionResponse = {
  question: string | null;
  queueRemaining: number;
};

type PrefetchedNextQuestion = {
  excludeQuestion: string;
  data: NextQuestionResponse;
};

type NextQuestionPrefetch = {
  excludeQuestion: string;
  abortController: AbortController;
  promise: Promise<PrefetchedNextQuestion | null>;
};

type SubmitAnswerResponse = {
  ok: boolean;
  evaluationId: string;
};

type QueueStatusResponse = {
  queueRemaining: number;
  pendingEvaluations: number;
  evaluations: EvaluationQueueItem[];
  recentAttempts?: QuestionAttempt[];
  reviewQueue: ReviewQueueItem[];
  reviewQueueTotal?: number;
  reviewQueueOffset?: number;
  reviewQueueLimit?: number;
  reviewQueueHasMore?: boolean;
  deckEmbeddingPlot: DeckEmbeddingPlotResponse;
};

type ReferenceAnswerResponse = {
  answer: string;
};

type UserProfileResponse = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type ReferenceAnswerState = {
  status: "loading" | "resolved" | "error";
  answer: string;
};

type EvaluationQueueItem = {
  id: string;
  question: string;
  answer: string | null;
  status: "grading" | "resolved";
  submittedAt: number;
  score: number | null;
  justification: string | null;
  answerSummary: string | null;
  resolvedAt: number | null;
  nextDue: number | null;
};

type ReviewQueueItem = {
  question: string;
  nextDue: number;
  createdAt: number;
  msUntilDue: number;
  status: "now" | "scheduled";
  generatedFromQuestion: string | null;
  reviewHistory: ReviewHistoryEntry[];
  lastScore: number | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
  lastJustification: string | null;
  attempts: QuestionAttempt[];
};

type ReviewHistoryEntry = {
  ts: number;
  score: number;
};

type QuestionAttempt = {
  id: number;
  question: string;
  rawAnswer: string;
  answerSummary: string;
  score: number;
  justification: string;
  submittedAt: number;
  resolvedAt: number;
};

type DeckEmbeddingPlotResponse = {
  model: string | null;
  totalQuestions: number;
  embeddedQuestions: number;
  points: DeckEmbeddingPlotPoint[];
};

type DeckEmbeddingPlotPoint = {
  question: string;
  lastScore: number | null;
  x: number;
  y: number;
};

type ChatMessage =
  | {
      id: string;
      kind: "question";
      question: string;
    }
  | {
      id: string;
      kind: "answer";
      question: string;
      answer: string;
      evaluationId: string;
      submittedAt: number;
      status: "grading" | "resolved";
      score: number | null;
      justification: string | null;
      answerSummary: string | null;
      nextDue: number | null;
      resolvedAt: number | null;
    };

type PreviousAnswerItem = {
  id: string;
  question: string;
  answer: string | null;
  status: "grading" | "resolved";
  score: number | null;
  justification: string | null;
  timestamp: number | null;
  timeLabel: string;
};

type ActiveTab = "review" | "queue";

type ReviewAppProps = {
  initialActiveTab?: ActiveTab;
};

type ReviewSessionSnapshot = {
  question: string | null;
  answer: string;
  speechPreview: string;
  queueRemaining: number;
  evaluations: EvaluationQueueItem[];
  recentAttempts: QuestionAttempt[];
  reviewQueue: ReviewQueueItem[];
  reviewQueueTotal: number;
  queueVirtualRange: {
    start: number;
    end: number;
  };
  queueSortKey: QueueSortKey;
  decks: DeckManagementItem[];
  selectedDeckId: string;
  deckSearchQuery: string;
  deckSortKey: DeckSortKey;
  editingDeckId: string | null;
  deckDraftName: string;
  deckDraftDescription: string;
  deckEmbeddingPlot: DeckEmbeddingPlotResponse;
  messages: ChatMessage[];
  referenceAnswers: Record<string, ReferenceAnswerState>;
  isPreviousExpanded: boolean;
  expandedPreviousAnswerIds: Set<string>;
  selectedQuestion: string | null;
  currentUser: UserProfileResponse | null;
  generatorScope: string;
  generatorQuestionCount: number;
  generatorFiles: GeneratorContextFile[];
  generatedQuestions: GeneratedQuestionCandidate[];
  generatorMessage: string | null;
  hasLoadedQuestion: boolean;
  hasLoadedQueueStatus: boolean;
  loadedQueueSortKey: QueueSortKey | null;
  queueLoadedLimit: number;
};

let reviewSessionSnapshot: ReviewSessionSnapshot | null = null;

const REVIEW_TAB_PATHS: Record<ActiveTab, string> = {
  review: "/review",
  queue: "/queue",
};

function getReviewTabFromPathname(pathname: string): ActiveTab | null {
  if (pathname === REVIEW_TAB_PATHS.review) {
    return "review";
  }

  if (pathname === REVIEW_TAB_PATHS.queue) {
    return "queue";
  }

  return null;
}

type QueueSortKey = "review-date" | "creation-date";

type DeckSortKey = "updated" | "due" | "name";

type DeckManagementItem = {
  id: string;
  name: string;
  description: string;
  dueCount: number;
  cardCount: number;
  lastReviewedLabel: string;
  inRotation: boolean;
};

type GeneratedQuestionStatus = "new" | "selected" | "adding" | "added";

type GeneratedQuestionCandidate = {
  id: string;
  question: string;
  conciseAnswer: string;
  coverageLabel: string;
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
      model: string;
      questions: Array<{
        question: string;
        conciseAnswer?: string;
        coverageLabel?: string;
      }>;
    }
  | {
      ok: false;
      error?: string;
    };

type PendingSpeechCommand = {
  command: "skip" | "submit";
  heldText: string;
  submitAnswer: string;
};

function nextQuestionUrl(excludeQuestion?: string | null) {
  const params = new URLSearchParams();

  if (excludeQuestion) {
    params.set("excludeQuestion", excludeQuestion);
  }

  return params.size > 0
    ? `/api/next-question?${params.toString()}`
    : "/api/next-question";
}

async function fetchNextQuestionData(input: {
  excludeQuestion?: string | null;
  signal?: AbortSignal;
} = {}): Promise<NextQuestionResponse> {
  const response = await fetch(nextQuestionUrl(input.excludeQuestion), {
    cache: "no-store",
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error("Failed to load the next question.");
  }

  return (await response.json()) as NextQuestionResponse;
}

type SpeechStatus =
  | "idle"
  | "starting"
  | "listening"
  | "unsupported"
  | "error";

type SpeechRecognitionAlternative = {
  transcript: string;
};

type SpeechRecognitionResult = {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
};

type SpeechRecognitionResultList = {
  length: number;
  [index: number]: SpeechRecognitionResult;
};

type SpeechRecognitionEvent = Event & {
  resultIndex: number;
  results: SpeechRecognitionResultList;
};

type SpeechRecognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognition;

type QuestionStats = {
  question: string;
  reviewHistory: ReviewHistoryEntry[];
  answerHistory: AnswerHistoryEntry[];
  attempts: number;
  averageScore: number | null;
  bestScore: number | null;
  lastScore: number | null;
  lastReviewedAt: number | null;
  nextDue: number | null;
  msUntilDue: number | null;
  dueStatus: "now" | "scheduled" | "unknown";
  pendingCount: number;
  generatedFromQuestion: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
  lastJustification: string | null;
};

type AnswerHistoryEntry = {
  id: string;
  rawAnswer: string;
  answerSummary: string | null;
  score: number | null;
  justification: string | null;
  submittedAt: number;
  resolvedAt: number | null;
  status: "grading" | "resolved";
};

type MathParseResult = {
  content: string;
  nextIndex: number;
};

const COLLAPSED_PREVIOUS_ANSWER_LIMIT = 2;
const EXPANDED_PREVIOUS_ANSWER_LIMIT = 24;
const QUEUE_PAGE_SIZE = 48;
const INITIAL_DECKS: DeckManagementItem[] = [
  {
    id: "ml-foundations",
    name: "ML Foundations",
    description: "foundation cards",
    dueCount: 63,
    cardCount: 512,
    lastReviewedLabel: "today",
    inRotation: true,
  },
  {
    id: "systems-design",
    name: "Systems Design",
    description: "architecture prompts",
    dueCount: 34,
    cardCount: 278,
    lastReviewedLabel: "today",
    inRotation: true,
  },
  {
    id: "math-review",
    name: "Math Review",
    description: "linear algebra, calculus, probability",
    dueCount: 21,
    cardCount: 196,
    lastReviewedLabel: "yesterday",
    inRotation: true,
  },
  {
    id: "research-papers",
    name: "Research Papers",
    description: "paper notes",
    dueCount: 18,
    cardCount: 142,
    lastReviewedLabel: "yesterday",
    inRotation: false,
  },
];
const SPEECH_COMMAND_SETTLE_MS = 1000;

function createEmptyDeckEmbeddingPlot(): DeckEmbeddingPlotResponse {
  return {
    model: null,
    totalQuestions: 0,
    embeddedQuestions: 0,
    points: [],
  };
}
const MAX_AVATAR_UPLOAD_BYTES = 512 * 1024;
const TERMINAL_SPEECH_COMMAND = /(?:^|\s)(submit|skip)[.!?]*$/i;
const DEFAULT_GENERATED_QUESTION_COUNT = 5;
const MAX_GENERATED_QUESTION_COUNT = 10;

const mathSymbolMap: Record<string, string> = {
  alpha: "\u03b1",
  beta: "\u03b2",
  delta: "\u03b4",
  Delta: "\u0394",
  epsilon: "\u03b5",
  eta: "\u03b7",
  gamma: "\u03b3",
  lambda: "\u03bb",
  mu: "\u03bc",
  nabla: "\u2207",
  partial: "\u2202",
  theta: "\u03b8",
};

function findClosingDelimiter(
  source: string,
  delimiter: string,
  startIndex: number,
) {
  for (let index = startIndex; index < source.length; index += 1) {
    if (
      source.startsWith(delimiter, index) &&
      source[index - 1] !== "\\"
    ) {
      return index;
    }
  }

  return -1;
}

function readMathGroup(source: string, startIndex: number): MathParseResult | null {
  if (source[startIndex] !== "{") {
    return null;
  }

  let depth = 0;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return {
          content: source.slice(startIndex + 1, index),
          nextIndex: index + 1,
        };
      }
    }
  }

  return null;
}

function readMathAtom(source: string, startIndex: number): MathParseResult {
  const group = readMathGroup(source, startIndex);

  if (group) {
    return group;
  }

  const atomMatch = source.slice(startIndex).match(/^[A-Za-z0-9]+/);

  if (atomMatch) {
    return {
      content: atomMatch[0],
      nextIndex: startIndex + atomMatch[0].length,
    };
  }

  return {
    content: source[startIndex] ?? "",
    nextIndex: startIndex + 1,
  };
}

function renderMathNodes(expression: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < expression.length) {
    if (expression.startsWith("\\frac", index)) {
      const numerator = readMathGroup(expression, index + "\\frac".length);

      if (numerator) {
        const denominator = readMathGroup(expression, numerator.nextIndex);

        if (denominator) {
          nodes.push(
            <span className="math-fraction" key={`frac-${index}`}>
              <span className="math-fraction-numerator">
                {renderMathNodes(numerator.content)}
              </span>
              <span className="math-fraction-denominator">
                {renderMathNodes(denominator.content)}
              </span>
            </span>,
          );
          index = denominator.nextIndex;
          continue;
        }
      }
    }

    const character = expression[index];

    if (character === "_" || character === "^") {
      const atom = readMathAtom(expression, index + 1);
      const Element = character === "_" ? "sub" : "sup";

      nodes.push(
        <Element key={`${character}-${index}`}>
          {renderMathNodes(atom.content)}
        </Element>,
      );
      index = atom.nextIndex;
      continue;
    }

    if (character === "\\") {
      const command = expression.slice(index + 1).match(/^[A-Za-z]+/);

      if (command) {
        nodes.push(
          <span className="math-command" key={`command-${index}`}>
            {mathSymbolMap[command[0]] ?? command[0]}
          </span>,
        );
        index += command[0].length + 1;
        continue;
      }
    }

    nodes.push(character);
    index += 1;
  }

  return nodes;
}

function MathExpression({
  expression,
  display = false,
}: {
  expression: string;
  display?: boolean;
}) {
  return (
    <span className={display ? "math-expression display" : "math-expression"}>
      {renderMathNodes(expression.trim())}
    </span>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const closeIndex = findClosingDelimiter(text, "**", index + 2);

      if (closeIndex > index) {
        nodes.push(
          <strong key={`strong-${index}`}>
            {renderInlineMarkdown(text.slice(index + 2, closeIndex))}
          </strong>,
        );
        index = closeIndex + 2;
        continue;
      }
    }

    if (text[index] === "`") {
      const closeIndex = findClosingDelimiter(text, "`", index + 1);

      if (closeIndex > index) {
        nodes.push(
          <code className="markdown-inline-code" key={`code-${index}`}>
            {text.slice(index + 1, closeIndex)}
          </code>,
        );
        index = closeIndex + 1;
        continue;
      }
    }

    if (text[index] === "$" && text[index + 1] !== "$") {
      const closeIndex = findClosingDelimiter(text, "$", index + 1);

      if (closeIndex > index) {
        nodes.push(
          <MathExpression
            expression={text.slice(index + 1, closeIndex)}
            key={`math-${index}`}
          />,
        );
        index = closeIndex + 1;
        continue;
      }
    }

    if (
      text[index] === "*" &&
      text[index + 1] !== "*" &&
      text[index - 1] !== "*"
    ) {
      const closeIndex = findClosingDelimiter(text, "*", index + 1);

      if (closeIndex > index) {
        nodes.push(
          <em key={`em-${index}`}>
            {renderInlineMarkdown(text.slice(index + 1, closeIndex))}
          </em>,
        );
        index = closeIndex + 1;
        continue;
      }
    }

    const nextSpecial = text
      .slice(index + 1)
      .search(/(\*\*|`|\$|\*)/);
    const endIndex =
      nextSpecial === -1 ? text.length : index + 1 + nextSpecial;

    nodes.push(text.slice(index, endIndex));
    index = endIndex;
  }

  return nodes;
}

function MarkdownInline({
  as: Element,
  className,
  text,
}: {
  as: "h2" | "p";
  className: string;
  text: string;
}) {
  const lines = text.split("\n");

  return (
    <Element className={className}>
      {lines.map((line, index) => (
        <Fragment key={`${line}-${index}`}>
          {index > 0 ? <br /> : null}
          {renderInlineMarkdown(line)}
        </Fragment>
      ))}
    </Element>
  );
}

function MarkdownContent({
  className,
  text,
}: {
  className: string;
  text: string;
}) {
  const blocks = text.trim().split(/\n{2,}/);

  return (
    <div className={`markdown-content ${className}`}>
      {blocks.map((block, index) => {
        const trimmedBlock = block.trim();
        const lines = trimmedBlock.split("\n");

        if (trimmedBlock.startsWith("$$") && trimmedBlock.endsWith("$$")) {
          return (
            <p className="markdown-paragraph" key={`display-${index}`}>
              <MathExpression
                display
                expression={trimmedBlock.slice(2, -2)}
              />
            </p>
          );
        }

        if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
          return (
            <ul className="markdown-list" key={`ul-${index}`}>
              {lines.map((line, lineIndex) => (
                <li key={`${line}-${lineIndex}`}>
                  {renderInlineMarkdown(line.trim().slice(2))}
                </li>
              ))}
            </ul>
          );
        }

        if (lines.every((line) => /^\d+\.\s+/.test(line.trim()))) {
          return (
            <ol className="markdown-list" key={`ol-${index}`}>
              {lines.map((line, lineIndex) => (
                <li key={`${line}-${lineIndex}`}>
                  {renderInlineMarkdown(line.trim().replace(/^\d+\.\s+/, ""))}
                </li>
              ))}
            </ol>
          );
        }

        return (
          <p className="markdown-paragraph" key={`p-${index}`}>
            {lines.map((line, lineIndex) => (
              <Fragment key={`${line}-${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {renderInlineMarkdown(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function formatDurationBadge(msUntilDue: number): string {
  if (msUntilDue <= 0) {
    return "NOW";
  }

  const totalSeconds = Math.ceil(msUntilDue / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 1) {
    return `${seconds}s`;
  }

  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 24) {
    return `${hours}h ${remainingMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

function scoreTone(score: number | null) {
  if (score === null) {
    return "neutral";
  }

  if (score <= 3) {
    return "low";
  }

  if (score <= 7) {
    return "medium";
  }

  return "high";
}

function PreviousAnswerScore({
  score,
  className,
  label,
}: {
  score: number | null;
  className?: string;
  label?: string;
}) {
  const displayScore = score === null ? "-" : score;
  const accessibleLabel = label ?? (
    score === null ? "No score" : `Score ${score} out of 10`
  );

  return (
    <span
      className={`previous-score-shell${className ? ` ${className}` : ""}`}
      aria-label={accessibleLabel}
    >
      <span className={`previous-score score-${scoreTone(score)}`}>
        {displayScore}
      </span>
    </span>
  );
}

function formatScore(score: number | null): string {
  return score === null ? "N/A" : `${score}/10`;
}

function formatAverageScore(score: number | null): string {
  return score === null ? "N/A" : `${score.toFixed(1)}/10`;
}

function formatReviewDate(timestamp: number | null): string {
  if (!timestamp) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatRelativeTime(timestamp: number | null, now: number): string {
  if (!timestamp) {
    return "Just now";
  }

  const elapsedMs = Math.max(0, now - timestamp);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return "Just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);

  if (elapsedDays < 7) {
    return `${elapsedDays}d ago`;
  }

  return formatReviewDate(timestamp);
}

function formatNextDue(stats: QuestionStats): string {
  if (stats.nextDue === null || stats.msUntilDue === null) {
    return "Unknown";
  }

  if (stats.msUntilDue <= 0) {
    return "Due now";
  }

  return `In ${formatDurationBadge(stats.msUntilDue)}`;
}

function mergeTranscriptText(base: string, addition: string): string {
  const trimmedAddition = addition.trim();

  if (!trimmedAddition) {
    return base;
  }

  if (!base.trim()) {
    return trimmedAddition;
  }

  return /\s$/.test(base) ? `${base}${trimmedAddition}` : `${base} ${trimmedAddition}`;
}

function extractTerminalSpeechCommand(
  baseAnswer: string,
  transcript: string,
): PendingSpeechCommand | null {
  const commandMatch = transcript.match(TERMINAL_SPEECH_COMMAND);

  if (!commandMatch) {
    return null;
  }

  const command = commandMatch[1]?.toLowerCase();

  if (command !== "submit" && command !== "skip") {
    return null;
  }

  const commandStart = commandMatch.index ?? 0;
  const beforeCommand = transcript.slice(0, commandStart);

  return {
    command,
    heldText: transcript.slice(commandStart).trim(),
    submitAnswer: mergeTranscriptText(baseAnswer, beforeCommand),
  };
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  const speechWindow = window as Window &
    typeof globalThis & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };

  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function MicrophoneIcon() {
  return <Mic aria-hidden="true" />;
}

function StopIcon() {
  return <Square aria-hidden="true" fill="currentColor" />;
}

function SettingsIcon() {
  return <Settings aria-hidden="true" />;
}

function ManageAccountIcon() {
  return <UserCog aria-hidden="true" />;
}

function SignOutIcon() {
  return <LogOut aria-hidden="true" />;
}

function UploadIcon() {
  return <Upload aria-hidden="true" />;
}

function RemoveIcon() {
  return <Trash2 aria-hidden="true" />;
}

function UserIcon() {
  return <User aria-hidden="true" />;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Could not read avatar image."));
    };
    reader.onerror = () => reject(new Error("Could not read avatar image."));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read context file."));
    reader.readAsText(file);
  });
}

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

function ScoreChart({ entries }: { entries: ReviewHistoryEntry[] }) {
  const width = 520;
  const height = 190;
  const padding = 28;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const points = entries.map((entry, index) => {
    const x =
      entries.length === 1
        ? padding + plotWidth / 2
        : padding + (index / (entries.length - 1)) * plotWidth;
    const y = padding + ((10 - entry.score) / 10) * plotHeight;

    return {
      ...entry,
      x,
      y,
    };
  });
  const path =
    points.length > 1
      ? points
          .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
          .join(" ")
      : "";

  if (entries.length === 0) {
    return (
      <div className="stats-chart-empty">
        Score history will appear after the first graded review.
      </div>
    );
  }

  return (
    <svg
      className="stats-chart"
      role="img"
      aria-label="Previous score history"
      viewBox={`0 0 ${width} ${height}`}
    >
      <line
        className="stats-chart-grid"
        x1={padding}
        x2={width - padding}
        y1={padding}
        y2={padding}
      />
      <line
        className="stats-chart-grid"
        x1={padding}
        x2={width - padding}
        y1={padding + plotHeight / 2}
        y2={padding + plotHeight / 2}
      />
      <line
        className="stats-chart-grid"
        x1={padding}
        x2={width - padding}
        y1={height - padding}
        y2={height - padding}
      />
      {path ? <path className="stats-chart-line" d={path} /> : null}
      {points.map((point, index) => (
        <g key={`${point.ts}-${index}`}>
          <circle className="stats-chart-point" cx={point.x} cy={point.y} r="5" />
          <text className="stats-chart-label" x={point.x} y={point.y - 10}>
            {point.score}
          </text>
        </g>
      ))}
      <text className="stats-chart-axis" x="8" y={padding + 4}>
        10
      </text>
      <text className="stats-chart-axis" x="14" y={height - padding + 4}>
        0
      </text>
    </svg>
  );
}

function SubmitIcon() {
  return <ArrowUp aria-hidden="true" />;
}

export default function ReviewApp({
  initialActiveTab = "review",
}: ReviewAppProps) {
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const cachedSessionRef = useRef(reviewSessionSnapshot);
  const hasLoadedQuestionRef = useRef(
    cachedSessionRef.current?.hasLoadedQuestion ?? false,
  );
  const hasLoadedQueueStatusRef = useRef(
    cachedSessionRef.current?.hasLoadedQueueStatus ?? false,
  );
  const loadedQueueSortKeyRef = useRef<QueueSortKey | null>(
    cachedSessionRef.current?.loadedQueueSortKey ?? null,
  );
  const [question, setQuestion] = useState<string | null>(
    () => cachedSessionRef.current?.question ?? null,
  );
  const [answer, setAnswer] = useState(
    () => cachedSessionRef.current?.answer ?? "",
  );
  const [speechPreview, setSpeechPreview] = useState(
    () => cachedSessionRef.current?.speechPreview ?? "",
  );
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle");
  const [speechMessage, setSpeechMessage] = useState<string | null>(null);
  const [queueRemaining, setQueueRemaining] = useState(
    () => cachedSessionRef.current?.queueRemaining ?? 0,
  );
  const [evaluations, setEvaluations] = useState<EvaluationQueueItem[]>(
    () => cachedSessionRef.current?.evaluations ?? [],
  );
  const [recentAttempts, setRecentAttempts] = useState<QuestionAttempt[]>(
    () => cachedSessionRef.current?.recentAttempts ?? [],
  );
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>(
    () => cachedSessionRef.current?.reviewQueue ?? [],
  );
  const [reviewQueueTotal, setReviewQueueTotal] = useState(
    () => cachedSessionRef.current?.reviewQueueTotal ?? 0,
  );
  const [isQueuePageLoading, setIsQueuePageLoading] = useState(false);
  const [queueVirtualRange, setQueueVirtualRange] = useState({
    start: cachedSessionRef.current?.queueVirtualRange.start ?? 0,
    end: cachedSessionRef.current?.queueVirtualRange.end ?? QUEUE_PAGE_SIZE,
  });
  const [queueSortKey] = useState<QueueSortKey>(
    () => cachedSessionRef.current?.queueSortKey ?? "review-date",
  );
  const [decks, setDecks] = useState<DeckManagementItem[]>(
    () => cachedSessionRef.current?.decks ?? INITIAL_DECKS,
  );
  const [selectedDeckId, setSelectedDeckId] = useState(
    () => cachedSessionRef.current?.selectedDeckId ?? INITIAL_DECKS[0].id,
  );
  const [deckSearchQuery, setDeckSearchQuery] = useState(
    () => cachedSessionRef.current?.deckSearchQuery ?? "",
  );
  const [deckSortKey, setDeckSortKey] = useState<DeckSortKey>(
    () => cachedSessionRef.current?.deckSortKey ?? "updated",
  );
  const [editingDeckId, setEditingDeckId] = useState<string | null>(
    () => cachedSessionRef.current?.editingDeckId ?? null,
  );
  const [deckDraftName, setDeckDraftName] = useState(
    () => cachedSessionRef.current?.deckDraftName ?? "",
  );
  const [deckDraftDescription, setDeckDraftDescription] = useState(
    () => cachedSessionRef.current?.deckDraftDescription ?? "",
  );
  const [deckEmbeddingPlot, setDeckEmbeddingPlot] =
    useState<DeckEmbeddingPlotResponse>(
      () => cachedSessionRef.current?.deckEmbeddingPlot ?? createEmptyDeckEmbeddingPlot(),
    );
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => cachedSessionRef.current?.messages ?? [],
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialActiveTab);
  const [referenceAnswers, setReferenceAnswers] = useState<
    Record<string, ReferenceAnswerState>
  >(() => cachedSessionRef.current?.referenceAnswers ?? {});
  const [isPreviousExpanded, setIsPreviousExpanded] = useState(
    () => cachedSessionRef.current?.isPreviousExpanded ?? false,
  );
  const [expandedPreviousAnswerIds, setExpandedPreviousAnswerIds] = useState<
    Set<string>
  >(() => new Set(cachedSessionRef.current?.expandedPreviousAnswerIds ?? []));
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(
    () => cachedSessionRef.current?.selectedQuestion ?? null,
  );
  const [isLoadingQuestion, setIsLoadingQuestion] = useState(
    () => !hasLoadedQuestionRef.current,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQuestionGeneratorOpen, setIsQuestionGeneratorOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserProfileResponse | null>(
    () => cachedSessionRef.current?.currentUser ?? null,
  );
  const [isAvatarUpdating, setIsAvatarUpdating] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const canViewAdmin = isAdminEmail(currentUser?.email);
  const menuAvatarUrl = clerkUser?.imageUrl || currentUser?.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    clerkUser?.username ||
    currentUser?.displayName ||
    "Account";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email || "";
  const [generatorScope, setGeneratorScope] = useState(
    () => cachedSessionRef.current?.generatorScope ?? "",
  );
  const [generatorQuestionCount, setGeneratorQuestionCount] = useState(
    () =>
      cachedSessionRef.current?.generatorQuestionCount ??
      DEFAULT_GENERATED_QUESTION_COUNT,
  );
  const [generatorFiles, setGeneratorFiles] = useState<GeneratorContextFile[]>(
    () => cachedSessionRef.current?.generatorFiles ?? [],
  );
  const [generatedQuestions, setGeneratedQuestions] = useState<
    GeneratedQuestionCandidate[]
  >(() => cachedSessionRef.current?.generatedQuestions ?? []);
  const [generatorMessage, setGeneratorMessage] = useState<string | null>(
    () => cachedSessionRef.current?.generatorMessage ?? null,
  );
  const [isGeneratingQuestions, setIsGeneratingQuestions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const answerRef = useRef(answer);
  const questionRef = useRef(question);
  const queueStageRef = useRef<HTMLElement | null>(null);
  const queueListRef = useRef<HTMLOListElement | null>(null);
  const queueLoadedLimitRef = useRef(
    cachedSessionRef.current?.queueLoadedLimit ?? QUEUE_PAGE_SIZE,
  );
  const isQueuePageLoadingRef = useRef(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const isSubmittingRef = useRef(isSubmitting);
  const keepListeningRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const pendingSpeechCommandRef = useRef<PendingSpeechCommand | null>(null);
  const pendingSpeechCommandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const prefetchedNextQuestionRef = useRef<PrefetchedNextQuestion | null>(null);
  const nextQuestionPrefetchRef = useRef<NextQuestionPrefetch | null>(null);

  const togglePreviousAnswerDetails = useCallback((id: string) => {
    setExpandedPreviousAnswerIds((currentIds) => {
      const nextIds = new Set(currentIds);

      if (nextIds.has(id)) {
        nextIds.delete(id);
      } else {
        nextIds.add(id);
      }

      return nextIds;
    });
  }, []);

  const navigateToTab = useCallback(
    (
      nextTab: ActiveTab,
      event?: ReactMouseEvent<HTMLAnchorElement>,
    ) => {
      event?.preventDefault();
      setActiveTab(nextTab);

      const nextPath = REVIEW_TAB_PATHS[nextTab];

      if (window.location.pathname !== nextPath) {
        window.history.pushState({ activeTab: nextTab }, "", nextPath);
      }
    },
    [],
  );

  const openQueue = useCallback(() => {
    navigateToTab("queue");
  }, [navigateToTab]);

  useEffect(() => {
    setActiveTab(initialActiveTab);
  }, [initialActiveTab]);

  useEffect(() => {
    function syncTabFromHistory() {
      const nextTab = getReviewTabFromPathname(window.location.pathname);

      if (nextTab) {
        setActiveTab(nextTab);
        return;
      }

      window.location.reload();
    }

    window.addEventListener("popstate", syncTabFromHistory);

    return () => window.removeEventListener("popstate", syncTabFromHistory);
  }, []);

  useEffect(() => {
    answerRef.current = answer;
  }, [answer]);

  useEffect(() => {
    questionRef.current = question;
  }, [question]);

  useEffect(() => {
    isSubmittingRef.current = isSubmitting;
  }, [isSubmitting]);

  useEffect(() => {
    isQueuePageLoadingRef.current = isQueuePageLoading;
  }, [isQueuePageLoading]);

  useEffect(() => {
    reviewSessionSnapshot = {
      question,
      answer,
      speechPreview,
      queueRemaining,
      evaluations,
      recentAttempts,
      reviewQueue,
      reviewQueueTotal,
      queueVirtualRange,
      queueSortKey,
      decks,
      selectedDeckId,
      deckSearchQuery,
      deckSortKey,
      editingDeckId,
      deckDraftName,
      deckDraftDescription,
      deckEmbeddingPlot,
      messages,
      referenceAnswers,
      isPreviousExpanded,
      expandedPreviousAnswerIds: new Set(expandedPreviousAnswerIds),
      selectedQuestion,
      currentUser,
      generatorScope,
      generatorQuestionCount,
      generatorFiles,
      generatedQuestions,
      generatorMessage,
      hasLoadedQuestion: hasLoadedQuestionRef.current,
      hasLoadedQueueStatus: hasLoadedQueueStatusRef.current,
      loadedQueueSortKey: loadedQueueSortKeyRef.current,
      queueLoadedLimit: queueLoadedLimitRef.current,
    };
  }, [
    answer,
    currentUser,
    deckDraftDescription,
    deckDraftName,
    deckEmbeddingPlot,
    deckSearchQuery,
    deckSortKey,
    decks,
    editingDeckId,
    evaluations,
    expandedPreviousAnswerIds,
    generatedQuestions,
    generatorFiles,
    generatorMessage,
    generatorQuestionCount,
    generatorScope,
    isPreviousExpanded,
    messages,
    question,
    queueRemaining,
    queueSortKey,
    queueVirtualRange,
    recentAttempts,
    referenceAnswers,
    reviewQueue,
    reviewQueueTotal,
    selectedDeckId,
    selectedQuestion,
    speechPreview,
  ]);

  const closeQuestionGenerator = useCallback(() => {
    if (isGeneratingQuestions) {
      return;
    }

    setIsQuestionGeneratorOpen(false);
    setGeneratedQuestions([]);
    setGeneratorMessage(null);
  }, [isGeneratingQuestions]);

  const selectedDeck =
    decks.find((deck) => deck.id === selectedDeckId) ?? decks[0] ?? null;
  const editingDeck =
    decks.find((deck) => deck.id === editingDeckId) ?? null;
  const visibleDecks = useMemo(() => {
    const normalizedQuery = deckSearchQuery.trim().toLowerCase();
    const filteredDecks = normalizedQuery
      ? decks.filter((deck) =>
          `${deck.name} ${deck.description}`
            .toLowerCase()
            .includes(normalizedQuery),
        )
      : decks;

    return [...filteredDecks].sort((a, b) => {
      if (deckSortKey === "name") {
        return a.name.localeCompare(b.name);
      }

      if (deckSortKey === "due") {
        return b.dueCount - a.dueCount || a.name.localeCompare(b.name);
      }

      return (
        Number(b.inRotation) - Number(a.inRotation) ||
        b.dueCount - a.dueCount ||
        a.name.localeCompare(b.name)
      );
    });
  }, [deckSearchQuery, deckSortKey, decks]);
  const rotationDeckCount = decks.filter((deck) => deck.inRotation).length;
  const rotationDueCount = decks.reduce(
    (total, deck) => (deck.inRotation ? total + deck.dueCount : total),
    0,
  );
  const totalCardCount = decks.reduce((total, deck) => total + deck.cardCount, 0);

  const openDeckEditor = useCallback((deck: DeckManagementItem) => {
    setSelectedDeckId(deck.id);
    setDeckDraftName(deck.name);
    setDeckDraftDescription(deck.description);
    setEditingDeckId(deck.id);
  }, []);

  const createDeck = useCallback(() => {
    const deckId = `deck-${Date.now()}`;
    const newDeck: DeckManagementItem = {
      id: deckId,
      name: "Untitled deck",
      description: "",
      dueCount: 0,
      cardCount: 0,
      lastReviewedLabel: "not reviewed",
      inRotation: false,
    };

    setDecks((currentDecks) => [newDeck, ...currentDecks]);
    setSelectedDeckId(deckId);
    setDeckDraftName(newDeck.name);
    setDeckDraftDescription(newDeck.description);
    setEditingDeckId(deckId);
  }, []);

  const saveDeckDraft = useCallback(() => {
    if (!editingDeckId) {
      return;
    }

    const nextName = deckDraftName.trim();

    setDecks((currentDecks) =>
      currentDecks.map((deck) =>
        deck.id === editingDeckId
          ? {
              ...deck,
              name: nextName || deck.name,
              description: deckDraftDescription.trim(),
            }
          : deck,
      ),
    );
    setEditingDeckId(null);
  }, [deckDraftDescription, deckDraftName, editingDeckId]);

  const deleteDeck = useCallback(
    (deckId: string) => {
      setDecks((currentDecks) => {
        const nextDecks = currentDecks.filter((deck) => deck.id !== deckId);

        if (selectedDeckId === deckId) {
          setSelectedDeckId(nextDecks[0]?.id ?? "");
        }

        if (editingDeckId === deckId) {
          setEditingDeckId(null);
        }

        return nextDecks;
      });
    },
    [editingDeckId, selectedDeckId],
  );

  const duplicateDeck = useCallback((deck: DeckManagementItem) => {
    const deckId = `deck-${Date.now()}`;
    const copiedDeck: DeckManagementItem = {
      ...deck,
      id: deckId,
      name: `${deck.name} copy`,
      inRotation: false,
      lastReviewedLabel: "not reviewed",
    };

    setDecks((currentDecks) => [copiedDeck, ...currentDecks]);
    setSelectedDeckId(deckId);
  }, []);

  const toggleDeckRotation = useCallback((deckId: string) => {
    setDecks((currentDecks) =>
      currentDecks.map((deck) =>
        deck.id === deckId
          ? {
              ...deck,
              inRotation: !deck.inRotation,
            }
          : deck,
      ),
    );
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 60_000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (cachedSessionRef.current?.currentUser) {
      return;
    }

    let isActive = true;

    async function loadUserProfile() {
      try {
        const response = await fetch("/api/user", {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error("Could not load profile.");
        }

        const data = (await response.json()) as UserProfileResponse;

        if (isActive) {
          setCurrentUser(data);
        }
      } catch {
        if (isActive) {
          setAvatarMessage("Could not load profile.");
        }
      }
    }

    void loadUserProfile();

    return () => {
      isActive = false;
    };
  }, []);

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

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    function closeSettingsOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
      }
    }

    window.addEventListener("keydown", closeSettingsOnEscape);

    return () => window.removeEventListener("keydown", closeSettingsOnEscape);
  }, [isSettingsOpen]);

  useEffect(() => {
    if (!isQuestionGeneratorOpen) {
      return;
    }

    function closeGeneratorOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        if (isGeneratingQuestions) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        closeQuestionGenerator();
      }
    }

    window.addEventListener("keydown", closeGeneratorOnEscape);

    return () => window.removeEventListener("keydown", closeGeneratorOnEscape);
  }, [closeQuestionGenerator, isGeneratingQuestions, isQuestionGeneratorOpen]);

  const clearPendingSpeechCommand = useCallback(() => {
    if (pendingSpeechCommandTimerRef.current) {
      clearTimeout(pendingSpeechCommandTimerRef.current);
      pendingSpeechCommandTimerRef.current = null;
    }

    pendingSpeechCommandRef.current = null;
  }, []);

  const appendAnswerText = useCallback((text: string) => {
    setAnswer((current) => {
      const nextAnswer = mergeTranscriptText(current, text);
      answerRef.current = nextAnswer;
      return nextAnswer;
    });
  }, []);

  const appendQuestion = useCallback((nextQuestion: string) => {
    setMessages((current) => {
      const last = current.at(-1);

      if (last?.kind === "question" && last.question === nextQuestion) {
        return current;
      }

      return [
        ...current,
        {
          id: `question-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          kind: "question",
          question: nextQuestion,
        },
      ];
    });
  }, []);

  const applyNextQuestion = useCallback((data: NextQuestionResponse) => {
    hasLoadedQuestionRef.current = true;
    setQuestion(data.question);
    questionRef.current = data.question;
    setQueueRemaining(data.queueRemaining);

    if (data.question) {
      appendQuestion(data.question);
    }
  }, [appendQuestion]);

  const prefetchNextQuestion = useCallback((excludeQuestion: string | null) => {
    const normalizedQuestion = excludeQuestion?.trim();

    if (!normalizedQuestion) {
      return;
    }

    if (prefetchedNextQuestionRef.current?.excludeQuestion === normalizedQuestion) {
      return;
    }

    if (nextQuestionPrefetchRef.current?.excludeQuestion === normalizedQuestion) {
      return;
    }

    prefetchedNextQuestionRef.current = null;
    nextQuestionPrefetchRef.current?.abortController.abort();

    const abortController = new AbortController();
    const promise = fetchNextQuestionData({
      excludeQuestion: normalizedQuestion,
      signal: abortController.signal,
    })
      .then((data): PrefetchedNextQuestion => ({
        excludeQuestion: normalizedQuestion,
        data,
      }))
      .catch((prefetchError): null => {
        if (
          prefetchError instanceof DOMException &&
          prefetchError.name === "AbortError"
        ) {
          return null;
        }

        return null;
      });

    const request: NextQuestionPrefetch = {
      excludeQuestion: normalizedQuestion,
      abortController,
      promise,
    };

    nextQuestionPrefetchRef.current = request;

    void promise.then((prefetched) => {
      if (nextQuestionPrefetchRef.current !== request) {
        return;
      }

      nextQuestionPrefetchRef.current = null;

      if (
        prefetched &&
        questionRef.current === prefetched.excludeQuestion
      ) {
        prefetchedNextQuestionRef.current = prefetched;
      }
    });
  }, []);

  const takePrefetchedNextQuestion = useCallback(
    async (excludeQuestion: string) => {
      const normalizedQuestion = excludeQuestion.trim();
      const cachedQuestion = prefetchedNextQuestionRef.current;

      if (cachedQuestion?.excludeQuestion === normalizedQuestion) {
        prefetchedNextQuestionRef.current = null;
        return cachedQuestion.data;
      }

      const pendingPrefetch = nextQuestionPrefetchRef.current;

      if (pendingPrefetch?.excludeQuestion !== normalizedQuestion) {
        return null;
      }

      const prefetched = await pendingPrefetch.promise;

      if (nextQuestionPrefetchRef.current === pendingPrefetch) {
        nextQuestionPrefetchRef.current = null;
      }

      if (prefetched?.excludeQuestion !== normalizedQuestion) {
        return null;
      }

      prefetchedNextQuestionRef.current = null;
      return prefetched.data;
    },
    [],
  );

  const loadNextQuestion = useCallback(async (options?: {
    excludeQuestion?: string | null;
    surfaceError?: boolean;
  }) => {
    const surfaceError = options?.surfaceError ?? true;

    setIsLoadingQuestion(true);
    setQuestion(null);
    questionRef.current = null;
    setError(null);

    try {
      const data = await fetchNextQuestionData({
        excludeQuestion: options?.excludeQuestion,
      });
      applyNextQuestion(data);
      hasLoadedQuestionRef.current = true;
    } catch (loadError) {
      if (surfaceError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load the next question.",
        );
      }
    } finally {
      setIsLoadingQuestion(false);
    }
  }, [applyNextQuestion]);

  const queueStatusUrl = useCallback((limit: number) => {
    const params = new URLSearchParams({
      limit: String(Math.max(0, Math.floor(limit))),
      offset: "0",
      sort: queueSortKey,
    });

    return `/api/queue-status?${params.toString()}`;
  }, [queueSortKey]);

  const applyQueueStatus = useCallback((data: QueueStatusResponse) => {
    setQueueRemaining(data.queueRemaining);
    setEvaluations(data.evaluations);
    setRecentAttempts(data.recentAttempts ?? []);
    setReviewQueue(data.reviewQueue);
    setReviewQueueTotal(data.reviewQueueTotal ?? data.reviewQueue.length);
    queueLoadedLimitRef.current = Math.max(
      QUEUE_PAGE_SIZE,
      data.reviewQueueLimit ?? data.reviewQueue.length,
    );
    hasLoadedQueueStatusRef.current = true;
    loadedQueueSortKeyRef.current = queueSortKey;
    setDeckEmbeddingPlot(
      data.deckEmbeddingPlot ?? createEmptyDeckEmbeddingPlot(),
    );
  }, [queueSortKey]);

  const loadStatus = useCallback(async (limit = QUEUE_PAGE_SIZE) => {
    if (isQueuePageLoadingRef.current) {
      return;
    }

    isQueuePageLoadingRef.current = true;
    setIsQueuePageLoading(true);

    try {
      const response = await fetch(queueStatusUrl(limit), {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as QueueStatusResponse;
      applyQueueStatus(data);
    } catch {
      // Status is informational; keep the review loop usable if polling fails.
    } finally {
      isQueuePageLoadingRef.current = false;
      setIsQueuePageLoading(false);
    }
  }, [applyQueueStatus, queueStatusUrl]);

  useEffect(() => {
    if (hasLoadedQuestionRef.current) {
      return;
    }

    void loadNextQuestion({ surfaceError: false });
  }, [clearPendingSpeechCommand, loadNextQuestion]);

  useEffect(() => {
    if (!question) {
      prefetchedNextQuestionRef.current = null;
      nextQuestionPrefetchRef.current?.abortController.abort();
      nextQuestionPrefetchRef.current = null;
      return;
    }

    prefetchNextQuestion(question);
  }, [prefetchNextQuestion, question]);

  useEffect(() => {
    return () => {
      nextQuestionPrefetchRef.current?.abortController.abort();
    };
  }, []);

  useEffect(() => {
    const shouldLoadQueueStatus =
      !hasLoadedQueueStatusRef.current ||
      loadedQueueSortKeyRef.current !== queueSortKey;

    if (shouldLoadQueueStatus) {
      queueLoadedLimitRef.current = QUEUE_PAGE_SIZE;
      setReviewQueue([]);
      setRecentAttempts([]);
      setReviewQueueTotal(0);
      setQueueVirtualRange({
        start: 0,
        end: QUEUE_PAGE_SIZE,
      });
      void loadStatus(QUEUE_PAGE_SIZE);
    }

    const events = new EventSource("/api/queue-status/stream");

    events.addEventListener("status", (event) => {
      try {
        JSON.parse((event as MessageEvent<string>).data) as QueueStatusResponse;
        void loadStatus(Math.max(QUEUE_PAGE_SIZE, queueLoadedLimitRef.current));
      } catch {
        // Ignore malformed stream events; the connection can continue.
      }
    });

    events.onerror = () => {
      events.close();
      void loadStatus(Math.max(QUEUE_PAGE_SIZE, queueLoadedLimitRef.current));
    };

    return () => events.close();
  }, [loadStatus, queueSortKey]);

  useEffect(() => {
    setMessages((current) => {
      let hasChanged = false;

      const nextMessages = current.map((message) => {
        if (message.kind !== "answer") {
          return message;
        }

        const evaluation = evaluations.find(
          (candidate) => candidate.id === message.evaluationId,
        );

        if (!evaluation) {
          return message;
        }

        if (
          message.status === evaluation.status &&
          message.score === evaluation.score &&
          message.justification === evaluation.justification &&
          message.answerSummary === evaluation.answerSummary &&
          message.nextDue === evaluation.nextDue &&
          message.resolvedAt === evaluation.resolvedAt
        ) {
          return message;
        }

        hasChanged = true;

        return {
          ...message,
          status: evaluation.status,
          score: evaluation.score,
          justification: evaluation.justification,
          answerSummary: evaluation.answerSummary,
          nextDue: evaluation.nextDue,
          resolvedAt: evaluation.resolvedAt,
        };
      });

      return hasChanged ? nextMessages : current;
    });
  }, [evaluations]);

  const submit = useCallback(async (answerOverride?: string) => {
    clearPendingSpeechCommand();
    const activeQuestion = questionRef.current;

    if (!activeQuestion || isSubmittingRef.current) {
      return false;
    }

    const submittedQuestion = activeQuestion;
    const submittedAnswer = (answerOverride ?? answerRef.current).trim();
    const submittedAt = Date.now();

    setIsSubmitting(true);
    setAnswer("");
    setSpeechPreview("");
    setError(null);

    try {
      const response = await fetch("/api/submit-answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: submittedQuestion,
          answer: submittedAnswer,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to submit the answer.");
      }

      const data = (await response.json()) as SubmitAnswerResponse;

      setMessages((current) => [
        ...current,
        {
          id: `answer-${data.evaluationId}`,
          kind: "answer",
          question: submittedQuestion,
          answer: submittedAnswer || "(blank)",
          evaluationId: data.evaluationId,
          submittedAt,
          status: "grading",
          score: null,
          justification: null,
          answerSummary: null,
          nextDue: null,
          resolvedAt: null,
        },
      ]);

      const prefetchedQuestion =
        await takePrefetchedNextQuestion(submittedQuestion);

      if (prefetchedQuestion) {
        applyNextQuestion({
          ...prefetchedQuestion,
          queueRemaining: Math.max(0, prefetchedQuestion.queueRemaining - 1),
        });
      } else {
        await loadNextQuestion({ excludeQuestion: submittedQuestion });
      }

      return true;
    } catch (submitError) {
      setQuestion(submittedQuestion);
      setAnswer(submittedAnswer);
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to submit the answer.",
      );
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [
    applyNextQuestion,
    clearPendingSpeechCommand,
    loadNextQuestion,
    takePrefetchedNextQuestion,
  ]);

  const skipCurrentQuestion = useCallback(async () => {
    clearPendingSpeechCommand();
    const activeQuestion = questionRef.current;

    if (!activeQuestion || isSubmittingRef.current) {
      return false;
    }

    setAnswer("");
    answerRef.current = "";
    setSpeechPreview("");
    setError(null);

    try {
      const response = await fetch("/api/skip-question", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: activeQuestion,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to skip the question.");
      }

      const data = (await response.json()) as NextQuestionResponse;
      hasLoadedQuestionRef.current = true;
      setQuestion(data.question);
      questionRef.current = data.question;
      setQueueRemaining(data.queueRemaining);

      if (data.question) {
        appendQuestion(data.question);
      }

      return true;
    } catch (skipError) {
      setError(
        skipError instanceof Error
          ? skipError.message
          : "Failed to skip the question.",
      );
      return false;
    }
  }, [appendQuestion, clearPendingSpeechCommand]);

  const handleSpeechText = useCallback(
    async (transcript: string) => {
      let transcriptToApply = transcript;
      const pendingCommand = pendingSpeechCommandRef.current;

      if (pendingCommand) {
        clearPendingSpeechCommand();
        transcriptToApply = mergeTranscriptText(
          pendingCommand.heldText,
          transcriptToApply,
        );
      }

      const speechCommand = extractTerminalSpeechCommand(
        answerRef.current,
        transcriptToApply,
      );

      if (!speechCommand) {
        appendAnswerText(transcriptToApply);
        return;
      }

      if (speechCommand.command === "submit") {
        setAnswer("");
        answerRef.current = "";
        setSpeechPreview("");
      } else {
        setAnswer(speechCommand.submitAnswer);
        answerRef.current = speechCommand.submitAnswer;
      }

      pendingSpeechCommandRef.current = speechCommand;
      pendingSpeechCommandTimerRef.current = setTimeout(() => {
        const commandToRun = pendingSpeechCommandRef.current;

        if (!commandToRun) {
          return;
        }

        clearPendingSpeechCommand();

        if (commandToRun.command === "submit") {
          void submit(commandToRun.submitAnswer);
          return;
        }

        void skipCurrentQuestion();
      }, SPEECH_COMMAND_SETTLE_MS);
    },
    [
      appendAnswerText,
      clearPendingSpeechCommand,
      skipCurrentQuestion,
      submit,
    ],
  );

  const stopSpeech = useCallback(() => {
    clearPendingSpeechCommand();
    keepListeningRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setSpeechPreview("");
    setSpeechMessage(null);
    setSpeechStatus("idle");
  }, [clearPendingSpeechCommand]);

  const startSpeech = useCallback(() => {
    const SpeechRecognitionConstructor = getSpeechRecognitionConstructor();

    if (!SpeechRecognitionConstructor) {
      setSpeechStatus("unsupported");
      setSpeechMessage("Speech recognition is not available in this browser.");
      return;
    }

    keepListeningRef.current = true;
    setSpeechStatus("starting");
    setSpeechMessage("Starting microphone...");

    const recognition = new SpeechRecognitionConstructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? "";

        if (result.isFinal) {
          finalTranscript = mergeTranscriptText(finalTranscript, transcript);
        } else {
          interimTranscript = mergeTranscriptText(interimTranscript, transcript);
        }
      }

      if (interimTranscript && pendingSpeechCommandRef.current) {
        const pendingCommand = pendingSpeechCommandRef.current;

        clearPendingSpeechCommand();

        if (pendingCommand.command === "submit") {
          const answerToRestore = mergeTranscriptText(
            pendingCommand.submitAnswer,
            pendingCommand.heldText,
          );

          setAnswer(answerToRestore);
          answerRef.current = answerToRestore;
          return;
        }

        appendAnswerText(pendingCommand.heldText);
      }

      setSpeechPreview(interimTranscript);

      if (finalTranscript) {
        setSpeechPreview("");
        void handleSpeechText(finalTranscript);
      }
    };
    recognition.onerror = () => {
      setSpeechStatus("error");
      setSpeechMessage("Microphone transcription stopped.");
    };
    recognition.onend = () => {
      if (!keepListeningRef.current) {
        return;
      }

      try {
        recognition.start();
      } catch {
        setSpeechStatus("error");
        setSpeechMessage("Microphone transcription stopped.");
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
      setSpeechStatus("listening");
      setSpeechMessage("Streaming speech into the answer.");
    } catch {
      setSpeechStatus("error");
      setSpeechMessage("Microphone transcription could not start.");
      return;
    }
  }, [appendAnswerText, clearPendingSpeechCommand, handleSpeechText]);

  useEffect(() => {
    return () => {
      clearPendingSpeechCommand();
      keepListeningRef.current = false;
      recognitionRef.current?.stop();
    };
  }, [clearPendingSpeechCommand]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  const displayedAnswer = speechPreview
    ? mergeTranscriptText(answer, speechPreview)
    : answer;
  const isSpeechActive =
    speechStatus === "starting" ||
    speechStatus === "listening";

  function handleAnswerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      void submit();
    }
  }

  async function saveAvatar(avatarUrl: string | null) {
    setIsAvatarUpdating(true);
    setAvatarMessage(null);

    try {
      const response = await fetch("/api/user", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ avatarUrl }),
      });
      const data = (await response.json()) as
        | UserProfileResponse
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in data && data.error ? data.error : "Could not update avatar.",
        );
      }

      setCurrentUser(data as UserProfileResponse);
      setAvatarMessage(avatarUrl ? "Avatar updated." : "Avatar removed.");
    } catch (avatarError) {
      setAvatarMessage(
        avatarError instanceof Error
          ? avatarError.message
          : "Could not update avatar.",
      );
    } finally {
      setIsAvatarUpdating(false);
    }
  }

  async function handleAvatarFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      setAvatarMessage("Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }

    if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
      setAvatarMessage("Choose an image under 512 KB.");
      return;
    }

    try {
      const avatarUrl = await readFileAsDataUrl(file);
      await saveAvatar(avatarUrl);
    } catch (avatarError) {
      setAvatarMessage(
        avatarError instanceof Error
          ? avatarError.message
          : "Could not read avatar image.",
      );
    }
  }

  async function addGeneratorContextFiles(selectedFiles: File[]) {
    if (selectedFiles.length === 0) {
      return;
    }

    const contextFiles = await Promise.all(
      selectedFiles.map(async (file) => {
        if (!isTextContextFile(file)) {
          return {
            id: createClientId("context-file"),
            name: file.name,
            content: `${file.name} (${file.type || "file"})`,
            status: "metadata-only" as const,
          };
        }

        try {
          return {
            id: createClientId("context-file"),
            name: file.name,
            content: await readFileAsText(file),
            status: "ready" as const,
          };
        } catch {
          return {
            id: createClientId("context-file"),
            name: file.name,
            content: file.name,
            status: "metadata-only" as const,
          };
        }
      }),
    );

    setGeneratorFiles((current) => [...current, ...contextFiles]);
    setGeneratorMessage(null);
  }

  async function handleGeneratorFileDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (isGeneratingQuestions) {
      return;
    }

    await addGeneratorContextFiles(Array.from(event.dataTransfer.files ?? []));
  }

  function removeGeneratorFile(fileId: string) {
    setGeneratorFiles((current) => current.filter((file) => file.id !== fileId));
  }

  async function generateQuestionBatch() {
    if (generatedQuestions.length > 0) {
      setGeneratorMessage("Clear the review queue before generating again.");
      return;
    }

    const count = Math.min(
      MAX_GENERATED_QUESTION_COUNT,
      Math.max(1, generatorQuestionCount),
    );
    const hasContext =
      generatorScope.trim().length > 0 || generatorFiles.length > 0;

    if (!hasContext) {
      setGeneratorMessage("Add a topic or attach context before generating.");
      return;
    }

    setIsGeneratingQuestions(true);
    setGeneratorMessage(null);

    try {
      const response = await fetch("/api/questions/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          scope: generatorScope,
          files: generatorFiles,
          count,
          difficulty: "Mixed",
          existingQuestions: [
            ...reviewQueue.map((item) => item.question),
          ],
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
        conciseAnswer: item.conciseAnswer || "",
        coverageLabel: item.coverageLabel || item.question,
        status: "new" as const,
      }));

      setGeneratedQuestions((current) => [...candidates, ...current]);
      setGeneratorMessage(
        candidates.length > 0
          ? `${candidates.length} generated by ${data.model}.`
          : "OpenRouter returned no new questions.",
      );
    } catch (generateError) {
      setGeneratorMessage(
        generateError instanceof Error
          ? generateError.message
          : "Could not generate questions.",
      );
    } finally {
      setIsGeneratingQuestions(false);
    }
  }

  function toggleGeneratedQuestionSelection(questionId: string) {
    const questionToSelect = generatedQuestions.find(
      (item) => item.id === questionId,
    );

    if (
      !questionToSelect ||
      (questionToSelect.status !== "new" &&
        questionToSelect.status !== "selected")
    ) {
      return;
    }

    setGeneratedQuestions((current) =>
      current.map((item) =>
        item.id === questionId
          ? {
              ...item,
              status: item.status === "selected" ? "new" : "selected",
            }
          : item,
      ),
    );
    setGeneratorMessage(null);
  }

  async function addSelectedGeneratedQuestionsToDeck() {
    const questionsToAdd = generatedQuestions.filter(
      (item) => item.status === "selected",
    );

    if (questionsToAdd.length === 0) {
      return;
    }

    const questionIdsToAdd = new Set(questionsToAdd.map((item) => item.id));

    setGeneratedQuestions((current) =>
      current.map((item) =>
        questionIdsToAdd.has(item.id)
          ? {
              ...item,
              status: "adding",
            }
          : item,
      ),
    );
    setGeneratorMessage(null);

    try {
      const response = await fetch("/api/questions/add", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          questions: questionsToAdd.map((item) => ({
            question: item.question,
            conciseAnswer: item.conciseAnswer,
          })),
        }),
      });
      const data = (await response.json()) as
        | { ok: true; added: number; rejected?: number }
        | { ok: false; error?: string };

      if (!response.ok || !data.ok) {
        throw new Error(!data.ok && data.error ? data.error : "Could not add questions.");
      }

      setGeneratedQuestions((current) =>
        current.filter((item) => !questionIdsToAdd.has(item.id)),
      );
      setGeneratorMessage(
        data.added > 0
          ? `${data.added} ${
              data.added === 1 ? "question" : "questions"
            } added to deck${
              data.rejected ? `, ${data.rejected} semantic duplicates rejected` : ""
            }.`
          : questionsToAdd.length === 1
            ? "Question already exists or was rejected as a duplicate."
            : "Questions already exist or were rejected as duplicates.",
      );
      await loadStatus();

      if (!questionRef.current) {
        await loadNextQuestion({ surfaceError: false });
      }

      if (data.added > 0) {
        closeQuestionGenerator();
      }
    } catch (addError) {
      setGeneratorMessage(
        addError instanceof Error
          ? addError.message
          : "Could not add questions.",
      );
      setGeneratedQuestions((current) =>
        current.map((item) =>
          questionIdsToAdd.has(item.id)
            ? {
                ...item,
                status: "selected",
              }
            : item,
        ),
      );
    }
  }

  const sessionPreviousAnswers: PreviousAnswerItem[] = messages
    .filter(
      (message): message is Extract<ChatMessage, { kind: "answer" }> =>
        message.kind === "answer",
    )
    .slice()
    .reverse()
    .map((message) => {
      const timestamp = message.resolvedAt ?? message.submittedAt;

      return {
        id: message.id,
        question: message.question,
        answer: message.answer,
        status: message.status,
        score: message.score,
        justification: message.justification,
        timestamp,
        timeLabel:
          message.status === "grading"
            ? "Just now"
            : formatRelativeTime(timestamp, currentTime),
      };
    });

  const sessionPreviousEvaluationIds = new Set(
    messages
      .filter(
        (message): message is Extract<ChatMessage, { kind: "answer" }> =>
          message.kind === "answer",
      )
      .map((message) => message.evaluationId),
  );

  const evaluationPreviousAnswers: PreviousAnswerItem[] = evaluations
    .filter(
      (evaluation) =>
        !sessionPreviousEvaluationIds.has(evaluation.id) &&
        evaluation.answer !== null,
    )
    .slice()
    .reverse()
    .map((evaluation) => {
      const timestamp = evaluation.resolvedAt ?? evaluation.submittedAt;

      return {
        id: `evaluation-${evaluation.id}`,
        question: evaluation.question,
        answer: evaluation.answer || "(blank)",
        status: evaluation.status,
        score: evaluation.score,
        justification: evaluation.justification,
        timestamp,
        timeLabel:
          evaluation.status === "grading"
            ? "Just now"
            : formatRelativeTime(timestamp, currentTime),
      };
    });

  const livePreviousQuestions = new Set([
    ...sessionPreviousAnswers.map((previousItem) => previousItem.question),
    ...evaluationPreviousAnswers.map((previousItem) => previousItem.question),
  ]);

  const recentAttemptPreviousAnswers: PreviousAnswerItem[] = recentAttempts
    .filter((attempt) => {
      if (
        attempt.question === question ||
        livePreviousQuestions.has(attempt.question)
      ) {
        return false;
      }

      return !messages.some((message) => {
        if (message.kind !== "answer") {
          return false;
        }

        return (
          message.question === attempt.question &&
          message.answer === attempt.rawAnswer &&
          Math.abs(message.submittedAt - attempt.submittedAt) < 10_000
        );
      });
    })
    .map((attempt) => ({
      id: `attempt-${attempt.id}`,
      question: attempt.question,
      answer: attempt.rawAnswer || "(blank)",
      status: "resolved",
      score: attempt.score,
      justification: attempt.justification,
      timestamp: attempt.resolvedAt || attempt.submittedAt,
      timeLabel: formatRelativeTime(
        attempt.resolvedAt || attempt.submittedAt,
        currentTime,
      ),
    }));
  const recentAttemptQuestions = new Set(
    recentAttemptPreviousAnswers.map((previousItem) => previousItem.question),
  );

  const historicalPreviousAnswers: PreviousAnswerItem[] = reviewQueue
    .filter(
      (item) =>
        item.lastScore !== null &&
        item.lastAnswer !== null &&
        item.question !== question &&
        !livePreviousQuestions.has(item.question) &&
        !recentAttemptQuestions.has(item.question),
    )
    .sort((a, b) => {
      const aScore = a.lastScore ?? -1;
      const bScore = b.lastScore ?? -1;

      if ((aScore >= 7) !== (bScore >= 7)) {
        return aScore >= 7 ? -1 : 1;
      }

      return b.nextDue - a.nextDue;
    })
    .slice(0, EXPANDED_PREVIOUS_ANSWER_LIMIT)
    .map((item) => {
      const latestAttempt = item.attempts.at(-1);
      const timestamp =
        latestAttempt?.resolvedAt ??
        latestAttempt?.submittedAt ??
        item.reviewHistory.at(-1)?.ts ??
        null;

      return {
        id: `history-${item.question}`,
        question: item.question,
        answer: item.lastAnswer,
        status: "resolved",
        score: item.lastScore,
        justification:
          item.lastJustification ??
          "Covers the core idea; a few details could be sharper.",
        timestamp,
        timeLabel: formatRelativeTime(timestamp, currentTime),
      };
    });

  const previousAnswers = [
    ...sessionPreviousAnswers,
    ...evaluationPreviousAnswers,
    ...recentAttemptPreviousAnswers,
    ...historicalPreviousAnswers,
  ];
  const hasPreviousAnswers = previousAnswers.length > 0;
  const visiblePreviousAnswers = isPreviousExpanded
    ? previousAnswers
    : previousAnswers.slice(0, COLLAPSED_PREVIOUS_ANSWER_LIMIT);
  const hasHiddenPreviousAnswers =
    previousAnswers.length > visiblePreviousAnswers.length;
  const isReviewResting = !isLoadingQuestion && !question;
  const scheduledReviewCount = reviewQueue.filter(
    (item) => item.status === "scheduled",
  ).length;
  const nextScheduledReview = reviewQueue.find(
    (item) => item.status === "scheduled",
  );
  const previousAnswerPlaceholderCount = isPreviousExpanded
    ? 0
    : isReviewResting
      ? 0
    : Math.max(
        0,
        COLLAPSED_PREVIOUS_ANSWER_LIMIT - visiblePreviousAnswers.length,
      );

  const selectedQuestionStats = useMemo<QuestionStats | null>(() => {
    if (!selectedQuestion) {
      return null;
    }

    const queueItem = reviewQueue.find((item) => item.question === selectedQuestion);
    const recentQuestionAttempts = recentAttempts.filter(
      (attempt) => attempt.question === selectedQuestion,
    );
    const resolvedEvaluations = evaluations.filter(
      (evaluation) =>
        evaluation.question === selectedQuestion &&
        evaluation.status === "resolved" &&
        evaluation.score !== null,
    );
    const latestResolvedEvaluation = resolvedEvaluations.findLast(
      (evaluation) => evaluation.justification,
    );
    const historyMap = new Map<string, ReviewHistoryEntry>();

    for (const entry of queueItem?.reviewHistory ?? []) {
      historyMap.set(`${entry.ts}-${entry.score}`, entry);
    }

    for (const attempt of recentQuestionAttempts) {
      historyMap.set(`${attempt.resolvedAt}-${attempt.score}`, {
        ts: attempt.resolvedAt,
        score: attempt.score,
      });
    }

    for (const evaluation of resolvedEvaluations) {
      const ts = evaluation.resolvedAt ?? evaluation.submittedAt;
      const score = evaluation.score;

      if (score !== null) {
        historyMap.set(`${ts}-${score}`, {
          ts,
          score,
        });
      }
    }

    const reviewHistory = Array.from(historyMap.values()).sort(
      (a, b) => a.ts - b.ts,
    );
    const scores = reviewHistory.map((entry) => entry.score);
    const pendingCount = evaluations.filter(
      (evaluation) =>
        evaluation.question === selectedQuestion &&
        evaluation.status === "grading",
    ).length;
    const selectedAnswerMessages = messages.filter(
      (message): message is Extract<ChatMessage, { kind: "answer" }> =>
        message.kind === "answer" && message.question === selectedQuestion,
    );
    const latestResolvedEvaluationWithNextDue = resolvedEvaluations.findLast(
      (evaluation) => evaluation.nextDue !== null,
    );
    const latestAnswerMessageWithNextDue = selectedAnswerMessages.findLast(
      (message) => message.nextDue !== null,
    );
    const nextDue =
      queueItem?.nextDue ??
      latestResolvedEvaluationWithNextDue?.nextDue ??
      latestAnswerMessageWithNextDue?.nextDue ??
      null;
    const msUntilDue =
      queueItem?.msUntilDue ?? (nextDue === null ? null : nextDue - currentTime);
    const dueStatus =
      queueItem?.status ??
      (msUntilDue === null ? "unknown" : msUntilDue <= 0 ? "now" : "scheduled");
    const lastScore = scores.at(-1) ?? queueItem?.lastScore ?? null;
    const persistedAttempts = [
      ...(queueItem?.attempts ?? []),
      ...recentQuestionAttempts.filter(
        (attempt) =>
          !(queueItem?.attempts ?? []).some(
            (queueAttempt) => queueAttempt.id === attempt.id,
          ),
      ),
    ];
    const persistedAnswerHistory: AnswerHistoryEntry[] =
      persistedAttempts.map((attempt) => ({
        id: `attempt-${attempt.id}`,
        rawAnswer: attempt.rawAnswer || "(blank)",
        answerSummary: attempt.answerSummary || null,
        score: attempt.score,
        justification: attempt.justification || null,
        submittedAt: attempt.submittedAt,
        resolvedAt: attempt.resolvedAt,
        status: "resolved",
      }));
    const sessionAnswerHistory: AnswerHistoryEntry[] = selectedAnswerMessages
      .map((message) => {
        const evaluation = evaluations.find(
          (candidate) => candidate.id === message.evaluationId,
        );

        return {
          id: `session-${message.evaluationId}`,
          rawAnswer: message.answer,
          answerSummary: message.answerSummary,
          score: message.score,
          justification: message.justification,
          submittedAt: evaluation?.submittedAt ?? message.submittedAt,
          resolvedAt: evaluation?.resolvedAt ?? message.resolvedAt,
          status: message.status,
        };
      })
      .filter(
        (messageAttempt) =>
          !persistedAnswerHistory.some(
            (persistedAttempt) =>
              persistedAttempt.rawAnswer === messageAttempt.rawAnswer &&
              persistedAttempt.score === messageAttempt.score &&
              Math.abs(
                persistedAttempt.submittedAt - messageAttempt.submittedAt,
              ) < 10_000,
          ),
      );
    const answerHistory = [
      ...persistedAnswerHistory,
      ...sessionAnswerHistory,
    ].sort((a, b) => b.submittedAt - a.submittedAt);

    return {
      question: selectedQuestion,
      reviewHistory,
      answerHistory,
      attempts: reviewHistory.length,
      averageScore:
        scores.length > 0
          ? scores.reduce((total, score) => total + score, 0) / scores.length
          : null,
      bestScore: scores.length > 0 ? Math.max(...scores) : null,
      lastScore,
      lastReviewedAt: reviewHistory.at(-1)?.ts ?? null,
      nextDue,
      msUntilDue,
      dueStatus,
      pendingCount,
      generatedFromQuestion: queueItem?.generatedFromQuestion ?? null,
      conciseAnswer: queueItem?.conciseAnswer ?? null,
      referenceAnswer: queueItem?.referenceAnswer ?? null,
      lastJustification:
        queueItem?.lastJustification ??
        latestResolvedEvaluation?.justification ??
        null,
    };
  }, [
    currentTime,
    evaluations,
    messages,
    recentAttempts,
    reviewQueue,
    selectedQuestion,
  ]);

  const selectedReferenceAnswerState = selectedQuestionStats
    ? referenceAnswers[selectedQuestionStats.question]
    : undefined;
  const selectedReferenceAnswer =
    selectedQuestionStats?.referenceAnswer ??
    (selectedReferenceAnswerState?.status === "resolved"
      ? selectedReferenceAnswerState.answer
      : null);
  const isGeneratingReferenceAnswer =
    selectedReferenceAnswerState?.status === "loading";
  const referenceAnswerError =
    selectedReferenceAnswerState?.status === "error"
      ? selectedReferenceAnswerState.answer
      : null;
  const generatedQuestionCounts = generatedQuestions.reduce(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    {
      new: 0,
      selected: 0,
      adding: 0,
      added: 0,
    } satisfies Record<GeneratedQuestionStatus, number>,
  );
  const hasGeneratorContext =
    generatorScope.trim().length > 0 || generatorFiles.length > 0;
  const isGeneratorReviewStep = generatedQuestions.length > 0;

  useEffect(() => {
    if (!selectedQuestionStats) {
      return;
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedQuestion(null);
      }
    }

    window.addEventListener("keydown", closeOnEscape);

    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedQuestionStats]);

  async function generateReferenceAnswer(questionToAnswer: string) {
    const storedAnswer =
      reviewQueue.find((item) => item.question === questionToAnswer)
        ?.referenceAnswer ?? null;

    if (storedAnswer) {
      setReferenceAnswers((current) => ({
        ...current,
        [questionToAnswer]: {
          status: "resolved",
          answer: storedAnswer,
        },
      }));
      return;
    }

    setReferenceAnswers((current) => ({
      ...current,
      [questionToAnswer]: {
        status: "loading",
        answer: "Generating reference answer...",
      },
    }));

    try {
      const response = await fetch("/api/reference-answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: questionToAnswer,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to generate reference answer.");
      }

      const data = (await response.json()) as ReferenceAnswerResponse;

      setReferenceAnswers((current) => ({
        ...current,
        [questionToAnswer]: {
          status: "resolved",
          answer: data.answer,
        },
      }));
      setReviewQueue((current) =>
        current.map((queueItem) =>
          queueItem.question === questionToAnswer
            ? {
                ...queueItem,
                referenceAnswer: data.answer.startsWith(
                  "Reference answer is unavailable",
                )
                  ? queueItem.referenceAnswer
                  : data.answer,
              }
            : queueItem,
        ),
      );
    } catch {
      setReferenceAnswers((current) => ({
        ...current,
        [questionToAnswer]: {
          status: "error",
          answer: "Reference answer is unavailable right now.",
        },
      }));
    }
  }

  return (
    <main
      className={`page ${
        activeTab === "review" && isPreviousExpanded
          ? "page-previous-expanded"
          : ""
      }`}
    >
      <section className="review-shell" aria-label="Flashcard review">
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
            <div className="reader-tabs" role="tablist" aria-label="Review views">
              <Link
                className={`reader-tab ${
                  activeTab === "review" ? "reader-tab-active" : ""
                }`}
                href="/review"
                role="tab"
                id="review-tab"
                aria-selected={activeTab === "review"}
                aria-controls="review-panel"
                onClick={(event) => navigateToTab("review", event)}
              >
                Review
              </Link>
              <Link
                className={`reader-tab ${
                  activeTab === "queue" ? "reader-tab-active" : ""
                }`}
                href="/queue"
                role="tab"
                id="queue-tab"
                aria-selected={activeTab === "queue"}
                aria-controls="queue-panel"
                onClick={(event) => navigateToTab("queue", event)}
              >
                Decks
              </Link>
              {canViewAdmin ? (
                <Link
                  className="reader-tab"
                  href="/admin"
                  role="tab"
                  aria-selected="false"
                >
                  Admin
                </Link>
              ) : null}
            </div>
          </div>

          <div className="reader-actions">
            <span className="queue-summary">
              {queueRemaining} due
            </span>
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
                  <UserIcon />
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
                        <UserIcon />
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
                      setAvatarMessage(null);
                      setIsUserMenuOpen(false);
                      setIsSettingsOpen(true);
                    }}
                  >
                    <SettingsIcon />
                    <span>Settings</span>
                  </button>
                  <button
                    className="user-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      clerk.openUserProfile();
                    }}
                  >
                    <ManageAccountIcon />
                    <span>Manage account</span>
                  </button>
                  <button
                    className="user-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      void clerk.signOut({ redirectUrl: "/" });
                    }}
                  >
                    <SignOutIcon />
                    <span>Sign out</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <div
          className={`review-stage ${
            !isLoadingQuestion && !question ? "review-stage-resting" : ""
          }`}
          hidden={activeTab !== "review"}
          id="review-panel"
          role="tabpanel"
          aria-labelledby="review-tab"
        >
          <section className="question-area" aria-live="polite">
            <div
              key={isLoadingQuestion ? "loading" : question ?? "empty"}
              className={`question-copy ${
                !isLoadingQuestion && question ? "question-copy-enter" : ""
              }`}
            >
              {isLoadingQuestion ? (
                <h2 className="question-title">Loading next question...</h2>
              ) : question ? (
                <MarkdownInline
                  as="h2"
                  className="question-title"
                  text={question}
                />
              ) : (
                <div className="resting-state">
                  <p className="resting-kicker">Review complete</p>
                  <h2 className="resting-title">You&apos;re caught up.</h2>
                  <p className="resting-copy">
                    No questions are due right now.
                  </p>

                  <dl className="resting-metrics" aria-label="Review status">
                    <div>
                      <dt>{queueRemaining}</dt>
                      <dd>due now</dd>
                    </div>
                    <div>
                      <dt>{scheduledReviewCount}</dt>
                      <dd>scheduled</dd>
                    </div>
                    <div>
                      <dt>
                        {nextScheduledReview
                          ? formatDurationBadge(nextScheduledReview.msUntilDue)
                          : "none"}
                      </dt>
                      <dd>next due</dd>
                    </div>
                  </dl>

                  <div className="resting-actions">
                    <button
                      className="resting-primary"
                      type="button"
                      onClick={openQueue}
                    >
                      View queue
                    </button>
                    <button
                      className="resting-secondary"
                      type="button"
                      onClick={() => void loadNextQuestion({ surfaceError: false })}
                    >
                      Refresh
                    </button>
                  </div>

                  {error ? (
                    <p className="resting-error">
                      Could not refresh the next question.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </section>

          {isLoadingQuestion ? (
            <div className="composer composer-loading" aria-hidden="true">
              <div className="composer-row composer-loading-row">
                <div className="composer-loading-input" />
                <div className="composer-loading-button" />
                <div className="composer-loading-button composer-loading-button-accent" />
              </div>
            </div>
          ) : question ? (
            <form className="composer" onSubmit={handleSubmit}>
              <div className="composer-row">
                <textarea
                  id="answer-input"
                  className="composer-input"
                  value={displayedAnswer}
                  onChange={(event) => {
                    clearPendingSpeechCommand();
                    setSpeechPreview("");
                    setAnswer(event.target.value);
                    answerRef.current = event.target.value;
                  }}
                  onKeyDown={handleAnswerKeyDown}
                  placeholder="Your answer"
                  aria-label="Your answer"
                  rows={4}
                  autoFocus
                  disabled={isSubmitting}
                />
                <button
                  className={`composer-mic ${
                    isSpeechActive ? "composer-mic-active" : ""
                  }`}
                  type="button"
                  aria-label={
                    isSpeechActive ? "Stop voice answer" : "Start voice answer"
                  }
                  aria-pressed={isSpeechActive}
                  onClick={isSpeechActive ? stopSpeech : startSpeech}
                  disabled={isSubmitting}
                  title={
                    isSpeechActive ? "Stop voice answer" : "Start voice answer"
                  }
                >
                  {isSpeechActive ? <StopIcon /> : <MicrophoneIcon />}
                </button>
                <button
                  className="composer-submit"
                  type="submit"
                  disabled={isSubmitting}
                  aria-label="Submit answer"
                >
                  <SubmitIcon />
                </button>
              </div>
              {speechMessage ? (
                <p
                  className={`speech-status speech-status-${speechStatus}`}
                  aria-live="polite"
                >
                  {speechMessage}
                </p>
              ) : null}
            </form>
          ) : null}

          {error && question ? <p className="error-message">{error}</p> : null}

          <section
            className={`previous-panel ${
              isPreviousExpanded ? "previous-panel-expanded" : ""
            }`}
            aria-label="Previous answers"
          >
            <div className="previous-header">
              <h2>Previous answers</h2>
            </div>

            <ol className="previous-list">
              {visiblePreviousAnswers.map((item, index) => {
                const isPending = item.status === "grading";
                const isDetailsExpanded = expandedPreviousAnswerIds.has(item.id);
                const detailId = `previous-answer-details-${index}-${item.id.replace(
                  /[^A-Za-z0-9_-]/g,
                  "-",
                )}`;

                return (
                  <li
                    className={`previous-row ${
                      isPending
                        ? "previous-row-pending"
                        : "previous-row-resolved"
                    } ${
                      isDetailsExpanded
                        ? "previous-row-open"
                        : "previous-row-collapsed"
                    }`}
                    key={item.id}
                  >
                    <div className="previous-score-slot">
                      {isPending ? (
                        <span className="pending-spinner" aria-hidden="true" />
                      ) : (
                        <PreviousAnswerScore score={item.score} />
                      )}
                    </div>

                    <button
                      className="previous-row-main-button"
                      type="button"
                      onClick={() => togglePreviousAnswerDetails(item.id)}
                      aria-expanded={isDetailsExpanded}
                      aria-controls={detailId}
                    >
                      <div className="previous-copy">
                        <div className="previous-field previous-question-field">
                          <span className="previous-field-label">Question</span>
                          <MarkdownInline
                            as="p"
                            className="previous-question"
                            text={item.question}
                          />
                        </div>

                        <div
                          className="previous-detail-grid"
                          hidden={!isDetailsExpanded}
                          id={detailId}
                        >
                          <div className="previous-field">
                            <span className="previous-field-label">Answer</span>
                            {item.answer ? (
                              <MarkdownInline
                                as="p"
                                className="previous-answer"
                                text={item.answer}
                              />
                            ) : (
                              <p className="previous-answer previous-answer-empty">
                                No answer text recorded.
                              </p>
                            )}
                          </div>

                          <div className="previous-field">
                            <span className="previous-field-label">
                              Evaluation
                            </span>
                            {isPending ? (
                              <p className="previous-summary">
                                Evaluating in background...
                              </p>
                            ) : (
                              <MarkdownContent
                                className="previous-summary"
                                text={
                                  item.justification ?? "No feedback returned."
                                }
                              />
                            )}
                          </div>
                        </div>
                      </div>

                      <span className="previous-row-meta">
                        <time
                          className="previous-time"
                          dateTime={
                            item.timestamp
                              ? new Date(item.timestamp).toISOString()
                              : undefined
                          }
                        >
                          {item.timeLabel}
                        </time>
                        <ChevronDown
                          className="previous-collapse-icon"
                          aria-hidden="true"
                        />
                      </span>
                    </button>

                    {isDetailsExpanded ? (
                      <button
                        className="previous-details-link"
                        type="button"
                        onClick={() => setSelectedQuestion(item.question)}
                      >
                        More details
                      </button>
                    ) : null}
                  </li>
                );
              })}

              {!hasPreviousAnswers && isReviewResting ? (
                <li className="previous-row previous-row-empty">
                  <p>No previous answers yet.</p>
                </li>
              ) : null}

              {Array.from({ length: previousAnswerPlaceholderCount }).map(
                (_, index) => (
                  <li
                    className="previous-row previous-row-placeholder"
                    key={`previous-placeholder-${index}`}
                    aria-hidden="true"
                  >
                    <div className="previous-placeholder-score" />
                    <div className="previous-placeholder-copy">
                      <span />
                      <span />
                    </div>
                  </li>
                ),
              )}
            </ol>
            {hasHiddenPreviousAnswers ? (
              <button
                className="load-more-answers"
                type="button"
                onClick={() => setIsPreviousExpanded(true)}
              >
                Load more
              </button>
            ) : null}
          </section>
        </div>

        <section
          className="queue-stage deck-stage"
          ref={queueStageRef}
          hidden={activeTab !== "queue"}
          id="queue-panel"
          role="tabpanel"
          aria-labelledby="queue-tab"
        >
          <div className="queue-toolbar deck-toolbar">
            <button
              className="queue-generate-trigger"
              type="button"
              onClick={createDeck}
            >
              <Plus aria-hidden="true" />
              <span>Create deck</span>
            </button>
            <label className="deck-search-label">
              <span className="sr-only">Search decks</span>
              <span className="deck-search-shell">
                <Search aria-hidden="true" />
                <input
                  className="deck-search-input"
                  type="search"
                  value={deckSearchQuery}
                  onChange={(event) => setDeckSearchQuery(event.target.value)}
                  placeholder="Search decks"
                />
              </span>
            </label>
            <label className="queue-sort-label">
              Sort by
              <span className="queue-sort-select-shell">
                <select
                  className="queue-sort-select"
                  value={deckSortKey}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    setDeckSortKey(event.target.value as DeckSortKey)
                  }
                  aria-label="Sort decks"
                >
                  <option value="updated">Updated</option>
                  <option value="due">Due count</option>
                  <option value="name">Name</option>
                </select>
                <ChevronDown aria-hidden="true" />
              </span>
            </label>
          </div>

          {decks.length === 0 ? (
            <p className="queue-empty">No decks yet.</p>
          ) : (
            <ol className="queue-list deck-list" ref={queueListRef}>
              {visibleDecks.map((deck) => {
                const isSelected = selectedDeck?.id === deck.id;

                return (
                <li
                  className="queue-row deck-row"
                  key={deck.id}
                >
                  <div
                    className={`queue-row-card deck-row-card ${
                      isSelected ? "deck-row-card-selected" : ""
                    }`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${deck.name}`}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedDeckId(deck.id)}
                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedDeckId(deck.id);
                      }
                    }}
                  >
                    <div className="deck-row-main">
                      <div className="deck-row-copy">
                        <p className="queue-question deck-name">{deck.name}</p>
                        {deck.description ? (
                          <p className="queue-origin deck-description">
                            {deck.description}
                          </p>
                        ) : null}
                      </div>
                      <div className="deck-row-meta" aria-label="Deck details">
                        <span
                          className={`due-badge ${
                            deck.dueCount > 0 ? "now" : "scheduled"
                          }`}
                        >
                          {deck.dueCount} due
                        </span>
                        <span>{deck.cardCount} cards</span>
                        <span>{deck.lastReviewedLabel}</span>
                      </div>
                    </div>
                    <div className="deck-row-actions">
                      <button
                        className={`deck-rotation-toggle ${
                          deck.inRotation ? "deck-rotation-toggle-on" : ""
                        }`}
                        type="button"
                        aria-label={
                          deck.inRotation
                            ? `Remove ${deck.name} from review rotation`
                            : `Add ${deck.name} to review rotation`
                        }
                        aria-pressed={deck.inRotation}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleDeckRotation(deck.id);
                        }}
                      >
                        <span />
                      </button>
                      <button
                        className="deck-icon-button"
                        type="button"
                        aria-label={`Edit ${deck.name}`}
                        title="Edit"
                        onClick={(event) => {
                          event.stopPropagation();
                          openDeckEditor(deck);
                        }}
                      >
                        <PencilLine aria-hidden="true" />
                      </button>
                      <button
                        className="deck-icon-button"
                        type="button"
                        aria-label={`Duplicate ${deck.name}`}
                        title="Duplicate"
                        onClick={(event) => {
                          event.stopPropagation();
                          duplicateDeck(deck);
                        }}
                      >
                        <Copy aria-hidden="true" />
                      </button>
                      <button
                        className="deck-icon-button deck-icon-button-danger"
                        type="button"
                        aria-label={`Delete ${deck.name}`}
                        title="Delete"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteDeck(deck.id);
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </li>
                );
              })}
            </ol>
          )}

          <div className="deck-summary-strip" aria-label="Deck summary">
            <span>{decks.length} decks</span>
            <span>{rotationDeckCount} in rotation</span>
            <span>{rotationDueCount} due in rotation</span>
            <span>{totalCardCount} cards</span>
          </div>
        </section>
      </section>

      {editingDeck ? (
        <div
          className="deck-editor-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setEditingDeckId(null);
            }
          }}
        >
          <section
            className="deck-editor-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deck-editor-title"
          >
            <div className="deck-editor-header">
              <div>
                <p className="previous-field-label">Deck</p>
                <h2 id="deck-editor-title">{editingDeck.name}</h2>
              </div>
              <button
                className="user-menu-trigger"
                type="button"
                aria-label="Close deck editor"
                onClick={() => setEditingDeckId(null)}
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="deck-editor-grid">
              <label className="settings-field">
                <span>Name</span>
                <input
                  className="settings-input"
                  value={deckDraftName}
                  onChange={(event) => setDeckDraftName(event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Description</span>
                <input
                  className="settings-input"
                  value={deckDraftDescription}
                  onChange={(event) =>
                    setDeckDraftDescription(event.target.value)
                  }
                />
              </label>
            </div>

            <div className="deck-editor-stats" aria-label="Deck question summary">
              <div>
                <dt>{editingDeck.cardCount}</dt>
                <dd>questions</dd>
              </div>
              <div>
                <dt>{editingDeck.dueCount}</dt>
                <dd>due</dd>
              </div>
              <div>
                <dt>{editingDeck.inRotation ? "on" : "off"}</dt>
                <dd>rotation</dd>
              </div>
            </div>

            <div className="deck-editor-actions">
              <button
                className="resting-secondary"
                type="button"
                onClick={() => setEditingDeckId(null)}
              >
                Cancel
              </button>
              <button
                className="resting-primary"
                type="button"
                onClick={saveDeckDraft}
              >
                Save
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isQuestionGeneratorOpen ? (
        <div
          className="generator-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isGeneratingQuestions) {
              closeQuestionGenerator();
            }
          }}
        >
          <section
            className="generator-modal"
            role="dialog"
            aria-modal="true"
            aria-busy={isGeneratingQuestions}
            aria-labelledby="generator-modal-title"
          >
            {isGeneratingQuestions ? (
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
                  {isGeneratorReviewStep ? "Step 2 of 2" : "Step 1 of 2"}
                </p>
                <h2 className="generator-modal-title" id="generator-modal-title">
                  {isGeneratorReviewStep ? "Review questions" : "Generate questions"}
                </h2>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close generator"
                disabled={isGeneratingQuestions}
                onClick={closeQuestionGenerator}
              />
            </div>

            <div
              className={`generator-modal-grid ${
                isGeneratorReviewStep
                  ? "generator-modal-grid-review"
                  : "generator-modal-grid-scope"
              }`}
            >
              {!isGeneratorReviewStep ? (
                <section className="generator-scope-panel" aria-label="Generation scope">
                  <div className="generator-field">
                    <label htmlFor="generator-scope-input">Cover</label>
                    <div
                      className="generator-scope-shell"
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = isGeneratingQuestions
                          ? "none"
                          : "copy";
                      }}
                      onDrop={(event) => void handleGeneratorFileDrop(event)}
                    >
                      <textarea
                        id="generator-scope-input"
                        className="generator-scope-input"
                        value={generatorScope}
                        disabled={isGeneratingQuestions}
                        onChange={(event) => {
                          setGeneratorScope(event.target.value);
                          setGeneratorMessage(null);
                        }}
                        placeholder="Core ideas from the attached lecture notes"
                        rows={7}
                      />
                      <p className="generator-drop-hint">
                        Drop files here to add them as context.
                      </p>
                      {generatorFiles.length > 0 ? (
                        <ul className="generator-file-list" aria-label="Context files">
                          {generatorFiles.map((file) => (
                            <li className="generator-file-chip" key={file.id}>
                              <FileText aria-hidden="true" />
                              <span>{file.name}</span>
                              {file.status === "metadata-only" ? (
                                <em>name only</em>
                              ) : null}
                              <button
                                type="button"
                                aria-label={`Remove ${file.name}`}
                                disabled={isGeneratingQuestions}
                                onClick={() => removeGeneratorFile(file.id)}
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
                        <output>{generatorQuestionCount}</output>
                      </span>
                      <input
                        className="generator-count-slider"
                        type="range"
                        min={1}
                        max={MAX_GENERATED_QUESTION_COUNT}
                        step={1}
                        value={generatorQuestionCount}
                        disabled={isGeneratingQuestions}
                        onChange={(event) =>
                          setGeneratorQuestionCount(
                            Number.parseInt(event.target.value, 10),
                          )
                        }
                      />
                      <span className="generator-slider-scale" aria-hidden="true">
                        <span>1</span>
                        <span>{MAX_GENERATED_QUESTION_COUNT}</span>
                      </span>
                    </label>
                  </div>

                  <div className="generator-scope-footer">
                    <p aria-live="polite">{generatorMessage}</p>
                    <button
                      className="generator-primary-action"
                      type="button"
                      onClick={() => void generateQuestionBatch()}
                      disabled={!hasGeneratorContext || isGeneratingQuestions}
                    >
                      <Sparkles aria-hidden="true" />
                      <span>{isGeneratingQuestions ? "Generating..." : "Generate"}</span>
                    </button>
                  </div>
                </section>
              ) : (
                <section className="generator-review-panel" aria-label="Generated questions">
                <div className="generator-review-header">
                  <div>
                    <h3>Generated</h3>
                    <p>
                      {generatedQuestionCounts.new} available ·{" "}
                      {generatedQuestionCounts.selected} selected
                    </p>
                  </div>
                  {generatedQuestionCounts.adding > 0 ? (
                    <span>{generatedQuestionCounts.adding} adding</span>
                  ) : null}
                </div>

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
                        onClick={() => toggleGeneratedQuestionSelection(item.id)}
                      >
                        {item.status === "selected" ? (
                          <Check aria-hidden="true" />
                        ) : (
                          <Plus aria-hidden="true" />
                        )}
                      </button>
                      <div className="generator-question-copy">
                        <MarkdownInline
                          as="p"
                          className="generator-question-text"
                          text={item.question}
                        />
                      </div>
                    </li>
                  ))}
                </ol>

                <div className="generator-review-footer">
                  <p aria-live="polite">
                    {generatorMessage ??
                      (generatedQuestionCounts.selected > 0
                        ? `${generatedQuestionCounts.selected} selected for add.`
                        : generatedQuestionCounts.new > 0
                          ? "Click + on any question to select it."
                          : "Add selected questions to the deck.")}
                  </p>
                  <div className="generator-review-actions">
                    <button
                      className="generator-primary-action"
                      type="button"
                      onClick={() => void addSelectedGeneratedQuestionsToDeck()}
                      disabled={
                        generatedQuestionCounts.selected === 0 ||
                        generatedQuestionCounts.adding > 0
                      }
                    >
                      {generatedQuestionCounts.adding > 0 ? "Adding..." : "Add to Deck"}
                    </button>
                  </div>
                </div>
              </section>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {isSettingsOpen ? (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsSettingsOpen(false);
            }
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-title"
          >
            <div className="settings-modal-header">
              <div>
                <p className="settings-modal-kicker">User settings</p>
                <h2 className="settings-modal-title" id="settings-modal-title">
                  Profile
                </h2>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close settings"
                onClick={() => setIsSettingsOpen(false)}
              />
            </div>

            <div className="settings-profile">
              <div className="settings-avatar-preview" aria-hidden="true">
                {menuAvatarUrl ? (
                  <span
                    className="settings-avatar-image"
                    style={{ backgroundImage: `url("${menuAvatarUrl}")` }}
                  />
                ) : (
                  <UserIcon />
                )}
              </div>

              <div className="settings-profile-copy">
                <dl className="settings-profile-details">
                  <div>
                    <dt>Name</dt>
                    <dd>{currentUser?.displayName ?? "Loading..."}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>{currentUser?.email ?? "Loading..."}</dd>
                  </div>
                </dl>

                <div className="settings-avatar-actions">
                  <input
                    ref={avatarInputRef}
                    className="settings-avatar-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={(event) => void handleAvatarFileChange(event)}
                  />
                  <button
                    className="settings-action-primary"
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={isAvatarUpdating}
                  >
                    <UploadIcon />
                    <span>
                      {isAvatarUpdating ? "Uploading..." : "Upload avatar"}
                    </span>
                  </button>
                  <button
                    className="settings-action-secondary"
                    type="button"
                    onClick={() => void saveAvatar(null)}
                    disabled={isAvatarUpdating || !currentUser?.avatarUrl}
                  >
                    <RemoveIcon />
                    <span>Remove</span>
                  </button>
                </div>

                {avatarMessage ? (
                  <p className="settings-status" aria-live="polite">
                    {avatarMessage}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {selectedQuestionStats ? (
        <div
          className="stats-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedQuestion(null);
            }
          }}
        >
          <section
            className="stats-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stats-modal-title"
          >
            <div className="stats-modal-header">
              <div>
                <p className="stats-modal-kicker">Question stats</p>
                <MarkdownInline
                  as="h2"
                  className="stats-modal-title"
                  text={selectedQuestionStats.question}
                />
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close stats"
                onClick={() => setSelectedQuestion(null)}
              />
            </div>

            <div className="stats-grid" aria-label="Question summary metrics">
              <div className="stats-tile">
                <span>Attempts</span>
                <strong>{selectedQuestionStats.attempts}</strong>
              </div>
              <div className="stats-tile">
                <span>Average</span>
                <strong>{formatAverageScore(selectedQuestionStats.averageScore)}</strong>
              </div>
              <div className="stats-tile">
                <span>Best</span>
                <strong>{formatScore(selectedQuestionStats.bestScore)}</strong>
              </div>
              <div className="stats-tile">
                <span>Last</span>
                <strong>{formatScore(selectedQuestionStats.lastScore)}</strong>
              </div>
              <div className="stats-tile">
                <span>Next due</span>
                <strong>{formatNextDue(selectedQuestionStats)}</strong>
              </div>
              <div className="stats-tile">
                <span>Pending</span>
                <strong>{selectedQuestionStats.pendingCount}</strong>
              </div>
            </div>

            <div className="stats-chart-panel">
              <div className="stats-section-heading">
                <h3>Previous scores</h3>
                <span>
                  Last reviewed {formatReviewDate(selectedQuestionStats.lastReviewedAt)}
                </span>
              </div>
              <ScoreChart entries={selectedQuestionStats.reviewHistory} />
            </div>

            <div className="stats-history-panel">
              <div className="stats-section-heading">
                <h3>Answer history</h3>
                <span>{selectedQuestionStats.dueStatus}</span>
              </div>
              {selectedQuestionStats.answerHistory.length === 0 ? (
                <p className="stats-empty">No answers recorded yet.</p>
              ) : (
                <ol className="stats-history-list">
                  {selectedQuestionStats.answerHistory.map((entry) => {
                    const isPending = entry.status === "grading";

                    return (
                      <li
                        className={`stats-history-row ${
                          isPending
                            ? "stats-history-row-pending"
                            : "stats-history-row-resolved"
                        }`}
                        key={entry.id}
                      >
                        <div className="stats-history-score-slot">
                          {isPending ? (
                            <span className="pending-spinner" aria-hidden="true" />
                          ) : (
                            <PreviousAnswerScore score={entry.score} />
                          )}
                        </div>

                        <div className="stats-history-copy">
                          <div className="previous-field stats-history-answer-field">
                            <span className="previous-field-label">Answer</span>
                            <p className="stats-history-answer">
                              {entry.rawAnswer}
                            </p>
                          </div>

                          {entry.answerSummary &&
                          entry.answerSummary !== entry.rawAnswer ? (
                            <div className="previous-field">
                              <span className="previous-field-label">
                                Summary
                              </span>
                              <p className="stats-history-summary">
                                {entry.answerSummary}
                              </p>
                            </div>
                          ) : null}
                          <div className="previous-field">
                            <span className="previous-field-label">
                              Evaluation
                            </span>
                            {entry.justification ? (
                              <p className="stats-history-summary">
                                {entry.justification}
                              </p>
                            ) : (
                              <p className="stats-history-summary stats-history-summary-muted">
                                {isPending
                                  ? "Evaluating in background..."
                                  : "No feedback returned."}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="stats-history-row-meta">
                          <time
                            className="previous-time"
                            dateTime={new Date(
                              entry.resolvedAt ?? entry.submittedAt,
                            ).toISOString()}
                          >
                            {formatReviewDate(
                              entry.resolvedAt ?? entry.submittedAt,
                            )}
                          </time>
                          <span className="stats-history-status">
                            {isPending ? "Grading" : "Resolved"}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {selectedQuestionStats.lastJustification ? (
                <div className="stats-feedback">
                  <span>Latest feedback</span>
                  <MarkdownContent
                    className="stats-feedback-copy"
                    text={selectedQuestionStats.lastJustification}
                  />
                </div>
              ) : null}
              {selectedQuestionStats.generatedFromQuestion ? (
                <div className="stats-feedback">
                  <span>Generated from</span>
                  <MarkdownContent
                    className="stats-feedback-copy"
                    text={selectedQuestionStats.generatedFromQuestion}
                  />
                </div>
              ) : null}
              <div className="stats-feedback">
                <div className="stats-reference-header">
                  <span>LLM answer</span>
                  {!selectedReferenceAnswer ? (
                    <button
                      className="stats-generate-answer"
                      type="button"
                      onClick={() =>
                        void generateReferenceAnswer(selectedQuestionStats.question)
                      }
                      disabled={isGeneratingReferenceAnswer}
                    >
                      {isGeneratingReferenceAnswer
                        ? "Generating..."
                        : "Generate answer"}
                    </button>
                  ) : null}
                </div>
                {selectedReferenceAnswer ? (
                  <MarkdownContent
                    className="stats-feedback-copy"
                    text={selectedReferenceAnswer}
                  />
                ) : referenceAnswerError ? (
                  <p className="stats-reference-empty">{referenceAnswerError}</p>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

    </main>
  );
}
