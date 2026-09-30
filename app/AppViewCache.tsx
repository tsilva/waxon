"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  V2LibraryResponse,
  V2QuestionLifecycle,
  V2ReviewQueueResponse,
} from "@/app/lib/v2/types";
import type { LlmTraceInteraction } from "@/app/lib/llmTraceStore";
import type { AdminCachedViewState } from "@/app/(app)/admin/adminViewStateCookie";

export type LibraryViewState = {
  filter: V2QuestionLifecycle | "all";
  search: string;
  tagIds: string[];
};

type ReviewSelection = {
  questionId?: string | null;
  afterQuestionId?: string | null;
};

type AppViewCacheValue = {
  invalidateLearningViews: () => void;
  readAdminCursor: () => string | null;
  readAdminTraces: () => LlmTraceInteraction[] | null;
  readAdminView: () => AdminCachedViewState | null;
  readLibrary: (view?: LibraryViewState) => V2LibraryResponse | null;
  readLibraryView: () => LibraryViewState;
  readReview: () => V2ReviewQueueResponse | null;
  readReviewDraft: (questionId: string | null | undefined) => string;
  refreshLibrary: (view?: LibraryViewState) => Promise<V2LibraryResponse>;
  refreshAdminTraces: () => Promise<LlmTraceInteraction[]>;
  refreshReview: (
    selection?: ReviewSelection,
  ) => Promise<V2ReviewQueueResponse>;
  preloadAdmin: () => Promise<void>;
  preloadLibrary: () => Promise<void>;
  preloadReview: () => Promise<void>;
  writeAdminTraces: (interactions: LlmTraceInteraction[]) => void;
  writeAdminView: (view: AdminCachedViewState) => void;
  writeLibrary: (view: LibraryViewState, data: V2LibraryResponse) => void;
  writeLibraryView: (view: LibraryViewState) => void;
  writeReview: (data: V2ReviewQueueResponse) => void;
  writeReviewDraft: (
    questionId: string | null | undefined,
    draft: string,
  ) => void;
};

const DEFAULT_LIBRARY_VIEW: LibraryViewState = {
  filter: "all",
  search: "",
  tagIds: [],
};

const AppViewCacheContext = createContext<AppViewCacheValue | null>(null);

function libraryUrl(view: LibraryViewState): string {
  const params = new URLSearchParams();
  if (view.filter !== "all") params.set("lifecycle", view.filter);
  if (view.search.trim()) params.set("search", view.search.trim());
  for (const tagId of view.tagIds) params.append("tag", tagId);
  const query = params.toString();
  return `/api/v2/library${query ? `?${query}` : ""}`;
}

