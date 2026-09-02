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

  const readAdminTraces = useCallback(() => adminTracesRef.current, []);
  const writeAdminTraces = useCallback((interactions: LlmTraceInteraction[]) => {
    adminTracesRef.current = interactions;
  }, []);
  const readAdminView = useCallback(() => adminViewRef.current, []);
  const writeAdminView = useCallback((view: AdminCachedViewState) => {
    adminViewRef.current = view;
  }, []);
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

  const refreshAdminTraces = useCallback(async () => {
    if (adminRequestRef.current) return adminRequestRef.current;

    const request = getJson<{ interactions: LlmTraceInteraction[] }>(
      "/api/admin/traces",
    )
      .then((data) => {
        if (!Array.isArray(data.interactions)) {
          throw new Error("Admin traces response was malformed.");
        }

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
