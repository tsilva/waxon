"use client";

import {
  FormEvent,
  Fragment,
  KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
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
};

type EvaluationQueueItem = {
  id: string;
  question: string;
  status: "grading" | "resolved";
  submittedAt: number;
  score: number | null;
  justification: string | null;
  resolvedAt: number | null;
  nextDue: number | null;
};

type ReviewQueueItem = {
  question: string;
  nextDue: number;
  msUntilDue: number;
  status: "now" | "scheduled";
  lastScore: number | null;
  lastJustification: string | null;
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
      nextDue: number | null;
      resolvedAt: number | null;
    };

type TranscriptItem = {
  id: string;
  question: string;
  answer: Extract<ChatMessage, { kind: "answer" }> | null;
};

type MathParseResult = {
  content: string;
  nextIndex: number;
};

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

function buildTranscriptItems(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.kind === "answer") {
      items.push({
        id: message.id,
        question: message.question,
        answer: message,
      });
      continue;
    }

    const next = messages[index + 1];

    if (next?.kind === "answer" && next.question === message.question) {
      items.push({
        id: `${message.id}-${next.id}`,
        question: message.question,
        answer: next,
      });
      index += 1;
      continue;
    }

    items.push({
      id: message.id,
      question: message.question,
      answer: null,
    });
  }

  return items;
}

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

function formatEvaluationNextDue(message: Extract<ChatMessage, { kind: "answer" }>) {
  if (message.nextDue === null || message.resolvedAt === null) {
    return null;
  }

  return formatDurationBadge(message.nextDue - message.resolvedAt);
}

