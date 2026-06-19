import {
  queueStatusForUser,
  RESOLVED_JUDGING_VISIBLE_MS,
  subscribeQueueStatus,
} from "@/app/lib/reviewQueue";
import { getCurrentUser } from "@/app/lib/auth";
import type { QueueStatusSnapshot } from "@/app/lib/reviewTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const GRADING_REFRESH_MS = 750;

type RefreshMode = "full" | "lightweight";
type ScheduledRefresh = {
  delay: number;
  mode: RefreshMode;
};

function isEnabled(value: string | null, fallback: boolean): boolean {
  if (value === null) {
    return fallback;
  }

  return value !== "0" && value !== "false";
}

function encodeStatusEvent(status: QueueStatusSnapshot): Uint8Array {
  return encoder.encode(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
}

function nextRefresh(status: QueueStatusSnapshot): ScheduledRefresh | null {
  const now = Date.now();
  const hasGradingEvaluation = status.evaluations.some(
    (evaluation) => evaluation.status === "grading",
  );
  const refreshes: ScheduledRefresh[] = [];

  if (hasGradingEvaluation) {
    refreshes.push({ delay: GRADING_REFRESH_MS, mode: "lightweight" });
  }

  if (status.nextScheduledDue !== null && status.nextScheduledDue > now) {
    refreshes.push({
      delay: status.nextScheduledDue - now,
      mode: "full",
    });
  }

  for (const item of status.reviewQueue) {
    if (item.msUntilDue > 0) {
      refreshes.push({ delay: item.msUntilDue, mode: "full" });
    }
  }

  for (const evaluation of status.evaluations) {
    if (evaluation.resolvedAt === null) {
      continue;
    }

    const delay = evaluation.resolvedAt + RESOLVED_JUDGING_VISIBLE_MS - now;

    if (delay > 0) {
      refreshes.push({ delay, mode: "lightweight" });
    }
  }

  if (refreshes.length === 0) {
    return null;
  }

  const [next] = refreshes.sort(
    (left, right) => {
      if (left.delay !== right.delay) {
        return left.delay - right.delay;
      }

      if (left.mode === right.mode) {
        return 0;
      }

      return left.mode === "full" ? -1 : 1;
    },
  );

  if (!next) {
    return null;
  }

  return {
    delay: Math.min(next.delay + 50, 2_147_483_647),
    mode: next.mode,
  };
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
  const sort = url.searchParams.get("sort");
  const mode = url.searchParams.get("mode");
  const query = url.searchParams.get("query")?.trim();
  const statusInput = {
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
    sortKey: sort === "creation-date" ? ("creation-date" as const) : ("review-date" as const),
    query: query || undefined,
    includeReviewQueue:
      mode === "review"
        ? false
        : isEnabled(url.searchParams.get("includeReviewQueue"), false),
    includeQuestionAttempts: isEnabled(
      url.searchParams.get("includeQuestionAttempts"),
      false,
    ),
    includeRecentAttempts: isEnabled(
      url.searchParams.get("includeRecentAttempts"),
      false,
    ),
    includeKnowledgeEmbeddingPlot: isEnabled(
      url.searchParams.get("includeKnowledgeEmbeddingPlot"),
      false,
    ),
    includeQueueCounts: isEnabled(
      url.searchParams.get("includeQueueCounts"),
      true,
    ),
  };
  let cancelStream = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let isClosed = false;
      let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe = () => {};
      let lastStatus: QueueStatusSnapshot | null = null;
      let isSendingStatus = false;
      let pendingRefreshMode: RefreshMode | null = null;

      const clearRefreshTimeout = () => {
        if (refreshTimeout !== null) {
          clearTimeout(refreshTimeout);
          refreshTimeout = null;
        }
      };

      const close = () => {
        if (isClosed) {
          return;
        }

        isClosed = true;
        clearRefreshTimeout();
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        unsubscribe();
      };

      const enqueue = (chunk: Uint8Array) => {
        if (isClosed) {
          return;
        }

        try {
          controller.enqueue(chunk);
        } catch {
          close();
        }
      };

      const preserveQueuePayload = (
        status: QueueStatusSnapshot,
      ): QueueStatusSnapshot => {
        if (!lastStatus) {
          return status;
        }

        return {
          ...status,
          queueRemaining: lastStatus.queueRemaining,
          nextScheduledDue: lastStatus.nextScheduledDue,
          recentAttempts: lastStatus.recentAttempts,
          reviewQueue: lastStatus.reviewQueue,
          reviewQueueTotal: lastStatus.reviewQueueTotal,
          reviewQueueOffset: lastStatus.reviewQueueOffset,
          reviewQueueLimit: lastStatus.reviewQueueLimit,
          reviewQueueHasMore: lastStatus.reviewQueueHasMore,
          knowledgeEmbeddingPlot: lastStatus.knowledgeEmbeddingPlot,
        };
      };

      const queueStatusInputForMode = (mode: RefreshMode) => {
        if (mode === "full" || !lastStatus) {
          return statusInput;
        }

        return {
          ...statusInput,
          includeReviewQueue: false,
          includeQuestionAttempts: false,
          includeRecentAttempts: false,
          includeKnowledgeEmbeddingPlot: false,
          includeQueueCounts: false,
        };
      };

      const sendStatus = async (mode: RefreshMode) => {
        if (isClosed) {
          return;
        }

        if (isSendingStatus) {
          pendingRefreshMode =
            pendingRefreshMode === "full" || mode === "full" ? "full" : mode;
          return;
        }

        isSendingStatus = true;

        try {
          const response = await queueStatusForUser(
            user.id,
            queueStatusInputForMode(mode),
          );
          const status =
            mode === "lightweight" && lastStatus
              ? preserveQueuePayload(response)
              : response;

          lastStatus = status;
          emitStatus(status);
        } finally {
          isSendingStatus = false;

          if (pendingRefreshMode !== null) {
            const pendingMode = pendingRefreshMode;

            pendingRefreshMode = null;
            void sendStatus(pendingMode);
          }
        }
      };

      const scheduleNextRefresh = (status: QueueStatusSnapshot) => {
        clearRefreshTimeout();

        const refresh = nextRefresh(status);

        if (refresh === null) {
          return;
        }

        refreshTimeout = setTimeout(() => {
          void sendStatus(refresh.mode);
        }, refresh.delay);
      };

      const emitStatus = (status: QueueStatusSnapshot) => {
        if (isClosed) {
          return;
        }

        enqueue(encodeStatusEvent(status));
        scheduleNextRefresh(status);
      };

      cancelStream = close;

      unsubscribe = subscribeQueueStatus(user.id, (mode) => {
        void sendStatus(mode === "evaluations" ? "lightweight" : "full");
      });
      heartbeat = setInterval(() => {
        enqueue(encoder.encode(": keepalive\n\n"));
      }, 25_000);

      request.signal.addEventListener("abort", () => {
        close();
      });

      try {
        await sendStatus("full");
      } catch {
        close();
        controller.error(new Error("Failed to stream queue status."));
      }
    },
    cancel() {
      cancelStream();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}
