import {
  createRealtimeClient,
  QueryRefreshController,
  type LiveQuerySnapshot,
  type MaterializedLiveQuerySubscription,
  type SealedLiveQuery,
} from "@neon/realtime/client";
import type { ReviewRealtimeBundle, ReviewRealtimeRow } from "./v2/reviewRealtimeTypes.ts";

type Subscription = Pick<MaterializedLiveQuerySubscription<ReviewRealtimeRow>, "onChange" | "renew" | "unsubscribe">;
type Client = { subscribe(query: SealedLiveQuery<ReviewRealtimeRow>): Subscription; close(): void };
type Options = {
  onChange(): Promise<unknown> | void;
  onError(message: string): void;
};
type Dependencies = {
  fetchBundle(signal: AbortSignal): Promise<ReviewRealtimeBundle>;
  createClient(url: string): Client;
};

async function fetchBundle(signal: AbortSignal): Promise<ReviewRealtimeBundle> {
  const response = await fetch("/api/v2/review/realtime", { cache: "no-store", signal });
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("Live update authorization ended."), { name: "ReviewAuthorizationError" });
  }
  if (!response.ok) throw new Error("Live updates are unavailable. Refocus this tab to reconnect.");
  return response.json();
}

// One connection, one scalar query, and a coalesced content refresh.
// Capability renewals perform authentication and local encryption, not Review reads.
export function watchReviewRealtime(options: Options, dependencies: Dependencies = {
  fetchBundle,
  createClient: (url) => createRealtimeClient({ url }),
}): { stop(): void; failed(): boolean } {
  const abort = new AbortController();
  let stopped = false;
  let failed = false;
  let client: Client | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight = false;
  let dirty = false;
  let pendingBundle: Promise<ReviewRealtimeBundle> | undefined;
  let renewal: QueryRefreshController<ReviewRealtimeRow> | undefined;

  const fail = () => {
    if (stopped || failed) return;
    failed = true;
    abort.abort();
    dirty = false;
    if (timer) clearTimeout(timer);
    renewal?.stop();
    client?.close();
    options.onError("Live updates are unavailable. Refocus this tab to reconnect.");
  };
  const refresh = async () => {
    timer = undefined;
    if (stopped || failed || refreshInFlight || !dirty) return;
    dirty = false;
    refreshInFlight = true;
    try {
      await options.onChange();
    } catch {
      fail();
    } finally {
      refreshInFlight = false;
      if (dirty && !stopped && !failed) timer = setTimeout(() => void refresh(), 150);
    }
  };
  const changed = () => {
    if (stopped || failed) return;
    dirty = true;
    if (!timer && !refreshInFlight) timer = setTimeout(() => void refresh(), 150);
  };
  const bundle = () => {
    // Reuse a pending authorization request.
    pendingBundle ??= dependencies.fetchBundle(abort.signal)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "ReviewAuthorizationError") fail();
        throw error;
      })
      .finally(() => { pendingBundle = undefined; });
    return pendingBundle;
  };
  void bundle().then((initial) => {
    if (stopped) return;
    client = dependencies.createClient(initial.url);
    const subscription = client.subscribe(initial.query);
    let previous: string | undefined;
    subscription.onChange((snapshot: LiveQuerySnapshot<ReviewRealtimeRow>) => {
      if (snapshot.status === "error") { fail(); return; }
      if (snapshot.status !== "live" || snapshot.data === undefined) return;
      const signature = JSON.stringify(snapshot.data);
      if (signature === previous) return;
      previous = signature;
      // The initial snapshot also closes the race between the HTTP load and
      // subscribing. Identical reconnect snapshots cause no additional read.
      changed();
    });
    renewal = new QueryRefreshController({
      query: initial.query,
      refreshQuery: async () => (await bundle()).query,
      renewSubscription: (query) => subscription.renew(query),
      onRefreshExhausted: fail,
    });
    renewal.start();
  }).catch(() => { if (!abort.signal.aborted) fail(); });

  return {
    failed: () => failed,
    stop() {
      stopped = true;
      abort.abort();
      if (timer) clearTimeout(timer);
      renewal?.stop();
      client?.close();
    },
  };
}
