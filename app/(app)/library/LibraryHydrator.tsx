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

export function LibraryHydrator(initialProps: LibraryPageClientProps) {
  const [LibraryPageClient, setLibraryPageClient] =
    useState<LibraryPageClientComponent | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);
  const [hydrationProps] =
    useState<LibraryPageClientProps | null>(initialProps);

  useEffect(() => {
    let isCancelled = false;

    const loadLibraryApp = () => {
      if (isCancelled || LibraryPageClient) {
        return;
      }

      void Promise.all([
        import("./LibraryPageClient"),
        import("@/app/AuthenticatedProviders"),
      ]).then(([libraryModule, providerModule]) => {
        if (!isCancelled) {
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

    loadLibraryApp();

    return () => {
      isCancelled = true;
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
