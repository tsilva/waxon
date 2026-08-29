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

export type LibraryViewState = {
  filter: V2QuestionLifecycle | "all";
  search: string;
};

type ReviewSelection = {
  questionId?: string | null;
  afterQuestionId?: string | null;
};

type AppViewCacheValue = {
  readLibrary: (view?: LibraryViewState) => V2LibraryResponse | null;
  readLibraryView: () => LibraryViewState;
  readReview: () => V2ReviewQueueResponse | null;
  readReviewDraft: (questionId: string | null | undefined) => string;
  refreshLibrary: (view?: LibraryViewState) => Promise<V2LibraryResponse>;
  refreshReview: (
    selection?: ReviewSelection,
  ) => Promise<V2ReviewQueueResponse>;
  preloadLibrary: () => Promise<void>;
  preloadReview: () => Promise<void>;
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
};

const AppViewCacheContext = createContext<AppViewCacheValue | null>(null);

function libraryUrl(view: LibraryViewState): string {
  const params = new URLSearchParams();
  if (view.filter !== "all") params.set("lifecycle", view.filter);
  if (view.search.trim()) params.set("search", view.search.trim());
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
  const reviewRef = useRef<V2ReviewQueueResponse | null>(null);
  const reviewDraftRef = useRef({ questionId: null as string | null, draft: "" });
  const libraryViewRef = useRef<LibraryViewState>(DEFAULT_LIBRARY_VIEW);
  const libraryRef = useRef(new Map<string, V2LibraryResponse>());
  const reviewRequestsRef = useRef(
    new Map<string, Promise<V2ReviewQueueResponse>>(),
  );
  const libraryRequestsRef = useRef(
    new Map<string, Promise<V2LibraryResponse>>(),
  );

  const readReview = useCallback(() => reviewRef.current, []);
  const writeReview = useCallback((data: V2ReviewQueueResponse) => {
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
    return libraryRef.current.get(libraryUrl(view)) ?? null;
  }, []);
  const writeLibrary = useCallback(
    (view: LibraryViewState, data: V2LibraryResponse) => {
      libraryRef.current.set(libraryUrl(view), data);
    },
    [],
  );

  const refreshReview = useCallback(async (selection: ReviewSelection = {}) => {
    const url = reviewUrl(selection);
    const existing = reviewRequestsRef.current.get(url);
    if (existing) return existing;

    const request = getJson<V2ReviewQueueResponse>(url)
      .then((data) => {
        reviewRef.current = data;
        return data;
      })
      .finally(() => reviewRequestsRef.current.delete(url));
    reviewRequestsRef.current.set(url, request);
    return request;
  }, []);

  const refreshLibrary = useCallback(async (view = libraryViewRef.current) => {
    const url = libraryUrl(view);
    const existing = libraryRequestsRef.current.get(url);
    if (existing) return existing;

    const request = getJson<V2LibraryResponse>(url)
      .then((data) => {
        libraryRef.current.set(url, data);
        return data;
      })
      .finally(() => libraryRequestsRef.current.delete(url));
    libraryRequestsRef.current.set(url, request);
    return request;
  }, []);

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
      preloadLibrary,
      preloadReview,
      readLibrary,
      readLibraryView,
      readReview,
      readReviewDraft,
      refreshLibrary,
      refreshReview,
      writeLibrary,
      writeLibraryView,
      writeReview,
      writeReviewDraft,
    }),
    [
      preloadLibrary,
      preloadReview,
      readLibrary,
      readLibraryView,
      readReview,
      readReviewDraft,
      refreshLibrary,
      refreshReview,
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
