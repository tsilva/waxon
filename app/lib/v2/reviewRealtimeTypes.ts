import type { SealedLiveQuery } from "@neon/realtime/client";

// Signals deliberately exclude prompts, answers, feedback and model diagnostics.
export type ReviewRealtimeRow = { revision: string };

export type ReviewRealtimeBundle = {
  url: string;
  query: SealedLiveQuery<ReviewRealtimeRow>;
};
