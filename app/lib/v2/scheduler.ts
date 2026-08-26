import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type Card,
  type Grade,
} from "ts-fsrs";
import type { V2Grade } from "./types.ts";

export const SCHEDULER_VERSION = "fsrs-6-waxon-v2";
const ALGORITHM_REQUEST_RETENTION = 0.9;

export type StoredMemoryState = {
  dueAt: Date;
  lastReviewAt: Date | null;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: number;
  learningSteps: number;
};

function toRating(value: V2Grade): Grade {
  switch (value) {
    case "again":
      return Rating.Again;
    case "hard":
      return Rating.Hard;
    case "good":
      return Rating.Good;
    case "easy":
      return Rating.Easy;
  }
}

function toCard(memory: StoredMemoryState | null, now: Date): Card {
  if (!memory) {
    return createEmptyCard(now);
  }

  return {
    due: memory.dueAt,
    stability: memory.stability,
    difficulty: memory.difficulty,
    elapsed_days: memory.elapsedDays,
    scheduled_days: memory.scheduledDays,
    learning_steps: memory.learningSteps,
    reps: memory.reps,
    lapses: memory.lapses,
    state: Math.max(State.New, Math.min(State.Relearning, memory.state)) as State,
    last_review: memory.lastReviewAt ?? undefined,
  };
}

export function applyFsrsGrade(input: {
  memory: StoredMemoryState | null;
  grade: V2Grade;
  now?: Date;
}): StoredMemoryState {
  const now = input.now ?? new Date();
  const scheduler = fsrs({
    request_retention: ALGORITHM_REQUEST_RETENTION,
    maximum_interval: 36_500,
    enable_fuzz: false,
    enable_short_term: false,
  });
  const result = scheduler.next(toCard(input.memory, now), now, toRating(input.grade));

  return {
    dueAt: result.card.due,
    lastReviewAt: result.card.last_review ?? now,
    stability: result.card.stability,
    difficulty: result.card.difficulty,
    elapsedDays: result.card.elapsed_days,
    scheduledDays: result.card.scheduled_days,
    reps: result.card.reps,
    lapses: result.card.lapses,
    state: result.card.state,
    learningSteps: result.card.learning_steps,
  };
}

export function scoreToGrade(score: number): V2Grade {
  if (score <= 3) {
    return "again";
  }
  if (score <= 6) {
    return "hard";
  }
  if (score <= 8) {
    return "good";
  }
  return "easy";
}