function ReviewIcon({ status }: { status: "answered" | "active" }) {
  if (status === "answered") {
    return (
      <svg aria-hidden="true" viewBox="0 0 64 64">
        <circle cx="29" cy="29" r="17" />
        <path d="m41 41 11 11" />
        <path d="m18 31 7-8 7 6 9-12" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="18" />
      <circle cx="32" cy="32" r="9" />
      <path d="M32 14V7" />
      <path d="M50 32h7" />
      <path d="M32 50v7" />
      <path d="M14 32H7" />
      <path d="m39 25 9-9" />
      <path d="M44 16h5v5" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6l4 2" />
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
  const [pendingEvaluations, setPendingEvaluations] = useState(0);
  const [evaluations, setEvaluations] = useState<EvaluationQueueItem[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [isLoadingQuestion, setIsLoadingQuestion] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const answerInputRef = useRef<HTMLTextAreaElement | null>(null);

  const resizeAnswerInput = useCallback(() => {
    const input = answerInputRef.current;

    if (!input) {
      return;
    }

    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
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

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/queue-status", {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as QueueStatusResponse;
      setPendingEvaluations(data.pendingEvaluations);
      setEvaluations(data.evaluations);
      setReviewQueue(data.reviewQueue);
    } catch {
      // Status is informational; keep the review loop usable if polling fails.
    }
  }, []);

  useEffect(() => {
    void loadNextQuestion();
  }, [loadNextQuestion]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadStatus();
    }, 1200);

    return () => window.clearInterval(interval);
  }, [loadStatus]);

  useEffect(() => {
    setMessages((current) =>
      current.map((message) => {
        if (message.kind !== "answer") {
          return message;
        }

        const evaluation = evaluations.find(
          (candidate) => candidate.id === message.evaluationId,
        );

        if (!evaluation) {
          return message;
        }

        return {
          ...message,
          status: evaluation.status,
          score: evaluation.score,
          justification: evaluation.justification,
          nextDue: evaluation.nextDue,
          resolvedAt: evaluation.resolvedAt,
        };
      }),
    );
  }, [evaluations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    resizeAnswerInput();
  }, [answer, resizeAnswerInput]);

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
          nextDue: null,
          resolvedAt: null,
        },
      ]);

      await loadNextQuestion();
      void loadStatus();
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
  }, [answer, isSubmitting, loadNextQuestion, loadStatus, question]);

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

  const transcriptItems = buildTranscriptItems(messages);

  return (
    <main className="page">
      <section className="reader-panel" aria-label="Flashcard review chat">
        <button
          className="queue-button"
          type="button"
          onClick={() => setIsDebugOpen((value) => !value)}
          aria-expanded={isDebugOpen}
          aria-label={isDebugOpen ? "Toggle queues panel" : "Show queues"}
        >
          •••
        </button>

        <div className="chat-stream">
          {transcriptItems.map((item, index) => (
            <article
              className={`review-entry ${
                item.answer ? "review-entry-answered" : "review-entry-active"
              }`}
              key={item.id}
            >
              {index > 0 ? <div className="entry-divider" /> : null}
              <div className="entry-grid">
                <div className="entry-icon">
                  <ReviewIcon status={item.answer ? "answered" : "active"} />
                </div>
                <div className="entry-content">
                  <MarkdownInline
                    as="h2"
                    className="question-title"
                    text={item.question}
                  />
                  {item.answer ? (
                    <>
                      <MarkdownContent
                        className="answer-text"
                        text={item.answer.answer}
                      />
                      <div className="judgement">
                        {item.answer.status === "grading" ? (
                          <span className="judgement-pending">Judging...</span>
                        ) : (
                          <>
                            <div className="judgement-row">
                              <div className="judgement-score">
                                {item.answer.score}/10
                              </div>
                              {item.answer.justification ? (
                                <p className="judgement-text">
                                  {item.answer.justification}
                                </p>
                              ) : null}
                            </div>
                            {formatEvaluationNextDue(item.answer) ? (
                              <p className="judgement-next">
                                <ClockIcon />
                                <span>
                                  Next review in{" "}
                                  {formatEvaluationNextDue(item.answer)}
                                </span>
                              </p>
                            ) : null}
                          </>
                        )}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </article>
          ))}

          {!isLoadingQuestion && !question ? (
            <article className="review-entry review-entry-active">
              {transcriptItems.length > 0 ? (
                <div className="entry-divider" />
              ) : null}
              <div className="entry-grid">
                <div className="entry-icon">
                  <ReviewIcon status="active" />
                </div>
                <div className="entry-content">
                  <h2 className="question-title">No questions due right now.</h2>
                </div>
              </div>
            </article>
          ) : null}

          {error ? (
            <article className="review-entry error-message">{error}</article>
          ) : null}

          <div ref={bottomRef} />
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            ref={answerInputRef}
            className="composer-input"
            value={answer}
            onChange={(event) => {
              setAnswer(event.target.value);
              window.requestAnimationFrame(resizeAnswerInput);
            }}
            onKeyDown={handleAnswerKeyDown}
            placeholder="Type your answer"
            aria-label="Answer"
            rows={1}
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
        </form>
      </section>

      <aside
        className={`debug-panel ${isDebugOpen ? "open" : ""}`}
        aria-label="Queue panel"
        aria-hidden={!isDebugOpen}
      >
        <button
          className="debug-close"
          type="button"
          onClick={() => setIsDebugOpen(false)}
          aria-label="Hide queues"
          tabIndex={isDebugOpen ? 0 : -1}
        >
          ×
        </button>

        <div className="debug-content">
          <section className="debug-section first" aria-label="Active review queue">
            <div className="sidebar-header">
              <h2>Active review queue</h2>
              <span>{reviewQueue.length} cards</span>
            </div>
            {reviewQueue.length === 0 ? (
              <p className="sidebar-empty">No active cards.</p>
            ) : (
              <ol className="debug-list">
                {reviewQueue.map((item) => (
                  <li
                    className="debug-row"
                    key={`${item.question}-${item.nextDue}`}
                  >
                    <div className="debug-row-top">
                      <span
                        className={`due-badge ${
                          item.status === "now" ? "now" : "scheduled"
                        }`}
                      >
                        {formatDueBadge(item)}
                      </span>
                    </div>
                    <MarkdownInline
                      as="p"
                      className="debug-question"
                      text={item.question}
                    />
                    {item.lastScore !== null ? (
                      <div className="review-meta">
                        <span>Last score</span>
                        <strong>{item.lastScore}/10</strong>
                      </div>
                    ) : null}
                    {item.lastJustification ? (
                      <p className="debug-justification">
                        {item.lastJustification}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="debug-section" aria-label="Pending grading">
            <div className="sidebar-header">
              <h2>Pending grading</h2>
              <span>{pendingEvaluations} active</span>
            </div>
            <p className="sidebar-empty">
              Judgements appear inline in the chat transcript.
            </p>
          </section>
        </div>
      </aside>
    </main>
  );
}
