"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isAdminEmail } from "@/app/lib/adminAccess";
import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  LogOut,
  Mic,
  Plus,
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
  type CSSProperties,
  KeyboardEvent,
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

type SubmitAnswerResponse = {
  ok: boolean;
  evaluationId: string;
};

type QueueStatusResponse = {
  queueRemaining: number;
  pendingEvaluations: number;
  evaluations: EvaluationQueueItem[];
  reviewQueue: ReviewQueueItem[];
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

type HoveredEmbeddingPoint = DeckEmbeddingPlotPoint & {
  arrowLeftPx: number;
  tooltipLeftPx: number;
  tooltipTopPx: number;
  verticalPlacement: "above" | "below";
  statusLabel: string;
  scoreLabel: string | null;
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

type QueueSortKey = "review-date" | "creation-date";

type GeneratedQuestionStatus = "new" | "selected" | "adding" | "added";

type GeneratedQuestionCandidate = {
  id: string;
  question: string;
  conciseAnswer: string;
  sourceLabel: string;
  coverageLabel: string;
  batch: number;
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
        sourceLabel?: string;
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
const SPEECH_COMMAND_SETTLE_MS = 1000;
const MAX_AVATAR_UPLOAD_BYTES = 512 * 1024;
const TERMINAL_SPEECH_COMMAND = /(?:^|\s)(submit|skip)[.!?]*$/i;
const MAX_GENERATED_QUESTION_COUNT = 40;

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

function formatDueBadge(item: ReviewQueueItem): string {
  return formatDurationBadge(item.msUntilDue);
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
  return score === null ? "None" : `${score}/10`;
}

function formatAverageScore(score: number | null): string {
  return score === null ? "None" : `${score.toFixed(1)}/10`;
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

function DeckEmbeddingPlot({
  plot,
  reviewQueue,
}: {
  plot: DeckEmbeddingPlotResponse;
  reviewQueue: ReviewQueueItem[];
}) {
  const [hoveredPoint, setHoveredPoint] =
    useState<HoveredEmbeddingPoint | null>(null);
  const plotCanvasRef = useRef<HTMLDivElement | null>(null);
  const width = 720;
  const height = 270;
  const padding = 26;
  const statusByQuestion = useMemo(
    () => new Map(reviewQueue.map((item) => [item.question, item])),
    [reviewQueue],
  );

  function getPointMetadata(
    point: DeckEmbeddingPlotPoint,
  ): Pick<HoveredEmbeddingPoint, "statusLabel" | "scoreLabel"> {
    const queueItem = statusByQuestion.get(point.question);

    return {
      statusLabel: queueItem
        ? queueItem.status === "now"
          ? "Due now"
          : `Due in ${formatDueBadge(queueItem)}`
        : "Not scheduled",
      scoreLabel:
        queueItem?.lastScore === null || queueItem?.lastScore === undefined
          ? null
          : `Last score ${queueItem.lastScore}/10`,
    };
  }

  function showPoint(point: DeckEmbeddingPlotPoint) {
    const x = padding + point.x * (width - padding * 2);
    const y = padding + (1 - point.y) * (height - padding * 2);
    const canvasRect = plotCanvasRef.current?.getBoundingClientRect();
    const canvasWidth = canvasRect?.width ?? width;
    const canvasHeight = canvasRect?.height ?? height;
    const renderedX = (x / width) * canvasWidth;
    const renderedY = (y / height) * canvasHeight;
    const isCompact = canvasWidth < 520;
    const horizontalInset = isCompact ? 10 : 14;
    const arrowInset = 14;
    const tooltipWidth = Math.min(
      isCompact ? 280 : 340,
      canvasWidth - (isCompact ? 20 : 28),
    );
    const minTooltipLeft = horizontalInset;
    const maxTooltipLeft = Math.max(
      minTooltipLeft,
      canvasWidth - tooltipWidth - horizontalInset,
    );
    const tooltipLeft = Math.min(
      Math.max(renderedX - tooltipWidth / 2, minTooltipLeft),
      maxTooltipLeft,
    );
    const metadata = getPointMetadata(point);

    setHoveredPoint({
      ...point,
      ...metadata,
      arrowLeftPx: Math.min(
        Math.max(renderedX - tooltipLeft, arrowInset),
        tooltipWidth - arrowInset,
      ),
      tooltipLeftPx: tooltipLeft,
      tooltipTopPx: renderedY,
      verticalPlacement: y / height < 0.32 ? "below" : "above",
    });
  }

  return (
    <section className="embedding-plot-panel" aria-label="Deck embedding map">
      <div className="embedding-plot-header">
        <div>
          <h2>Embedding map</h2>
          <p>
            {plot.embeddedQuestions}/{plot.totalQuestions} cards
            {plot.model ? ` · ${plot.model}` : ""}
          </p>
        </div>
      </div>

      {plot.points.length === 0 ? (
        <div className="embedding-plot-empty">
          Embeddings will appear here after backfill.
        </div>
      ) : (
        <div
          className="embedding-plot-canvas"
          ref={plotCanvasRef}
          onMouseLeave={() => setHoveredPoint(null)}
        >
          <svg
            className="embedding-plot"
            role="img"
            aria-label="Deck questions plotted by embedding similarity"
            viewBox={`0 0 ${width} ${height}`}
          >
            <line
              className="embedding-plot-grid"
              x1={padding}
              x2={width - padding}
              y1={height / 2}
              y2={height / 2}
            />
            <line
              className="embedding-plot-grid"
              x1={width / 2}
              x2={width / 2}
              y1={padding}
              y2={height - padding}
            />
            <rect
              className="embedding-plot-frame"
              x={padding}
              y={padding}
              width={width - padding * 2}
              height={height - padding * 2}
              rx="10"
            />
            {plot.points.map((point) => {
              const queueItem = statusByQuestion.get(point.question);
              const tone =
                point.lastScore === null
                  ? "unanswered"
                  : queueItem?.status === "now"
                    ? "now"
                    : "scheduled";
              const x = padding + point.x * (width - padding * 2);
              const y = padding + (1 - point.y) * (height - padding * 2);

              return (
                <g
                  className={`embedding-plot-point point-${tone}`}
                  key={point.question}
                  onFocus={() => showPoint(point)}
                  onBlur={() => setHoveredPoint(null)}
                  onMouseEnter={() => showPoint(point)}
                >
                  <circle cx={x} cy={y} r="7" />
                  <circle
                    className="embedding-plot-hit-area"
                    cx={x}
                    cy={y}
                    r="15"
                  />
                </g>
              );
            })}
          </svg>

          {hoveredPoint ? (
            <div
              className={`embedding-tooltip tooltip-y-${hoveredPoint.verticalPlacement}`}
              style={
                {
                  "--tooltip-arrow-left": `${hoveredPoint.arrowLeftPx}px`,
                  left: `${hoveredPoint.tooltipLeftPx}px`,
                  top: `${hoveredPoint.tooltipTopPx}px`,
                } as CSSProperties
              }
              role="status"
            >
              <MarkdownInline
                as="p"
                className="embedding-tooltip-question"
                text={hoveredPoint.question}
              />
              <span>
                {hoveredPoint.statusLabel}
                {hoveredPoint.scoreLabel ? ` · ${hoveredPoint.scoreLabel}` : ""}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function SubmitIcon() {
  return <ArrowUp aria-hidden="true" />;
}

export default function ReviewApp({
  initialActiveTab = "review",
}: ReviewAppProps) {
  const router = useRouter();
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [speechPreview, setSpeechPreview] = useState("");
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle");
  const [speechMessage, setSpeechMessage] = useState<string | null>(null);
  const [queueRemaining, setQueueRemaining] = useState(0);
  const [evaluations, setEvaluations] = useState<EvaluationQueueItem[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [queueSortKey, setQueueSortKey] =
    useState<QueueSortKey>("review-date");
  const [deckEmbeddingPlot, setDeckEmbeddingPlot] =
    useState<DeckEmbeddingPlotResponse>({
      model: null,
      totalQuestions: 0,
      embeddedQuestions: 0,
      points: [],
    });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialActiveTab);
  const [referenceAnswers, setReferenceAnswers] = useState<
    Record<string, ReferenceAnswerState>
  >({});
  const [isPreviousExpanded, setIsPreviousExpanded] = useState(false);
  const [expandedPreviousAnswerIds, setExpandedPreviousAnswerIds] = useState<
    Set<string>
  >(() => new Set());
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [isLoadingQuestion, setIsLoadingQuestion] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQuestionGeneratorOpen, setIsQuestionGeneratorOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserProfileResponse | null>(null);
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
  const [generatorScope, setGeneratorScope] = useState("");
  const [generatorQuestionCount, setGeneratorQuestionCount] = useState(12);
  const [generatorFiles, setGeneratorFiles] = useState<GeneratorContextFile[]>([]);
  const [generatedQuestions, setGeneratedQuestions] = useState<
    GeneratedQuestionCandidate[]
  >([]);
  const [generatorBatch, setGeneratorBatch] = useState(0);
  const [generatorMessage, setGeneratorMessage] = useState<string | null>(null);
  const [isGeneratingQuestions, setIsGeneratingQuestions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const answerRef = useRef(answer);
  const questionRef = useRef(question);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const isSubmittingRef = useRef(isSubmitting);
  const keepListeningRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const pendingSpeechCommandRef = useRef<PendingSpeechCommand | null>(null);
  const pendingSpeechCommandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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

  const openQueue = useCallback(() => {
    setActiveTab("queue");
    router.push("/queue");
  }, [router]);

  useEffect(() => {
    setActiveTab(initialActiveTab);
  }, [initialActiveTab]);

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
    const interval = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 60_000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
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
        setIsQuestionGeneratorOpen(false);
      }
    }

    window.addEventListener("keydown", closeGeneratorOnEscape);

    return () => window.removeEventListener("keydown", closeGeneratorOnEscape);
  }, [isQuestionGeneratorOpen]);

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

  const loadNextQuestion = useCallback(async (options?: {
    surfaceError?: boolean;
  }) => {
    const surfaceError = options?.surfaceError ?? true;

    setIsLoadingQuestion(true);
    setQuestion(null);
    questionRef.current = null;
    setError(null);

    try {
      const response = await fetch("/api/next-question", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Failed to load the next question.");
      }

      const data = (await response.json()) as NextQuestionResponse;
      setQuestion(data.question);
      questionRef.current = data.question;
      setQueueRemaining(data.queueRemaining);

      if (data.question) {
        appendQuestion(data.question);
      }
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
  }, [appendQuestion]);

  const applyQueueStatus = useCallback((data: QueueStatusResponse) => {
    setQueueRemaining(data.queueRemaining);
    setEvaluations(data.evaluations);
    setReviewQueue(data.reviewQueue);
    setDeckEmbeddingPlot(
      data.deckEmbeddingPlot ?? {
        model: null,
        totalQuestions: 0,
        embeddedQuestions: 0,
        points: [],
      },
    );
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/queue-status", {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as QueueStatusResponse;
      applyQueueStatus(data);
    } catch {
      // Status is informational; keep the review loop usable if polling fails.
    }
  }, [applyQueueStatus]);

  useEffect(() => {
    void loadNextQuestion({ surfaceError: false });
  }, [clearPendingSpeechCommand, loadNextQuestion]);

  useEffect(() => {
    void loadStatus();

    const events = new EventSource("/api/queue-status/stream");

    events.addEventListener("status", (event) => {
      try {
        applyQueueStatus(
          JSON.parse((event as MessageEvent<string>).data) as QueueStatusResponse,
        );
      } catch {
        // Ignore malformed stream events; the connection can continue.
      }
    });

    events.onerror = () => {
      events.close();
      void loadStatus();
    };

    return () => events.close();
  }, [applyQueueStatus, loadStatus]);

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

      await loadNextQuestion();
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
  }, [clearPendingSpeechCommand, loadNextQuestion]);

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

    const nextBatch = generatorBatch + 1;

    setIsGeneratingQuestions(true);
    setGeneratorMessage("Generating with OpenRouter...");

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
        sourceLabel: item.sourceLabel || "OpenRouter",
        coverageLabel: item.coverageLabel || item.question,
        batch: nextBatch,
        status: "new" as const,
      }));

      setGeneratorBatch(nextBatch);
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

  function clearGeneratedQuestionQueue() {
    if (isGeneratingQuestions || generatedQuestionCounts.adding > 0) {
      return;
    }

    setGeneratedQuestions([]);
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

  const sessionPreviousQuestions = new Set(
    sessionPreviousAnswers.map((previousItem) => previousItem.question),
  );

  const historicalPreviousAnswers: PreviousAnswerItem[] = reviewQueue
    .filter(
      (item) =>
        item.lastScore !== null &&
        item.lastAnswer !== null &&
        item.question !== question &&
        !sessionPreviousQuestions.has(item.question),
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
    ...historicalPreviousAnswers,
  ];
  const hasPreviousAnswers = previousAnswers.length > 0;
  const visiblePreviousAnswers = isPreviousExpanded
    ? previousAnswers
    : previousAnswers.slice(0, COLLAPSED_PREVIOUS_ANSWER_LIMIT);
  const hiddenPreviousAnswerCount =
    previousAnswers.length - visiblePreviousAnswers.length;
  const hasHiddenPreviousAnswers = hiddenPreviousAnswerCount > 0;
  const isReviewResting = !isLoadingQuestion && !question;
  const scheduledReviewCount = reviewQueue.filter(
    (item) => item.status === "scheduled",
  ).length;
  const nextScheduledReview = reviewQueue.find(
    (item) => item.status === "scheduled",
  );
  const sortedReviewQueue = useMemo(() => {
    return [...reviewQueue].sort((a, b) => {
      const dateComparison =
        queueSortKey === "review-date"
          ? a.nextDue - b.nextDue
          : b.createdAt - a.createdAt;

      return dateComparison || a.question.localeCompare(b.question);
    });
  }, [queueSortKey, reviewQueue]);
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
    const lastScore = scores.at(-1) ?? queueItem?.lastScore ?? null;
    const persistedAnswerHistory: AnswerHistoryEntry[] =
      queueItem?.attempts.map((attempt) => ({
        id: `attempt-${attempt.id}`,
        rawAnswer: attempt.rawAnswer || "(blank)",
        answerSummary: attempt.answerSummary || null,
        score: attempt.score,
        justification: attempt.justification || null,
        submittedAt: attempt.submittedAt,
        resolvedAt: attempt.resolvedAt,
        status: "resolved",
      })) ?? [];
    const sessionAnswerHistory: AnswerHistoryEntry[] = messages
      .filter(
        (message): message is Extract<ChatMessage, { kind: "answer" }> =>
          message.kind === "answer" && message.question === selectedQuestion,
      )
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
      nextDue: queueItem?.nextDue ?? null,
      msUntilDue: queueItem?.msUntilDue ?? null,
      dueStatus: queueItem?.status ?? "unknown",
      pendingCount,
      generatedFromQuestion: queueItem?.generatedFromQuestion ?? null,
      conciseAnswer: queueItem?.conciseAnswer ?? null,
      referenceAnswer: queueItem?.referenceAnswer ?? null,
      lastJustification:
        queueItem?.lastJustification ??
        latestResolvedEvaluation?.justification ??
        null,
    };
  }, [evaluations, messages, reviewQueue, selectedQuestion]);

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
            <p className="reader-brand">
              <Image
                className="reader-brand-mark"
                src="/brand/icon/header-mark.svg"
                alt=""
                aria-hidden="true"
                width={34}
                height={34}
              />
              <span>waxon</span>
            </p>
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
                onClick={() => setActiveTab("review")}
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
                onClick={() => setActiveTab("queue")}
              >
                Queue
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
                <span>{hiddenPreviousAnswerCount} more</span>
              </button>
            ) : null}
          </section>
        </div>

        <section
          className="queue-stage"
          hidden={activeTab !== "queue"}
          id="queue-panel"
          role="tabpanel"
          aria-labelledby="queue-tab"
        >
          <DeckEmbeddingPlot
            plot={deckEmbeddingPlot}
            reviewQueue={reviewQueue}
          />

          <div className="queue-toolbar">
            <button
              className="queue-generate-trigger"
              type="button"
              onClick={() => {
                setGeneratorMessage(null);
                setIsQuestionGeneratorOpen(true);
              }}
            >
              <Sparkles aria-hidden="true" />
              <span>Generate</span>
            </button>
            <label className="queue-sort-label">
              Sort by
              <span className="queue-sort-select-shell">
                <select
                  className="queue-sort-select"
                  value={queueSortKey}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    setQueueSortKey(event.target.value as QueueSortKey)
                  }
                  aria-label="Sort queue"
                >
                  <option value="review-date">Review date</option>
                  <option value="creation-date">Creation date</option>
                </select>
                <ChevronDown aria-hidden="true" />
              </span>
            </label>
          </div>

          {reviewQueue.length === 0 ? (
            <p className="queue-empty">No active cards.</p>
          ) : (
            <ol className="queue-list">
              {sortedReviewQueue.map((item) => (
                <li
                  className="queue-row"
                  key={`${item.question}-${item.nextDue}`}
                >
                  <div
                    className="queue-row-card"
                    role="button"
                    tabIndex={0}
                    aria-label={`Open card details for ${item.question}`}
                    onClick={() => setSelectedQuestion(item.question)}
                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedQuestion(item.question);
                      }
                    }}
                  >
                    <div className="queue-row-main">
                      <MarkdownInline
                        as="p"
                        className="queue-question"
                        text={item.question}
                      />
                      {item.generatedFromQuestion ? (
                        <MarkdownInline
                          as="p"
                          className="queue-origin"
                          text={`Generated from: ${item.generatedFromQuestion}`}
                        />
                      ) : null}
                      <div className="queue-metrics" aria-label="Card metrics">
                        <PreviousAnswerScore
                          className="queue-last-score"
                          label={
                            item.lastScore === null
                              ? "No previous score"
                              : `Last score ${item.lastScore} out of 10`
                          }
                          score={item.lastScore}
                        />
                        <span
                          className={`due-badge ${
                            item.status === "now" ? "now" : "scheduled"
                          }`}
                        >
                          {formatDueBadge(item)}
                        </span>
                      </div>
                    </div>
                    {item.lastJustification ? (
                      <p className="queue-justification">
                        {item.lastJustification}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </section>

      {isQuestionGeneratorOpen ? (
        <div
          className="generator-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsQuestionGeneratorOpen(false);
            }
          }}
        >
          <section
            className="generator-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="generator-modal-title"
          >
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
                onClick={() => setIsQuestionGeneratorOpen(false)}
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
                        event.dataTransfer.dropEffect = "copy";
                      }}
                      onDrop={(event) => void handleGeneratorFileDrop(event)}
                    >
                      <textarea
                        id="generator-scope-input"
                        className="generator-scope-input"
                        value={generatorScope}
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
                    <h3>Review</h3>
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
                        <p className="generator-question-meta">
                          Batch {item.batch} · {item.sourceLabel} ·{" "}
                          {item.status === "new"
                            ? "Not selected"
                            : item.status === "selected"
                              ? "Selected"
                              : "Adding"}
                        </p>
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
                          : "Add selected questions or discard the queue.")}
                  </p>
                  <div className="generator-review-actions">
                    <button
                      className="generator-secondary-action"
                      type="button"
                      onClick={clearGeneratedQuestionQueue}
                      disabled={generatedQuestionCounts.adding > 0}
                    >
                      <Trash2 aria-hidden="true" />
                      <span>Discard</span>
                    </button>
                    <button
                      className="generator-primary-action"
                      type="button"
                      onClick={() => void addSelectedGeneratedQuestionsToDeck()}
                      disabled={
                        generatedQuestionCounts.selected === 0 ||
                        generatedQuestionCounts.adding > 0
                      }
                    >
                      {generatedQuestionCounts.adding > 0 ? "Adding..." : "Add"}
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
