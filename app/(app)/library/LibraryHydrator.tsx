"use client";

import { useEffect, useState } from "react";
import type { ConceptTagSummary } from "@/app/lib/conceptTags";
import type { QuestionBankPage } from "@/app/lib/questionBank";

type UserProfile = {
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type LibraryPageClientProps = {
  initialQuestionBank?: QuestionBankPage | null;
  initialConceptTags?: ConceptTagSummary[] | null;
  initialUser?: UserProfile | null;
  showAdmin?: boolean;
};

type LibraryPageClientComponent = (props: LibraryPageClientProps) => React.ReactElement;
type AuthenticatedProvidersComponent = (props: {
  children: React.ReactNode;
}) => React.ReactElement;

async function loadLibraryHydrationProps(): Promise<LibraryPageClientProps> {
  const [questionBankResult, conceptTagsResult, userResult] =
    await Promise.allSettled([
      fetch("/api/question-bank?limit=50&offset=0", { cache: "no-store" }),
      fetch("/api/concept-tags", { cache: "no-store" }),
      fetch("/api/user", { cache: "no-store" }),
    ]);

  const initialQuestionBank =
    questionBankResult.status === "fulfilled" && questionBankResult.value.ok
      ? ((await questionBankResult.value.json()) as QuestionBankPage)
      : null;
  const conceptTagData =
    conceptTagsResult.status === "fulfilled" && conceptTagsResult.value.ok
      ? ((await conceptTagsResult.value.json()) as {
          conceptTags?: ConceptTagSummary[];
        })
      : null;
  const initialUser =
    userResult.status === "fulfilled" && userResult.value.ok
      ? ((await userResult.value.json()) as UserProfile)
      : null;

  return {
    initialQuestionBank,
    initialConceptTags: conceptTagData?.conceptTags ?? null,
    initialUser,
  };
}

export function LibraryHydrator() {
  const [LibraryPageClient, setLibraryPageClient] =
    useState<LibraryPageClientComponent | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);
  const [hydrationProps, setHydrationProps] =
    useState<LibraryPageClientProps | null>(null);

  useEffect(() => {
    let isCancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const loadLibraryApp = () => {
      if (isCancelled || LibraryPageClient) {
        return;
      }

      void Promise.all([
        import("./LibraryPageClient"),
        import("@/app/AuthenticatedProviders"),
        loadLibraryHydrationProps(),
      ]).then(([libraryModule, providerModule, nextProps]) => {
        if (!isCancelled) {
          setHydrationProps(nextProps);
          setAuthenticatedProviders(
            () =>
              providerModule.AuthenticatedProviders as AuthenticatedProvidersComponent,
          );
          setLibraryPageClient(
            () => libraryModule.default as LibraryPageClientComponent,
          );
        }
      });
    };

    const loadOnInteraction = () => loadLibraryApp();

    window.addEventListener("pointerdown", loadOnInteraction, { once: true });
    window.addEventListener("keydown", loadOnInteraction, { once: true });
    timeoutId = globalThis.setTimeout(loadLibraryApp, 4500);

    return () => {
      isCancelled = true;
      window.removeEventListener("pointerdown", loadOnInteraction);
      window.removeEventListener("keydown", loadOnInteraction);

      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
    };
  }, [LibraryPageClient]);

  useEffect(() => {
    if (!LibraryPageClient) {
      return;
    }

    const staticView = document.querySelector("[data-library-static]");
    staticView?.setAttribute("inert", "");
  }, [LibraryPageClient]);

  if (!LibraryPageClient || !AuthenticatedProviders || !hydrationProps) {
    return null;
  }

  return (
    <>
      <style>{`[data-library-static]{display:none}`}</style>
      <AuthenticatedProviders>
        <LibraryPageClient {...hydrationProps} />
      </AuthenticatedProviders>
    </>
  );
}
