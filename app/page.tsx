"use client";

import {
  FormEvent,
  Fragment,
  KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
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
};

type ReferenceAnswerResponse = {
  answer: string;
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
  msUntilDue: number;
  status: "now" | "scheduled";
  reviewHistory: ReviewHistoryEntry[];
  lastScore: number | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  referenceAnswer: string | null;
  lastJustification: string | null;
};

type ReviewHistoryEntry = {
  ts: number;
  score: number;
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
  timeLabel: string;
};

type ActiveTab = "review" | "queue";

type QuestionStats = {
  question: string;
  reviewHistory: ReviewHistoryEntry[];
  attempts: number;
  averageScore: number | null;
  bestScore: number | null;
  lastScore: number | null;
  lastReviewedAt: number | null;
  nextDue: number | null;
  msUntilDue: number | null;
  dueStatus: "now" | "scheduled" | "unknown";
  pendingCount: number;
  referenceAnswer: string | null;
  lastJustification: string | null;
};

type MathParseResult = {
  content: string;
  nextIndex: number;
};

const COLLAPSED_PREVIOUS_ANSWER_LIMIT = 2;
const EXPANDED_PREVIOUS_ANSWER_LIMIT = 24;

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
    return "pending";
  }

  if (score <= 3) {
    return "low";
  }

  if (score <= 7) {
    return "medium";
  }

  return "high";
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

function formatNextDue(stats: QuestionStats): string {
  if (stats.nextDue === null || stats.msUntilDue === null) {
    return "Unknown";
  }

  if (stats.msUntilDue <= 0) {
    return "Due now";
  }

  return `In ${formatDurationBadge(stats.msUntilDue)}`;
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
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  );
}