function reviewUrl(selection: ReviewSelection): string {
  const params = new URLSearchParams();
  if (selection.questionId) params.set("questionId", selection.questionId);
  if (selection.afterQuestionId) {
    params.set("afterQuestionId", selection.afterQuestionId);
  }
  const query = params.toString();
  return `/api/v2/review/queue${query ? `?${query}` : ""}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "Waxon could not refresh this view.");
  }
  return body as T;
}

export function AppViewCacheProvider({ children }: { children: ReactNode }) {
  const adminCursorRef = useRef<string | null>(null);
  const reviewVersionRef = useRef(0);
  const libraryVersionRef = useRef(0);
  const reviewUpdatedRef = useRef(0);
  const libraryUpdatedRef = useRef(new Map<string, number>());
  const adminTracesRef = useRef<LlmTraceInteraction[] | null>(null);
  const adminViewRef = useRef<AdminCachedViewState | null>(null);
  const reviewRef = useRef<V2ReviewQueueResponse | null>(null);
  const reviewDraftRef = useRef({ questionId: null as string | null, draft: "" });
  const libraryViewRef = useRef<LibraryViewState>(DEFAULT_LIBRARY_VIEW);
  const libraryRef = useRef(new Map<string, V2LibraryResponse>());
  const adminRequestRef = useRef<Promise<LlmTraceInteraction[]> | null>(null);
  const reviewRequestsRef = useRef(
    new Map<string, Promise<V2ReviewQueueResponse>>(),
  );
  const libraryRequestsRef = useRef(
    new Map<string, Promise<V2LibraryResponse>>(),
  );

  const invalidateLearningViews = useCallback(() => {
    ++reviewVersionRef.current; ++libraryVersionRef.current;
    reviewRef.current = null; libraryRef.current.clear(); libraryUpdatedRef.current.clear();
    reviewRequestsRef.current.clear(); libraryRequestsRef.current.clear();
  }, []);
  const readAdminCursor = useCallback(() => adminCursorRef.current, []);
  const readAdminTraces = useCallback(() => adminTracesRef.current, []);
  const writeAdminTraces = useCallback((interactions: LlmTraceInteraction[]) => {
    adminTracesRef.current = interactions;
  }, []);
  const readAdminView = useCallback(() => adminViewRef.current, []);
  const writeAdminView = useCallback((view: AdminCachedViewState) => {
    adminViewRef.current = view;
  }, []);
  const readReview = useCallback(() => Date.now() - reviewUpdatedRef.current < 60_000 ? reviewRef.current : null, []);
  const writeReview = useCallback((data: V2ReviewQueueResponse) => {
    ++reviewVersionRef.current;
    reviewUpdatedRef.current = Date.now();
    reviewRef.current = data;
  }, []);
  const readReviewDraft = useCallback(
    (questionId: string | null | undefined) =>
      questionId && reviewDraftRef.current.questionId === questionId
        ? reviewDraftRef.current.draft
        : "",
    [],
  );
  const writeReviewDraft = useCallback(
    (questionId: string | null | undefined, draft: string) => {
      reviewDraftRef.current = { questionId: questionId ?? null, draft };
    },
    [],
  );
  const readLibraryView = useCallback(() => libraryViewRef.current, []);
  const writeLibraryView = useCallback((view: LibraryViewState) => {
    libraryViewRef.current = view;
  }, []);
  const readLibrary = useCallback((view = libraryViewRef.current) => {
    const url = libraryUrl(view);
    return Date.now() - (libraryUpdatedRef.current.get(url) ?? 0) < 60_000
      ? libraryRef.current.get(url) ?? null : null;
  }, []);
  const writeLibrary = useCallback(
    (view: LibraryViewState, data: V2LibraryResponse) => {
      ++libraryVersionRef.current;
      ++reviewVersionRef.current; reviewRef.current = null;
      libraryRef.current.clear();
      libraryUpdatedRef.current.clear();
      libraryRef.current.set(libraryUrl(view), data);
      libraryUpdatedRef.current.set(libraryUrl(view), Date.now());
    },
    [],
  );

  const refreshAdminTraces = useCallback(async () => {
    if (adminRequestRef.current) return adminRequestRef.current;

    const request = getJson<{ interactions: LlmTraceInteraction[]; nextCursor?: string | null }>(
      "/api/admin/traces",
    )
      .then((data) => {
        if (!Array.isArray(data.interactions)) {
          throw new Error("Admin traces response was malformed.");
        }

        adminCursorRef.current = data.nextCursor ?? null;
        adminTracesRef.current = data.interactions;
        return data.interactions;
      })
      .finally(() => {
        adminRequestRef.current = null;
      });
    adminRequestRef.current = request;
    return request;
  }, []);

  const refreshReview = useCallback(async (selection: ReviewSelection = {}) => {
    const url = reviewUrl(selection);
    const existing = reviewRequestsRef.current.get(url);
    if (existing) return existing;

    const version = ++reviewVersionRef.current;
    const request = getJson<V2ReviewQueueResponse>(url)
      .then((data) => {
        if (reviewVersionRef.current === version) {
          reviewRef.current = data; reviewUpdatedRef.current = Date.now();
        }
        return data;
      })
      .finally(() => { if (reviewRequestsRef.current.get(url) === request) reviewRequestsRef.current.delete(url); });
    reviewRequestsRef.current.set(url, request);
    return request;
  }, []);

  const refreshLibrary = useCallback(async (view = libraryViewRef.current) => {
    const url = libraryUrl(view);
    const existing = libraryRequestsRef.current.get(url);
    if (existing) return existing;

    const version = libraryVersionRef.current;
    const request = getJson<V2LibraryResponse>(url)
      .then((data) => {
        if (libraryVersionRef.current === version) {
          libraryRef.current.set(url, data); libraryUpdatedRef.current.set(url, Date.now());
          while (libraryRef.current.size > 20) {
            const oldest = libraryRef.current.keys().next().value!;
            libraryRef.current.delete(oldest); libraryUpdatedRef.current.delete(oldest);
          }
        }
        return data;
      })
      .finally(() => { if (libraryRequestsRef.current.get(url) === request) libraryRequestsRef.current.delete(url); });
    libraryRequestsRef.current.set(url, request);
    return request;
  }, []);

  const preloadAdmin = useCallback(async () => {
    try {
      await refreshAdminTraces();
    } catch {
      // Preloading is opportunistic; the Admin view reports refresh failures.
    }
  }, [refreshAdminTraces]);

  const preloadReview = useCallback(async () => {
    try {
      await refreshReview({
        questionId: reviewRef.current?.question?.questionId,
      });
    } catch {
      // Preloading is opportunistic; the Review view reports refresh failures.
    }
  }, [refreshReview]);

  const preloadLibrary = useCallback(async () => {
    try {
      await refreshLibrary(libraryViewRef.current);
    } catch {
      // Preloading is opportunistic; the Library view reports refresh failures.
    }
  }, [refreshLibrary]);

  const value = useMemo<AppViewCacheValue>(
    () => ({
      invalidateLearningViews,
      readAdminCursor,
      preloadAdmin,
      preloadLibrary,
      preloadReview,
      readAdminTraces,
      readAdminView,
      readLibrary,
      readLibraryView,
      readReview,
      readReviewDraft,
      refreshAdminTraces,
      refreshLibrary,
      refreshReview,
      writeAdminTraces,
      writeAdminView,
      writeLibrary,
      writeLibraryView,
      writeReview,
      writeReviewDraft,
    }),
    [
      invalidateLearningViews,
      readAdminCursor,
      preloadAdmin,
      preloadLibrary,
      preloadReview,
      readAdminTraces,
      readAdminView,
      readLibrary,
      readLibraryView,
      readReview,
      readReviewDraft,
      refreshAdminTraces,
      refreshLibrary,
      refreshReview,
      writeAdminTraces,
      writeAdminView,
      writeLibrary,
      writeLibraryView,
      writeReview,
      writeReviewDraft,
    ],
  );

  return (
    <AppViewCacheContext.Provider value={value}>
      {children}
    </AppViewCacheContext.Provider>
  );
}

export function useAppViewCache(): AppViewCacheValue {
  const context = useContext(AppViewCacheContext);
  if (!context) {
    throw new Error("useAppViewCache must be used inside AppViewCacheProvider.");
  }
  return context;
}
