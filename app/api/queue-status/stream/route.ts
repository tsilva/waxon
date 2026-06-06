import {
  queueStatus,
  RESOLVED_JUDGING_VISIBLE_MS,
  subscribeQueueStatus,
} from "@/app/lib/reviewQueue";
import type { QueueStatusSnapshot } from "@/app/lib/reviewTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const GRADING_REFRESH_MS = 750;

function encodeStatusEvent(status: QueueStatusSnapshot): Uint8Array {
  return encoder.encode(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
}

function nextRefreshDelay(status: QueueStatusSnapshot): number | null {
  const now = Date.now();
  const hasGradingEvaluation = status.evaluations.some(
    (evaluation) => evaluation.status === "grading",
  );
  const delays = [
    ...(hasGradingEvaluation ? [GRADING_REFRESH_MS] : []),
    ...status.reviewQueue
      .map((item) => item.msUntilDue)
      .filter((delay) => delay > 0),
    ...status.evaluations
      .map((evaluation) =>
        evaluation.resolvedAt === null
          ? null
          : evaluation.resolvedAt + RESOLVED_JUDGING_VISIBLE_MS - now,
      )
      .filter((delay): delay is number => delay !== null && delay > 0),
  ];

  if (delays.length === 0) {
    return null;
  }

  return Math.min(Math.min(...delays) + 50, 2_147_483_647);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
  const sort = url.searchParams.get("sort");
  const deckId = url.searchParams.get("deckId")?.trim();
  const statusInput = {
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
    sortKey: sort === "creation-date" ? ("creation-date" as const) : ("review-date" as const),
    deckId: deckId || undefined,
  };
  let cancelStream = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let isClosed = false;
      let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe = () => {};

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

      const sendStatus = async () => {
        if (isClosed) {
          return;
        }

        const status = await queueStatus(statusInput);
        emitStatus(status);
      };

      const scheduleNextRefresh = (status: QueueStatusSnapshot) => {
        clearRefreshTimeout();

        const delay = nextRefreshDelay(status);

        if (delay === null) {
          return;
        }

        refreshTimeout = setTimeout(() => {
          void sendStatus();
        }, delay);
      };

      const emitStatus = (status: QueueStatusSnapshot) => {
        if (isClosed) {
          return;
        }

        enqueue(encodeStatusEvent(status));
        scheduleNextRefresh(status);
      };

      cancelStream = close;

      unsubscribe = subscribeQueueStatus(() => {
        void sendStatus();
      });
      heartbeat = setInterval(() => {
        enqueue(encoder.encode(": keepalive\n\n"));
      }, 25_000);

      request.signal.addEventListener("abort", () => {
        close();
      });

      try {
        await sendStatus();
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