export default function Home() {
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [queueRemaining, setQueueRemaining] = useState(0);
  const [evaluations, setEvaluations] = useState<EvaluationQueueItem[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>("review");
  const [referenceAnswers, setReferenceAnswers] = useState<
    Record<string, ReferenceAnswerState>
  >({});
  const [isPreviousExpanded, setIsPreviousExpanded] = useState(false);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [isLoadingQuestion, setIsLoadingQuestion] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const loadNextQuestion = useCallback(async () => {
    setIsLoadingQuestion(true);
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
      setQueueRemaining(data.queueRemaining);

      if (data.question) {
        appendQuestion(data.question);
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load the next question.",
      );
    } finally {
      setIsLoadingQuestion(false);
    }
  }, [appendQuestion]);

  const applyQueueStatus = useCallback((data: QueueStatusResponse) => {
    setQueueRemaining(data.queueRemaining);
    setEvaluations(data.evaluations);
    setReviewQueue(data.reviewQueue);
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
    void loadNextQuestion();
  }, [loadNextQuestion]);

  useEffect(() => {
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

  const submit = useCallback(async () => {
    if (!question || isSubmitting) {
      return;
    }

    const submittedQuestion = question;
    const submittedAnswer = answer.trim();

    setIsSubmitting(true);
    setAnswer("");
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
          status: "grading",
          score: null,
          justification: null,
          answerSummary: null,
          nextDue: null,
          resolvedAt: null,
        },
      ]);

      await loadNextQuestion();
    } catch (submitError) {
      setQuestion(submittedQuestion);
      setAnswer(submittedAnswer);
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to submit the answer.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [answer, isSubmitting, loadNextQuestion, question]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

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

  const sessionPreviousAnswers: PreviousAnswerItem[] = messages
    .filter(
      (message): message is Extract<ChatMessage, { kind: "answer" }> =>
        message.kind === "answer",
    )
    .slice()
    .reverse()
    .map((message) => ({
      id: message.id,
      question: message.question,
      answer: message.answerSummary ?? message.answer,
      status: message.status,
      score: message.score,
      justification: message.justification,
      timeLabel: message.status === "grading" ? "Just now" : "2d ago",
    }));

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
    .map((item) => ({
      id: `history-${item.question}`,
      question: item.question,
      answer: item.lastAnswerSummary ?? item.lastAnswer,
      status: "resolved",
      score: item.lastScore,
      justification:
        item.lastJustification ??
        "Covers the core idea; a few details could be sharper.",
      timeLabel: "2d ago",
    }));

  const previousAnswers = [
    ...sessionPreviousAnswers,
    ...historicalPreviousAnswers,
  ];
  const visiblePreviousAnswers = isPreviousExpanded
    ? previousAnswers
    : previousAnswers.slice(0, COLLAPSED_PREVIOUS_ANSWER_LIMIT);
  const hiddenPreviousAnswerCount =
    previousAnswers.length - visiblePreviousAnswers.length;
  const hasHiddenPreviousAnswers = hiddenPreviousAnswerCount > 0;
  const previousAnswerPlaceholderCount = isPreviousExpanded
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

    return {
      question: selectedQuestion,
      reviewHistory,
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
      referenceAnswer: queueItem?.referenceAnswer ?? null,
      lastJustification:
        queueItem?.lastJustification ??
        latestResolvedEvaluation?.justification ??
        null,
    };
  }, [evaluations, reviewQueue, selectedQuestion]);

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
            <p className="reader-brand">waxon</p>
            <div className="reader-tabs" role="tablist" aria-label="Review views">
              <button
                className={`reader-tab ${
                  activeTab === "review" ? "reader-tab-active" : ""
                }`}
                type="button"
                role="tab"
                id="review-tab"
                aria-selected={activeTab === "review"}
                aria-controls="review-panel"
                onClick={() => setActiveTab("review")}
              >
                Review
              </button>
              <button
                className={`reader-tab ${
                  activeTab === "queue" ? "reader-tab-active" : ""
                }`}
                type="button"
                role="tab"
                id="queue-tab"
                aria-selected={activeTab === "queue"}
                aria-controls="queue-panel"
                onClick={() => setActiveTab("queue")}
              >
                Queue
              </button>
            </div>
          </div>

          <div className="reader-actions">
            <span className="queue-summary">
              {queueRemaining} due
            </span>
          </div>
        </header>

        <div
          className="review-stage"
          hidden={activeTab !== "review"}
          id="review-panel"
          role="tabpanel"
          aria-labelledby="review-tab"
        >
          <section className="question-area" aria-live="polite">
            <div className="question-copy">
              {isLoadingQuestion ? (
                <h2 className="question-title">Loading next question...</h2>
              ) : question ? (
                <MarkdownInline
                  as="h2"
                  className="question-title"
                  text={question}
                />
              ) : (
                <h2 className="question-title">No questions due right now.</h2>
              )}
            </div>
          </section>

          <form className="composer" onSubmit={handleSubmit}>
            <div className="composer-row">
              <textarea
                id="answer-input"
                className="composer-input"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={handleAnswerKeyDown}
                placeholder="Your answer"
                aria-label="Your answer"
                rows={4}
                autoFocus
                disabled={isSubmitting || !question}
              />
              <button
                className="composer-submit"
                type="submit"
                disabled={isSubmitting || !question}
                aria-label="Submit answer"
              >
                <SubmitIcon />
              </button>
            </div>
          </form>

          {error ? <p className="error-message">{error}</p> : null}

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
              {visiblePreviousAnswers.map((item) => {
                const isPending = item.status === "grading";

                return (
                  <li
                    className={`previous-row ${
                      isPending
                        ? "previous-row-pending"
                        : "previous-row-resolved"
                    }`}
                    key={item.id}
                  >
                    <button
                      className="previous-row-main-button"
                      type="button"
                      onClick={() => setSelectedQuestion(item.question)}
                      aria-label={`Show stats for ${item.question}`}
                    >
                      <div className="previous-score-slot" aria-hidden="true">
                        {isPending ? (
                          <span className="pending-spinner" />
                        ) : (
                          <span
                            className={`previous-score score-${scoreTone(
                              item.score,
                            )}`}
                          >
                            {item.score}
                          </span>
                        )}
                      </div>

                      <div className="previous-copy">
                        {item.answer ? (
                          <p className="previous-answer">
                            <span>Your answer</span>
                            {" "}
                            {item.answer}
                          </p>
                        ) : null}
                        {isPending ? (
                          <p className="previous-summary">
                            Evaluating in background...
                          </p>
                        ) : (
                          <MarkdownContent
                            className="previous-summary"
                            text={item.justification ?? "No feedback returned."}
                          />
                        )}
                      </div>

                      <time className="previous-time">{item.timeLabel}</time>
                    </button>
                  </li>
                );
              })}

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
          {reviewQueue.length === 0 ? (
            <p className="queue-empty">No active cards.</p>
          ) : (
            <ol className="queue-list">
              {reviewQueue.map((item) => (
                <li
                  className="queue-row"
                  key={`${item.question}-${item.nextDue}`}
                >
                  <button
                    className="queue-row-button"
                    type="button"
                    onClick={() => setSelectedQuestion(item.question)}
                    aria-label={`Show stats for ${item.question}`}
                  >
                    <div className="queue-row-main">
                      <MarkdownInline
                        as="p"
                        className="queue-question"
                        text={item.question}
                      />
                      <div className="queue-metrics" aria-label="Card metrics">
                        <span
                          className={`due-badge ${
                            item.status === "now" ? "now" : "scheduled"
                          }`}
                        >
                          {formatDueBadge(item)}
                        </span>
                        {item.lastScore !== null ? (
                          <span className="queue-last-score">
                            Last score {item.lastScore}/10
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {item.lastJustification ? (
                      <p className="queue-justification">
                        {item.lastJustification}
                      </p>
                    ) : null}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </section>

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
                <h3>History</h3>
                <span>{selectedQuestionStats.dueStatus}</span>
              </div>
              {selectedQuestionStats.reviewHistory.length === 0 ? (
                <p className="stats-empty">No scored reviews yet.</p>
              ) : (
                <ol className="stats-history-list">
                  {selectedQuestionStats.reviewHistory
                    .slice()
                    .reverse()
                    .map((entry) => (
                      <li key={`${entry.ts}-${entry.score}`}>
                        <span>{formatReviewDate(entry.ts)}</span>
                        <strong>{entry.score}/10</strong>
                      </li>
                    ))}
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
