import {
  queueStatus,
  RESOLVED_JUDGING_VISIBLE_MS,
  subscribeQueueStatus,
  type QueueStatusSnapshot,
} from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function encodeStatusEvent(status: QueueStatusSnapshot): Uint8Array {
  return encoder.encode(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
}

function nextRefreshDelay(status: QueueStatusSnapshot): number | null {
  const now = Date.now();
  const delays = [
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

        const status = await queueStatus();
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

      unsubscribe = subscribeQueueStatus(emitStatus);
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
